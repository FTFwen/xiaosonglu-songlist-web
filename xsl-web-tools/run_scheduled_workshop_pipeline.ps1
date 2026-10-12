# Unattended runner for the workshop mirror site (Cloudflare Pages project `xsl-workshop`,
# published at https://workshop.viridis.love).
#
# Pipeline: workspace lock -> mirror sync (-Apply then -Check) -> snapshot content hash ->
# conditional `wrangler pages deploy workshop` -> online byte verification -> log + status.
#
# The daily song-list pipeline only publishes the canonical project (`xsl-songlist`), and the
# weekly schedule runner only touches the workshop project when the pinned weekly table changes.
# This runner keeps workshop.viridis.love in step with the canonical data on its own schedule.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less script with non-ASCII bytes
# using the ANSI code page and would mis-parse it.
[CmdletBinding()]
param(
    [string]$Root = '',
    [switch]$AllowOAuth,
    [switch]$Force,
    [string]$ProjectName = 'xsl-workshop',
    [string]$Directory = 'workshop',
    [string]$WranglerVersion = '4.130.0',
    [ValidateRange(1, 20)]
    [int]$DeployAttempts = 3,
    [ValidateRange(0, 600)]
    [int]$RetryBaseSeconds = 30,
    [ValidateRange(0, 3600)]
    [int]$RetryMaxSeconds = 300,
    [ValidateRange(1, 20)]
    [int]$VerifyAttempts = 6,
    [ValidateRange(0, 300)]
    [int]$VerifyDelaySeconds = 10,
    [string]$VerifyBaseUrl = 'https://workshop.viridis.love',
    [ValidateRange(0, 7200)]
    [int]$LockWaitSeconds = 1800,
    [ValidateRange(1, 90)]
    [int]$LogRetentionDays = 30
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 resolves $PSScriptRoot to an empty string inside a param() default
# expression, so the root has to be resolved here in the script body.
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path $Root).Path
Set-Location $rootPath

$directoryPath = Join-Path $rootPath $Directory
if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) { throw "Workshop directory is missing: $Directory" }

$logRoot = Join-Path $rootPath 'data\xiaosonglu\_automation_logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$startedAt = [DateTime]::UtcNow
$stamp = $startedAt.ToString('yyyyMMddTHHmmssZ')
$logPath = Join-Path $logRoot "workshop-$stamp.log"
$statusPath = Join-Path $rootPath 'data\xiaosonglu\_workshop_status.json'
$statePath = Join-Path $rootPath 'data\xiaosonglu\_workshop_deploy_state.json'
$lockPath = Join-Path $rootPath 'data\xiaosonglu\_pages_deploy.lock'

$logLines = New-Object System.Collections.Generic.List[string]
function Write-RunLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')), $Message
    $logLines.Add($line)
    Write-Host $line
}

$script:lockStream = $null
function Release-WorkshopLock {
    if ($script:lockStream) {
        $script:lockStream.Dispose()
        $script:lockStream = $null
    }
}
trap {
    Release-WorkshopLock
    throw
}

# Run a native command through cmd with file redirection: stderr never enters the PowerShell
# stream (ErrorActionPreference=Stop would turn wrangler progress output into a terminating
# error) while the exit code still comes back verbatim.
function Invoke-Captured {
    param([string]$CommandLine)
    $outFile = Join-Path $env:TEMP ("xsl-workshop-{0}.out" -f ([guid]::NewGuid().ToString('N')))
    & cmd.exe /c "$CommandLine > `"$outFile`" 2>&1"
    $text = if (Test-Path -LiteralPath $outFile) { Get-Content $outFile -Raw -Encoding UTF8 } else { '' }
    Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = [string]$text }
}

function Quote-Executable {
    param([string]$Path)
    if ($Path -match '\s') { return '"' + $Path + '"' }
    return $Path
}

function Get-WorkshopSnapshot {
    param([string]$Path)
    $lines = New-Object System.Collections.Generic.List[string]
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force | Where-Object {
        $relative = $_.FullName.Substring($Path.Length).TrimStart('\', '/')
        -not ($relative -split '[\\/]' | Where-Object { $_.StartsWith('.') })
    })
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($Path.Length).TrimStart('\', '/').Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $lines.Add("$relative`t$($file.Length)`t$hash")
    }
    $ordered = $lines.ToArray()
    [Array]::Sort($ordered, [System.StringComparer]::Ordinal)
    $payload = [Text.Encoding]::UTF8.GetBytes(($ordered -join "`n"))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha.ComputeHash($payload)
    } finally {
        $sha.Dispose()
    }
    $hex = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
    return [pscustomobject]@{ Hash = $hex; FileCount = $ordered.Count }
}

function Get-TrackedVideoOffenders {
    $staged = @(& git status --short)
    $offenders = @($staged | Where-Object { $_ -match '\.(mp4|webm|mkv|mov|flv)$' -or $_ -match '(^|/)(video|videos)/' })
    $tracked = @(& git ls-files | Where-Object {
        $_ -match '(^|/)(video|videos)/' -or $_ -match '\.(mp4|webm|mkv|mov|flv)$' -or $_ -match '(^|/)(video|videos)/.*\.ts$'
    })
    return @($offenders + $tracked)
}

function Get-RemoteSha256 {
    param([string]$Uri)
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) { throw 'curl.exe is required for bounded online verification.' }
    $temp = [IO.Path]::GetTempFileName()
    try {
        $stamp = [DateTime]::UtcNow.Ticks
        $separator = if ($Uri.Contains('?')) { '&' } else { '?' }
        $statusText = (& $curl.Source @('--fail', '--silent', '--show-error', '--location',
            '--connect-timeout', '15', '--max-time', '120', '-H', 'Cache-Control: no-cache',
            '--output', $temp, '--write-out', '%{http_code}', ($Uri + $separator + 'xsl_verify=' + $stamp)) 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $statusText -notmatch '^2\d\d$') {
            throw "public request failed (curl=$LASTEXITCODE, http=$statusText)"
        }
        return (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant()
    } finally {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    }
}

function Test-WorkshopDeployment {
    param([string]$BaseUrl, [array]$Pairs)
    try {
        $base = $BaseUrl.TrimEnd('/')
        foreach ($pair in $Pairs) {
            $actual = Get-RemoteSha256 -Uri "$base/$($pair.Public)"
            if ($actual -ne $pair.Sha256) { throw "online payload hash mismatch: $($pair.Public)" }
        }
        $curl = Get-Command curl.exe -ErrorAction Stop
        $statusText = (& $curl.Source @('--fail', '--silent', '--show-error', '--location',
            '--connect-timeout', '15', '--max-time', '60', '--output', 'NUL', '--write-out', '%{http_code}',
            "$base/?xsl_verify=$([DateTime]::UtcNow.Ticks)") 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $statusText -notmatch '^2\d\d$') {
            throw "public request failed for the site root (curl=$LASTEXITCODE, http=$statusText)"
        }
        return [ordered]@{ ok = $true; reason = $null }
    } catch {
        $reason = ([string]$_.Exception.Message) -replace 'https?://[^\s"'']+', '[url]'
        return [ordered]@{ ok = $false; reason = $reason }
    }
}

$status = 'failed'
$exitCode = 1
$errorSummary = $null
$contentChanged = $null
$contentHash = $null
$snapshotFileCount = $null
$uploadAttempts = 0
$pagesUrl = $null
$verification = $null
$pairs = @()

try {
    Write-RunLog "startedAt=$($startedAt.ToString('o'))"
    Write-RunLog "mode=scheduled-workshop-pages project=$ProjectName directory=$Directory"

    $offenders = Get-TrackedVideoOffenders
    if ($offenders.Count -gt 0) { throw "Tracked or staged video assets must never be deployed: $($offenders -join ', ')" }

    # The lock is shared with the canonical deployment so the two projects never upload at the
    # same time. Wait for it instead of skipping: the daily pipeline can hold it for a long time.
    $deadline = (Get-Date).AddSeconds($LockWaitSeconds)
    while ($true) {
        try {
            $script:lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
            break
        } catch [System.IO.IOException] {
            $remaining = [int][Math]::Floor(($deadline - (Get-Date)).TotalSeconds)
            if ($remaining -le 0) {
                $status = 'skipped-lock-held'
                $exitCode = 0
                Write-RunLog "another Pages deployment still holds the workspace lock after $LockWaitSeconds seconds; skipping this round."
                break
            }
            Write-RunLog "workspace lock is held by another deployment; waiting up to $remaining more seconds."
            Start-Sleep -Seconds ([Math]::Min(15, $remaining))
        }
    }

    if ($status -ne 'skipped-lock-held') {
        # Mirror the canonical data first so the published snapshot can never lag the sources.
        $syncScript = Join-Path $PSScriptRoot 'sync_workspace_data.ps1'
        $apply = Invoke-Captured -CommandLine (('powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File {0} -Root "{1}" -Apply' -f (Quote-Executable $syncScript), $rootPath))
        if ($apply.ExitCode -ne 0) { throw "mirror sync (-Apply) failed with exit code $($apply.ExitCode)" }
        $check = Invoke-Captured -CommandLine (('powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File {0} -Root "{1}" -Check' -f (Quote-Executable $syncScript), $rootPath))
        $checkResult = $check.Text | ConvertFrom-Json
        if (-not $checkResult.ok -or [int]$checkResult.driftCount -ne 0) {
            throw "mirror drift remains after sync: driftCount=$($checkResult.driftCount)"
        }
        foreach ($entry in $checkResult.files) {
            $destination = ([string]$entry.destination).Replace('\', '/')
            $prefix = ($Directory.Replace('\', '/')).TrimEnd('/') + '/'
            if (-not $destination.StartsWith($prefix)) { continue }
            $pairs += [pscustomobject]@{
                Public = $destination.Substring($prefix.Length)
                Sha256 = [string]$entry.destinationHash
            }
        }
        if ($pairs.Count -eq 0) { throw 'mirror check reported no published files to verify.' }

        $snapshot = Get-WorkshopSnapshot -Path $directoryPath
        $contentHash = $snapshot.Hash
        $snapshotFileCount = $snapshot.FileCount
        $previousHash = $null
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            try { $previousHash = [string](Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json).contentHash } catch { $previousHash = $null }
        }
        $contentChanged = $true
        if ($Force -or [string]::IsNullOrWhiteSpace($previousHash) -or $contentHash -ne $previousHash) {
            $contentChanged = $true
        } else {
            $contentChanged = $false
        }
        Write-RunLog "snapshot files=$snapshotFileCount contentHash=$contentHash contentChanged=$($contentChanged.ToString().ToLowerInvariant())"

        $wranglerCommand = Get-Command wrangler.cmd -ErrorAction SilentlyContinue
        if (-not $wranglerCommand) { $wranglerCommand = Get-Command wrangler -ErrorAction SilentlyContinue }
        $wranglerPrefix = @()
        if (-not $wranglerCommand) {
            $wranglerCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
            if (-not $wranglerCommand) { $wranglerCommand = Get-Command npx -ErrorAction SilentlyContinue }
            if ($wranglerCommand) { $wranglerPrefix = @('--yes', "wrangler@$WranglerVersion") }
        }

        $hasToken = -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)
        $hasAccount = -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_ACCOUNT_ID)
        $useOAuth = -not ($hasToken -and $hasAccount)
        if ($useOAuth -and -not $AllowOAuth) {
            $status = 'skipped-missing-credentials'
            $exitCode = 1
            $errorSummary = 'deployment requires -AllowOAuth when no explicit Cloudflare token pair is configured'
            Write-RunLog "ERROR: $errorSummary"
        } elseif (-not $wranglerCommand) {
            $status = 'skipped-missing-wrangler'
            $exitCode = 1
            $errorSummary = 'wrangler or npx is required for deployment'
            Write-RunLog "ERROR: $errorSummary"
        } else {
            $savedAccountId = $env:CLOUDFLARE_ACCOUNT_ID
            $savedApiToken = $env:CLOUDFLARE_API_TOKEN
            $accountWasPresent = Test-Path Env:CLOUDFLARE_ACCOUNT_ID
            $tokenWasPresent = Test-Path Env:CLOUDFLARE_API_TOKEN
            try {
                if ($useOAuth) {
                    # OAuth is an explicit preference: never let an inherited placeholder
                    # account id or a stray token redirect the upload to another account.
                    Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
                    Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
                }
                # Resolve through PATH by name (inside cmd) instead of the fully qualified path:
                # the Node.js install directory usually contains a space, and cmd /c quoting of a
                # quoted executable path is fragile.
                $deployArguments = @($wranglerCommand.Name) + $wranglerPrefix + @('pages', 'deploy', $Directory, "--project-name=$ProjectName", '--commit-dirty=true')
                $deployCommandLine = $deployArguments -join ' '

                if (-not $contentChanged) {
                    $verification = [ordered]@{ ok = $false; attempts = 0; checks = @() }
                    $probe = Test-WorkshopDeployment -BaseUrl $VerifyBaseUrl -Pairs $pairs
                    if ($probe.ok) {
                        $status = 'verified-no-content-change'
                        $exitCode = 0
                        $verification = [ordered]@{ ok = $true; attempts = 1; reason = $null }
                        Write-RunLog 'snapshot matches the last successful deployment and the live site still serves those bytes; nothing to upload.'
                    } else {
                        $contentChanged = $true
                        Write-RunLog "live site does not match the recorded snapshot ($($probe.reason)); redeploying."
                    }
                }

                if ($status -ne 'verified-no-content-change') {
                    $attempt = 0
                    while ($attempt -lt $DeployAttempts) {
                        $attempt++
                        $uploadAttempts = $attempt
                        $attemptStartedAt = [DateTime]::UtcNow
                        Write-RunLog "--- wrangler attempt $attempt/$DeployAttempts ---"
                        $result = Invoke-Captured -CommandLine $deployCommandLine
                        $failed = $result.Text -notmatch 'Deployment complete'
                        if (-not $failed -and $result.Text -match 'Failed to upload files|ENOENT|expired jwt|Invalid account ID') { $failed = $true }
                        $pagesMatch = [regex]::Match($result.Text, 'https://[a-z0-9-]+\.' + [regex]::Escape($ProjectName) + '\.pages\.dev')
                        if ($pagesMatch.Success) { $pagesUrl = $pagesMatch.Value }
                        $duration = [Math]::Round(([DateTime]::UtcNow - $attemptStartedAt).TotalSeconds, 1)
                        Write-RunLog "attempt $attempt finished in ${duration}s exit=$($result.ExitCode) success=$((-not $failed).ToString().ToLowerInvariant())"

                        if ($failed) {
                            if ($attempt -lt $DeployAttempts) {
                                $delay = [int][Math]::Min($RetryMaxSeconds, $RetryBaseSeconds * [Math]::Pow(2, $attempt - 1))
                                Write-RunLog "retrying the full snapshot in $delay seconds."
                                Start-Sleep -Seconds $delay
                                continue
                            }
                            $status = 'deployment-failed'
                            $exitCode = 1
                            $errorSummary = 'wrangler pages deploy did not confirm a completed deployment'
                            Write-RunLog "ERROR: $errorSummary"
                            break
                        }

                        $verification = [ordered]@{ ok = $false; attempts = $VerifyAttempts; reason = 'not attempted' }
                        for ($checkAttempt = 1; $checkAttempt -le $VerifyAttempts; $checkAttempt++) {
                            $probe = Test-WorkshopDeployment -BaseUrl $VerifyBaseUrl -Pairs $pairs
                            if ($probe.ok) {
                                $verification = [ordered]@{ ok = $true; attempts = $checkAttempt; reason = $null }
                                break
                            }
                            $verification = [ordered]@{ ok = $false; attempts = $checkAttempt; reason = $probe.reason }
                            if ($checkAttempt -lt $VerifyAttempts) { Start-Sleep -Seconds $VerifyDelaySeconds }
                        }
                        if ($verification.ok) {
                            $status = 'deployed'
                            $exitCode = 0
                            Write-RunLog "online verification passed after $($verification.attempts) attempt(s); pagesUrl=$pagesUrl"
                        } else {
                            $errorSummary = "online verification failed: $($verification.reason)"
                            Write-RunLog "ERROR: $errorSummary"
                            if ($attempt -lt $DeployAttempts) {
                                $delay = [int][Math]::Min($RetryMaxSeconds, $RetryBaseSeconds * [Math]::Pow(2, $attempt - 1))
                                Write-RunLog "retrying the full snapshot in $delay seconds."
                                Start-Sleep -Seconds $delay
                                continue
                            }
                            $status = 'deployment-failed'
                            $exitCode = 1
                        }
                        break
                    }
                }
            } finally {
                if ($accountWasPresent) { $env:CLOUDFLARE_ACCOUNT_ID = $savedAccountId } else { Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue }
                if ($tokenWasPresent) { $env:CLOUDFLARE_API_TOKEN = $savedApiToken } else { Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue }
            }

            if ($status -eq 'deployed' -and -not [string]::IsNullOrWhiteSpace($contentHash)) {
                $stateTemp = "$statePath.$PID.tmp"
                $state = [ordered]@{
                    schemaVersion = 1
                    deployedAt = [DateTime]::UtcNow.ToString('o')
                    contentHash = $contentHash
                    fileCount = $snapshotFileCount
                    projectName = $ProjectName
                    pagesUrl = $pagesUrl
                }
                [IO.File]::WriteAllText($stateTemp, (($state | ConvertTo-Json -Depth 3) + "`n"), (New-Object Text.UTF8Encoding($false)))
                Move-Item -LiteralPath $stateTemp -Destination $statePath -Force
            }
        }
    }

    $offenders = Get-TrackedVideoOffenders
    if ($offenders.Count -gt 0) { throw "Tracked or staged video assets appeared during the run: $($offenders -join ', ')" }
} catch {
    $exitCode = 1
    $status = 'failed'
    # Keep the status useful without persisting command lines, cookies or signed URLs.
    $errorSummary = ([string]$_.Exception.Message) -replace 'https?://[^\s"'']+', '[url]'
    Write-RunLog "ERROR: $errorSummary"
} finally {
    Release-WorkshopLock
    $finishedAt = [DateTime]::UtcNow
    $logLines.Add("finishedAt=$($finishedAt.ToString('o'))")
    $logLines.Add("exitCode=$exitCode")
    [IO.File]::WriteAllLines($logPath, $logLines, (New-Object Text.UTF8Encoding($false)))
    $statusDocument = [ordered]@{
        schemaVersion = 1
        startedAt = $startedAt.ToString('o')
        finishedAt = $finishedAt.ToString('o')
        ok = $exitCode -eq 0
        exitCode = $exitCode
        status = $status
        projectName = $ProjectName
        contentHash = $contentHash
        contentChanged = $contentChanged
        fileCount = $snapshotFileCount
        uploadAttempts = $uploadAttempts
        pagesUrl = $pagesUrl
        verification = $verification
        logFile = $logPath.Substring($rootPath.Length + 1).Replace('\', '/')
        error = $errorSummary
    }
    $statusTemp = "$statusPath.$PID.tmp"
    [IO.File]::WriteAllText($statusTemp, (($statusDocument | ConvertTo-Json -Depth 5) + "`n"), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $statusTemp -Destination $statusPath -Force
    $cutoff = (Get-Date).AddDays(-$LogRetentionDays)
    Get-ChildItem -LiteralPath $logRoot -File -Filter 'workshop-*.log' -ErrorAction SilentlyContinue |
        Where-Object LastWriteTime -lt $cutoff |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0) { exit $exitCode }
