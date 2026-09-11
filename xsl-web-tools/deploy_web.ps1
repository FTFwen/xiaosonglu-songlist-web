[CmdletBinding()]
param(
    [switch]$Deploy,
    [switch]$Force,
    [switch]$AllowOAuth,
    [switch]$NoProcessExit,
    [ValidateRange(1, 8)]
    [int]$DeployAttempts = 5,
    [ValidateRange(1, 900)]
    [int]$RetryBaseSeconds = 30,
    [ValidateRange(1, 1800)]
    [int]$RetryMaxSeconds = 300,
    [string]$WranglerVersion = '4.130.0',
    [ValidateRange(1, 48)]
    [int]$VerifyAttempts = 20,
    [ValidateRange(1, 120)]
    [int]$VerifyDelaySeconds = 15,
    [string]$VerifyBaseUrl = 'https://viridis.love',
    [string]$HttpsProxy = '',
    [string]$ClashController = '',
    [string]$ClashProxyGroup = '',
    [string]$ClashProxyChoice = '',
    [string]$ProjectName = 'xsl-songlist',
    [string]$Branch = 'main',
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path $Root).Path
$verificationHelpersPath = Join-Path $PSScriptRoot 'deploy_verification_helpers.ps1'
if (-not (Test-Path -LiteralPath $verificationHelpersPath -PathType Leaf)) { throw 'Deployment verification helpers are missing.' }
. $verificationHelpersPath
$clashValuesPresent = @($ClashController, $ClashProxyGroup, $ClashProxyChoice) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$manageClashRoute = $clashValuesPresent.Count -gt 0
if ($manageClashRoute -and $clashValuesPresent.Count -ne 3) {
    throw 'ClashController, ClashProxyGroup and ClashProxyChoice must be supplied together.'
}
if ($manageClashRoute -and [string]::IsNullOrWhiteSpace($HttpsProxy)) {
    throw 'Managed Clash routing requires HttpsProxy so Wrangler uses that local proxy explicitly.'
}

# Direct deployment is supported, so it must fail closed on stale song derivations or
# workshop mirrors just like the scheduled wrapper does.
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
& $nodeCommand (Join-Path $rootPath 'scripts\build_xiaosonglu_song_data.mjs') '--root' $rootPath '--check' | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Song-data build check failed; rebuild before deployment.' }
& $nodeCommand (Join-Path $rootPath 'scripts\validate_song_data.mjs') '--root' $rootPath | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Song-data validation failed; refusing deployment.' }
$powershellCommand = (Get-Command powershell.exe -ErrorAction Stop).Source
& $powershellCommand '-NoProfile' '-ExecutionPolicy' 'Bypass' '-File' (Join-Path $rootPath 'xsl-web-tools\sync_workspace_data.ps1') '-Check' '-Root' $rootPath | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Workshop data mirror check failed; synchronize before deployment.' }

# Serialize preparation and remote publication. The stage directory is intentionally reused
# across retries, so two invocations must never delete/rebuild it concurrently.
$deployLockPath = Join-Path $rootPath 'data\xiaosonglu\_pages_deploy.lock'
$script:deployLockStream = $null
function Release-DeployLock {
    if ($script:deployLockStream) {
        $script:deployLockStream.Dispose()
        $script:deployLockStream = $null
    }
}
trap {
    Release-DeployLock
    throw
}
try {
    $script:deployLockStream = [System.IO.File]::Open(
        $deployLockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
} catch [System.IO.IOException] {
    throw 'Another Pages deployment is already preparing or uploading this workspace.'
}

function Get-ValidatedLocalClashBaseUri {
    param([string]$Controller)
    $uri = $null
    if (-not [Uri]::TryCreate($Controller, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'http' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'ClashController must be an absolute local HTTP URL without credentials, query or fragment.'
    }
    if ($uri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
        throw 'ClashController is restricted to the loopback interface.'
    }
    return $uri.AbsoluteUri.TrimEnd('/')
}

function Set-LocalClashProxyChoice {
    param(
        [string]$Controller,
        [string]$Group,
        [string]$Choice,
        [switch]$ReturnPrevious
    )
    $base = Get-ValidatedLocalClashBaseUri -Controller $Controller
    if ([string]::IsNullOrWhiteSpace($Group) -or [string]::IsNullOrWhiteSpace($Choice)) {
        throw 'ClashProxyGroup and ClashProxyChoice are both required when ClashController is set.'
    }
    # Keep the Task Scheduler command line ASCII-safe. __AUTO__ resolves to the
    # four Unicode code points for Clash's standard automatic selector name.
    $resolvedChoice = if ($Choice -eq '__AUTO__') {
        -join @([char]0x81EA, [char]0x52A8, [char]0x9009, [char]0x62E9)
    } else { $Choice }
    $groupUri = "$base/proxies/$([Uri]::EscapeDataString($Group))"
    $client = New-Object System.Net.WebClient
    try {
        $raw = $client.DownloadData($groupUri)
        $proxy = ([Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json)
        if (-not $proxy -or [string]::IsNullOrWhiteSpace([string]$proxy.now)) { throw 'The selected Clash proxy group is unavailable.' }
        $previous = [string]$proxy.now
        if (@($proxy.all) -notcontains $resolvedChoice) { throw 'The requested Clash proxy choice is not available in the selected group.' }
        if ($previous -ne $resolvedChoice) {
            $client.Headers[[System.Net.HttpRequestHeader]::ContentType] = 'application/json; charset=utf-8'
            $body = [Text.Encoding]::UTF8.GetBytes((@{ name = $resolvedChoice } | ConvertTo-Json -Compress))
            [void]$client.UploadData($groupUri, 'PUT', $body)
        }
        if ($ReturnPrevious) { return $previous }
    } finally {
        $client.Dispose()
    }
}

function Test-WranglerReportedFailure {
    param([string[]]$Lines)
    $text = ($Lines -join "`n")
    return $text -match '(?i)failed to upload files|a request to the cloudflare api.+failed|a file or directory could not be found|fatalerror|invalid access token|authentication error|invalid account id|permission denied|project.+not found|error:.*(?:ENOENT|EACCES|ECONN|ETIMEDOUT)'
}

function Test-RetryableWranglerFailure {
    param([string[]]$Lines)
    $text = ($Lines -join "`n")
    if ($text -match '(?i)invalid access token|authentication error|incorrect permissions|permission denied|invalid account|project.+not found') {
        return $false
    }
    return $text -match '(?i)failed to upload files|too many bulk operations|expired jwt|rate.?limit|\b408\b|\b429\b|\b5(?:00|02|03|04|22|24)\b|ENOENT|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|fetch failed|network|socket|connection.*(?:closed|reset|timed out)'
}

function Invoke-PublicCurl {
    param(
        [string]$Uri,
        [string]$OutputPath,
        [int]$MaxTimeSeconds = 45,
        [string]$Range = ''
    )
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) { throw 'curl.exe is required for bounded online deployment verification.' }
    $curlArgs = @('--fail', '--silent', '--show-error', '--location', '--connect-timeout', '15', '--max-time', [string]$MaxTimeSeconds, '-H', 'Cache-Control: no-cache', '--output', $OutputPath, '--write-out', '%{http_code}')
    if (-not [string]::IsNullOrWhiteSpace($Range)) { $curlArgs += @('--range', $Range) }
    $statusText = (& $curl.Source @curlArgs $Uri 2>$null | Out-String).Trim()
    $code = $LASTEXITCODE
    if ($code -ne 0 -or $statusText -notmatch '^2\d\d$') {
        throw "public request failed (curl=$code, http=$statusText)"
    }
    return [int]$statusText
}

function Test-PublicDeployment {
    param(
        [string]$BaseUrl,
        [hashtable]$ExpectedAudio,
        [int]$ExpectedSongCount,
        [hashtable]$ExpectedStaticHashes,
        [hashtable]$ExpectedVersionedAudio
    )
    $base = $BaseUrl.TrimEnd('/')
    $stamp = [DateTime]::UtcNow.Ticks
    $audioTemp = [IO.Path]::GetTempFileName()
    $catalogTemp = [IO.Path]::GetTempFileName()
    $sampleTemp = [IO.Path]::GetTempFileName()
    $buttonsTemp = [IO.Path]::GetTempFileName()
    $staticTemps = @()
    $versionedAudioTemps = @()
    $normalizedAnalyticsHtmlCount = 0
    try {
        $audioStatus = Invoke-PublicCurl -Uri "$base/data/xiaosonglu/audio_index.json?xsl_verify=$stamp" -OutputPath $audioTemp
        $onlineAudio = Get-Content -LiteralPath $audioTemp -Raw -Encoding UTF8 | ConvertFrom-Json
        $onlineProperties = @($onlineAudio.audios.PSObject.Properties)
        if ([int]$onlineAudio.count -ne $ExpectedAudio.Count -or $onlineProperties.Count -ne $ExpectedAudio.Count) {
            throw "online audio count mismatch: expected $($ExpectedAudio.Count), got $($onlineProperties.Count)"
        }
        foreach ($property in $ExpectedAudio.GetEnumerator()) {
            $onlineProperty = $onlineAudio.audios.PSObject.Properties[$property.Key]
            if (-not $onlineProperty -or [string]$onlineProperty.Value -ne [string]$property.Value) {
                $actual = if ($onlineProperty) { [string]$onlineProperty.Value } else { '<missing>' }
                throw "online audio mapping mismatch for '$($property.Key)': expected '$($property.Value)', got '$actual'"
            }
        }

        $catalogStatus = Invoke-PublicCurl -Uri "$base/data/xiaosonglu/song_catalog.json?xsl_verify=$stamp" -OutputPath $catalogTemp
        $catalog = Get-Content -LiteralPath $catalogTemp -Raw -Encoding UTF8 | ConvertFrom-Json
        $onlineSongCount = @($catalog.songs).Count
        if ($onlineSongCount -ne $ExpectedSongCount) { throw "online song count mismatch: expected $ExpectedSongCount, got $onlineSongCount" }

        $sampleEntry = @($ExpectedAudio.GetEnumerator() | Select-Object -First 1)[0]
        $samplePath = [string]$sampleEntry.Value
        if ([string]::IsNullOrWhiteSpace($samplePath)) { throw 'local expected audio map has no sample path' }
        $sampleSeparator = if ($samplePath.Contains('?')) { '&' } else { '?' }
        $sampleStatus = Invoke-PublicCurl -Uri "${base}/${samplePath}${sampleSeparator}xsl_verify=$stamp" -OutputPath $sampleTemp -MaxTimeSeconds 90 -Range '0-31'
        $sampleBytes = [IO.File]::ReadAllBytes($sampleTemp)
        if ($sampleBytes.Length -lt 12 -or $sampleBytes[4] -ne 0x66 -or $sampleBytes[5] -ne 0x74 -or $sampleBytes[6] -ne 0x79 -or $sampleBytes[7] -ne 0x70) { throw 'online sample audio is not a valid M4A response' }

        foreach ($entry in $ExpectedStaticHashes.GetEnumerator()) {
            $temp = [IO.Path]::GetTempFileName()
            $staticTemps += $temp
            Invoke-PublicCurl -Uri "${base}/$($entry.Key)?xsl_verify=$stamp" -OutputPath $temp | Out-Null
            $actualHash = (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne [string]$entry.Value) {
                $isHtml = [string]$entry.Key -match '(?i)\.html$'
                if ($isHtml -and (Test-CloudflareAnalyticsHtmlEquivalent -Path $temp -ExpectedHash ([string]$entry.Value))) {
                    $normalizedAnalyticsHtmlCount++
                } else {
                    throw "online static payload hash mismatch: $($entry.Key)"
                }
            }
        }
        foreach ($entry in $ExpectedVersionedAudio.GetEnumerator()) {
            $spec = $entry.Value
            $temp = [IO.Path]::GetTempFileName()
            $versionedAudioTemps += $temp
            $publicPath = [string]$spec.publicPath
            $separator = if ($publicPath.Contains('?')) { '&' } else { '?' }
            Invoke-PublicCurl -Uri "${base}/${publicPath}${separator}xsl_verify=$stamp" -OutputPath $temp -MaxTimeSeconds 120 | Out-Null
            $actualFile = Get-Item -LiteralPath $temp
            if ($actualFile.Length -ne [long]$spec.bytes) { throw "online versioned audio size mismatch: $($entry.Key)" }
            $actualHash = (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne [string]$spec.sha256) { throw "online versioned audio hash mismatch: $($entry.Key)" }
        }

        $buttonsStatus = Invoke-PublicCurl -Uri "$base/buttons/?xsl_verify=$stamp" -OutputPath $buttonsTemp
        return [ordered]@{
            ok = $true
            baseUrl = $base
            audioCount = $onlineProperties.Count
            songCount = $onlineSongCount
            audioIndexStatus = $audioStatus
            catalogStatus = $catalogStatus
            sampleStatus = $sampleStatus
            staticPayloadsVerified = $ExpectedStaticHashes.Count
            cloudflareAnalyticsHtmlNormalized = $normalizedAnalyticsHtmlCount
            versionedAudioVerified = $ExpectedVersionedAudio.Count
            buttonsStatus = $buttonsStatus
        }
    } catch {
        $reason = ([string]$_.Exception.Message) -replace 'https?://[^\s"'']+', '[url]'
        return [ordered]@{ ok = $false; baseUrl = $base; reason = $reason }
    } finally {
        foreach ($temp in @($audioTemp, $catalogTemp, $sampleTemp, $buttonsTemp) + $staticTemps + $versionedAudioTemps) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    }
}

function Wait-PublicDeployment {
    param(
        [string]$PrimaryBaseUrl,
        [string]$AdditionalBaseUrl,
        [hashtable]$ExpectedAudio,
        [int]$ExpectedSongCount,
        [hashtable]$ExpectedStaticHashes,
        [hashtable]$ExpectedVersionedAudio,
        [int]$Attempts,
        [int]$DelaySeconds
    )
    $bases = @($PrimaryBaseUrl.TrimEnd('/'))
    if (-not [string]::IsNullOrWhiteSpace($AdditionalBaseUrl)) {
        $additional = $AdditionalBaseUrl.TrimEnd('/')
        if ($bases -notcontains $additional) { $bases += $additional }
    }
    $lastChecks = @()
    for ($checkAttempt = 1; $checkAttempt -le $Attempts; $checkAttempt++) {
        $lastChecks = @($bases | ForEach-Object { Test-PublicDeployment -BaseUrl $_ -ExpectedAudio $ExpectedAudio -ExpectedSongCount $ExpectedSongCount -ExpectedStaticHashes $ExpectedStaticHashes -ExpectedVersionedAudio $ExpectedVersionedAudio })
        if (@($lastChecks | Where-Object { -not $_.ok }).Count -eq 0) {
            return [ordered]@{ ok = $true; attempts = $checkAttempt; checks = $lastChecks }
        }
        if ($checkAttempt -lt $Attempts) { Start-Sleep -Seconds $DelaySeconds }
    }
    return [ordered]@{ ok = $false; attempts = $Attempts; checks = $lastChecks }
}
$configPath = Join-Path $rootPath 'wrangler.toml'
$functionsPath = Join-Path $rootPath 'functions'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'wrangler.toml is required; refusing static-only deployment.' }
if (-not (Test-Path -LiteralPath $functionsPath -PathType Container)) { throw 'functions/ is required; refusing static-only deployment.' }
$configText = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
if ($configText -notmatch '(?m)^\s*pages_build_output_dir\s*=') { throw 'wrangler.toml has no pages_build_output_dir.' }
if ($configText -notmatch '(?m)^\s*\[\[r2_buckets\]\]') { throw 'wrangler.toml has no R2 binding; refusing deployment.' }

# Song audio is intentionally ignored by Git, but every Pages deployment must still carry it.
$audioIndexPath = Join-Path $rootPath 'data\xiaosonglu\audio_index.json'
$audioBaselinePath = Join-Path $rootPath 'data\xiaosonglu\audio_asset_baseline.json'
if (-not (Test-Path -LiteralPath $audioIndexPath -PathType Leaf)) { throw 'audio_index.json is required.' }
if (-not (Test-Path -LiteralPath $audioBaselinePath -PathType Leaf)) { throw 'The durable audio asset baseline is missing; refusing deployment.' }
$audioIndex = Get-Content -LiteralPath $audioIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
$audioProperties = @($audioIndex.audios.PSObject.Properties)
if ($audioProperties.Count -eq 0) { throw 'audio_index.json must contain a non-empty audios object.' }
if ([int]$audioIndex.count -ne $audioProperties.Count) { throw 'audio_index.json count does not match its audios entries.' }
$audioRelativePaths = @()
foreach ($property in $audioProperties) {
    $rawPath = [string]$property.Value
    if ($rawPath -notmatch '^assets/audio/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a\?v=[0-9a-f]{12,64}$') { throw "Unsafe or non-hash-versioned audio path in audio_index.json: $rawPath" }
    $audioRelativePaths += $rawPath.Split('?')[0].Replace('/', '\')
}
$audioRelativePaths = @($audioRelativePaths | Sort-Object -Unique)
if ($audioRelativePaths.Count -ne $audioProperties.Count) { throw 'audio_index.json contains duplicate or colliding audio targets.' }
$expectedAudioMap = @{}
foreach ($property in $audioProperties) {
    $expectedAudioMap[$property.Name] = ([string]$property.Value).Replace('\', '/')
}
$catalogPath = Join-Path $rootPath 'data\xiaosonglu\song_catalog.json'
if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'song_catalog.json is required.' }
$catalogForVerification = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedSongCount = @($catalogForVerification.songs).Count
if ($expectedSongCount -le 0) { throw 'song_catalog.json must contain songs.' }
$audioBaseline = Get-Content -LiteralPath $audioBaselinePath -Raw -Encoding UTF8 | ConvertFrom-Json
$baselineProperties = @($audioBaseline.files.PSObject.Properties)
if ($baselineProperties.Count -eq 0 -or [int]$audioBaseline.count -ne $baselineProperties.Count) { throw 'Durable audio baseline is empty or has an invalid count.' }
$baselineHashes = @{}
$baselineSizes = @{}
foreach ($property in $baselineProperties) {
    $rawPath = [string]$property.Name
    if ($rawPath -notmatch '^assets/audio/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a$') { throw "Unsafe path in durable audio baseline: $rawPath" }
    $relative = $rawPath.Replace('/', '\')
    if ($baselineHashes.ContainsKey($relative)) { throw "Duplicate path in durable audio baseline: $rawPath" }
    $baselineHashes[$relative] = [string]$property.Value.sha256
    $baselineSizes[$relative] = [long]$property.Value.bytes
}
$baselineDifference = @(Compare-Object -ReferenceObject @($audioRelativePaths) -DifferenceObject @($baselineHashes.Keys))
if ($baselineDifference.Count -gt 0) { throw 'audio_index.json differs from the durable audio baseline; explicitly review and adopt the new set first.' }
foreach ($property in $audioProperties) {
    $rawPath = ([string]$property.Value).Replace('\', '/')
    if ($rawPath -match '\?v=([0-9a-f]{12,64})$') {
        $relative = $rawPath.Split('?')[0].Replace('/', '\')
        $version = $Matches[1]
        if (-not ([string]$baselineHashes[$relative]).StartsWith($version, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Audio cache version does not match the adopted SHA-256 for '$($property.Name)'."
        }
    }
}
$audioRootPath = Join-Path $rootPath 'assets\audio'
if (-not (Test-Path -LiteralPath $audioRootPath -PathType Container)) { throw 'assets/audio is missing; run tools/sync_song_audio_assets.py before deploying.' }
$audioRootItem = Get-Item -LiteralPath $audioRootPath
if (($audioRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'assets/audio must not be a link or reparse point.' }
$audioSourceHashes = @{}
foreach ($relative in $audioRelativePaths) {
    $source = Join-Path $rootPath $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Missing song audio asset $relative; run tools/sync_song_audio_assets.py against a known-good deployment before deploying."
    }
    $item = Get-Item -LiteralPath $source
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Song audio asset must not be a link or reparse point: $relative" }
    if ($item.Length -le 0 -or $item.Length -ne $baselineSizes[$relative]) { throw "Song audio asset size mismatch: $relative" }
    $header = @(Get-Content -LiteralPath $source -Encoding Byte -TotalCount 12)
    if ($header.Count -lt 12 -or $header[4] -ne 102 -or $header[5] -ne 116 -or $header[6] -ne 121 -or $header[7] -ne 112) {
        throw "Song audio asset is not an M4A container: $relative"
    }
    $expectedHash = $baselineHashes[$relative]
    if ([string]::IsNullOrWhiteSpace($expectedHash)) { throw "Durable audio baseline has no hash for $relative" }
    $actualHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash.ToLowerInvariant()) { throw "Song audio hash mismatch: $relative" }
    $audioSourceHashes[$relative] = $actualHash
}

$git = Get-Command git -ErrorAction Stop
$head = (& $git.Source -C $rootPath rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $head) { throw 'Cannot resolve Git HEAD.' }
$workingTreeStatus = @(& $git.Source -C $rootPath status --porcelain --untracked-files=all)

$wranglerRoot = Join-Path $rootPath '.wrangler'
$stagePath = Join-Path $wranglerRoot 'deploy-stage'
$archivePath = Join-Path $wranglerRoot 'deploy-head.tar'
# Project policy: clear all Wrangler cache before every deployment preparation.
if (Test-Path -LiteralPath $wranglerRoot) { Remove-Item -LiteralPath $wranglerRoot -Recurse -Force }
New-Item -ItemType Directory -Path $stagePath -Force | Out-Null
& $git.Source -C $rootPath archive --format=tar HEAD -o $archivePath
if ($LASTEXITCODE -ne 0) { throw 'git archive failed.' }
& tar -xf $archivePath -C $stagePath
if ($LASTEXITCODE -ne 0) { throw 'Extracting deployment baseline failed.' }
Remove-Item -LiteralPath $archivePath -Force

# Overlay only pipeline-owned current outputs. Other dirty/untracked working-tree files stay out of deployment.
# The song-data vocabulary and compatibility files are part of the pipeline
# contract so scheduled deployments carry reviewed tag policy and cache-safe
# canonicalization without requiring a Git commit.
$overlayRelativePaths = @(
    'index.html',
    '24xsl\index.html',
    'buttons\index.html',
    'workshop\index.html',
    'js\app.js',
    'js\cross-page-player.js',
    'js\shared.js',
    'js\listen-together.js',
    'css\listen-together.css',
    'workshop\js\app.js',
    'workshop\js\shared.js',
    'workshop\js\start.js',
    'data\xiaosonglu\audio_index.json',
    'data\xiaosonglu\history_index.json',
    'data\xiaosonglu\replay_song_segments.json',
    'data\xiaosonglu\song_catalog.json',
    'data\xiaosonglu\song_cut_index.json',
    'data\xiaosonglu\song_cut_info.json',
    'data\xiaosonglu\song_cut_table.csv',
    'data\xiaosonglu\song_details.json',
    'data\xiaosonglu\song_metadata_overrides.json',
    'data\xiaosonglu\type_tag_registry.json',
    'js\data.js',
    'workshop\data\xiaosonglu\audio_index.json',
    'workshop\data\xiaosonglu\history_index.json',
    'workshop\data\xiaosonglu\song_catalog.json',
    'workshop\data\xiaosonglu\song_cut_info.json',
    'workshop\data\xiaosonglu\song_details.json',
    'workshop\js\data.js',
    'functions\_auth.js',
    'buttons\buttons.js'
)
$overlayed = @()
foreach ($relative in $overlayRelativePaths) {
    $source = Join-Path $rootPath $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required deployment overlay is missing: $relative" }
    $destination = Join-Path $stagePath $relative
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $overlayed += $relative.Replace('\', '/')
}
foreach ($relative in $audioRelativePaths) {
    $source = Join-Path $rootPath $relative
    $destination = Join-Path $stagePath $relative
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $overlayed += $relative.Replace('\', '/')
}

# Validate the assembled immutable stage, so a concurrent daily build cannot yield a
# mixed overlay even though direct and scheduled entry points use different outer locks.
foreach ($relative in @(
    'data\xiaosonglu\audio_asset_baseline.json',
    'data\xiaosonglu\ingestion_state.json',
    'data\xiaosonglu\remote_baseline_manifest.json'
)) {
    Copy-Item -LiteralPath (Join-Path $rootPath $relative) -Destination (Join-Path $stagePath $relative) -Force
}
& $nodeCommand (Join-Path $rootPath 'scripts\build_xiaosonglu_song_data.mjs') '--root' $stagePath '--check' | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Final staged song-data build check failed; refusing deployment.' }
& $nodeCommand (Join-Path $rootPath 'scripts\validate_song_data.mjs') '--root' $stagePath | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Final staged song-data validation failed; refusing deployment.' }
& $powershellCommand '-NoProfile' '-ExecutionPolicy' 'Bypass' '-File' (Join-Path $rootPath 'xsl-web-tools\sync_workspace_data.ps1') '-Check' '-Root' $stagePath | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Final staged workshop mirror check failed; refusing deployment.' }

# Defense in depth: downloaded videos and transient review files can never enter the stage.
$blockedDirectories = @(
    'assets\video', 'assets\videos', 'data\xiaosonglu\videos',
    'scripts', 'xsl-web-tools', 'tools', 'workers'
)
foreach ($relative in $blockedDirectories) {
    $candidate = Join-Path $stagePath $relative
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Recurse -Force }
}
$blockedFiles = @(
    'data\xiaosonglu\audio_asset_baseline.json',
    'data\xiaosonglu\ingestion_state.json',
    'data\xiaosonglu\remote_baseline_manifest.json'
)
foreach ($relative in $blockedFiles) {
    $candidate = Join-Path $stagePath $relative
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Force }
}
Get-ChildItem -LiteralPath $stagePath -Recurse -File | Where-Object {
    $_.Name -like '_danmaku_*' -or $_.Name -like '_candidate_*' -or $_.Name -like '_video_*' -or
    $_.Extension -in @('.mp4', '.webm', '.mkv', '.mov', '.flv')
} | Remove-Item -Force

# Verify the final stage, not merely the working tree examined before archive/copy.
$stageConfigPath = Join-Path $stagePath 'wrangler.toml'
$stageFunctionsPath = Join-Path $stagePath 'functions'
if (-not (Test-Path -LiteralPath $stageConfigPath -PathType Leaf) -or -not (Test-Path -LiteralPath $stageFunctionsPath -PathType Container)) {
    throw 'Final stage lost wrangler.toml or functions/; refusing deployment.'
}
$stageFunctionFiles = @(Get-ChildItem -LiteralPath $stageFunctionsPath -Recurse -File)
if ($stageFunctionFiles.Count -eq 0) { throw 'Final stage has no Pages Function files; refusing static-only deployment.' }
$stageConfigText = Get-Content -LiteralPath $stageConfigPath -Raw -Encoding UTF8
if ($stageConfigText -notmatch '(?m)^\s*pages_build_output_dir\s*=' -or $stageConfigText -notmatch '(?m)^\s*\[\[r2_buckets\]\]') {
    throw 'Final stage lost its Pages output or R2 binding configuration.'
}
$stageAudioRoot = Join-Path $stagePath 'assets\audio'
$stageAudioFiles = @(Get-ChildItem -LiteralPath $stageAudioRoot -Recurse -File -ErrorAction Stop)
if ($stageAudioFiles.Count -ne $audioRelativePaths.Count) { throw "Final stage audio count mismatch: expected $($audioRelativePaths.Count), got $($stageAudioFiles.Count)." }
$stagedAudioCount = 0
foreach ($relative in $audioRelativePaths) {
    $staged = Join-Path $stagePath $relative
    if (-not (Test-Path -LiteralPath $staged -PathType Leaf)) { throw "Final stage is missing song audio: $relative" }
    $item = Get-Item -LiteralPath $staged
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne $baselineSizes[$relative]) {
        throw "Final staged song audio is invalid: $relative"
    }
    $stagedHash = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($stagedHash -ne $audioSourceHashes[$relative]) { throw "Final staged song audio hash mismatch: $relative" }
    $stagedAudioCount++
}

$expectedStaticHashes = @{}
foreach ($relative in @(
    'index.html',
    '24xsl/index.html',
    'buttons/index.html',
    'buttons/buttons.js',
    'js/app.js',
    'js/cross-page-player.js',
    'js/shared.js',
    'js/listen-together.js',
    'css/listen-together.css',
    'js/data.js',
    'workshop/index.html',
    'workshop/js/app.js',
    'workshop/js/shared.js',
    'workshop/js/start.js',
    'workshop/js/data.js',
    'data/xiaosonglu/audio_index.json',
    'data/xiaosonglu/history_index.json',
    'data/xiaosonglu/replay_song_segments.json',
    'data/xiaosonglu/song_catalog.json',
    'data/xiaosonglu/song_cut_index.json',
    'data/xiaosonglu/song_cut_info.json',
    'data/xiaosonglu/song_cut_table.csv',
    'data/xiaosonglu/song_details.json',
    'data/xiaosonglu/type_tag_registry.json',
    'workshop/data/xiaosonglu/audio_index.json',
    'workshop/data/xiaosonglu/history_index.json',
    'workshop/data/xiaosonglu/song_catalog.json',
    'workshop/data/xiaosonglu/song_cut_info.json',
    'workshop/data/xiaosonglu/song_details.json'
)) {
    $staged = Join-Path $stagePath $relative.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $staged -PathType Leaf)) { throw "Final stage is missing verification payload: $relative" }
    $expectedStaticHashes[$relative] = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant()
}
$expectedVersionedAudio = @{}
$verificationTargets = @($audioIndex.verificationTargets)
if ($verificationTargets.Count -eq 0 -or @($verificationTargets | Where-Object { [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
    throw 'audio_index.json must contain non-empty verificationTargets.'
}
foreach ($songName in @($verificationTargets | Sort-Object -Unique)) {
    $property = $audioIndex.audios.PSObject.Properties[[string]$songName]
    if (-not $property) { throw "Audio verification target is not mapped: $songName" }
    $rawPath = ([string]$property.Value).Replace('\', '/')
    if ($rawPath -notmatch '\?v=[0-9a-f]{12,64}$') { throw "Audio verification target lacks a hash version: $songName" }
    $relative = $rawPath.Split('?')[0].Replace('/', '\')
    $expectedVersionedAudio[[string]$songName] = [ordered]@{
        publicPath = $rawPath
        bytes = [long]$baselineSizes[$relative]
        sha256 = [string]$baselineHashes[$relative]
    }
}

$manifestLines = @()
$stageFiles = @(Get-ChildItem -LiteralPath $stagePath -Recurse -File | Sort-Object FullName)
foreach ($file in $stageFiles) {
    $relative = $file.FullName.Substring($stagePath.Length + 1).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestLines += "$relative`t$hash"
}
$manifestPath = Join-Path $wranglerRoot 'deploy-manifest.txt'
[System.IO.File]::WriteAllLines($manifestPath, $manifestLines, (New-Object System.Text.UTF8Encoding($false)))
$contentHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$statePath = Join-Path $rootPath 'data\xiaosonglu\_deploy_state.json'
$rawAccountId = [string]$env:CLOUDFLARE_ACCOUNT_ID
$accountIdLooksValid = -not [string]::IsNullOrWhiteSpace($rawAccountId) -and $rawAccountId -match '^[A-Za-z0-9_-]+$' -and $rawAccountId.Length -ge 16
# -AllowOAuth is an explicit preference, not merely permission: remove any inherited
# token/account overrides so a stale CI token cannot silently win over wrangler login.
$useOAuthDefaultAccount = [bool]$AllowOAuth
$accountScope = if ($useOAuthDefaultAccount) { 'wrangler-oauth-default' } elseif ($accountIdLooksValid) { $rawAccountId } else { 'wrangler-oauth-default' }
$previousHash = $null
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try {
        $previousState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($previousState.accountScope -eq $accountScope -and $previousState.projectName -eq $ProjectName -and $previousState.branch -eq $Branch) { $previousHash = $previousState.contentHash }
    } catch { $previousHash = $null }
}
$contentChanged = $Force -or ($contentHash -ne $previousHash)
$hasToken = -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)
$hasExplicitCredentials = $hasToken -and $accountIdLooksValid
$hasCredentials = $hasExplicitCredentials -or $AllowOAuth

$wranglerCommand = Get-Command wrangler.cmd -ErrorAction SilentlyContinue
$wranglerPrefix = @()
if (-not $wranglerCommand) { $wranglerCommand = Get-Command wrangler -ErrorAction SilentlyContinue }
if (-not $wranglerCommand) {
    $wranglerCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if (-not $wranglerCommand) { $wranglerCommand = Get-Command npx -ErrorAction SilentlyContinue }
    if ($wranglerCommand) { $wranglerPrefix = @('--yes', "wrangler@$WranglerVersion") }
}

$status = 'preflight-only'
$deploymentOutput = @()
$deploymentAttemptSummaries = @()
$onlineVerification = $null
if ($Deploy -and $hasCredentials -and $wranglerCommand -and -not $contentChanged) {
    # A local state file is only a deployment optimization, never proof that the custom
    # domain still serves these bytes. Verify it once and redeploy if it drifted/rolled back.
    $onlineVerification = Wait-PublicDeployment -PrimaryBaseUrl $VerifyBaseUrl -AdditionalBaseUrl '' -ExpectedAudio $expectedAudioMap -ExpectedSongCount $expectedSongCount -ExpectedStaticHashes $expectedStaticHashes -ExpectedVersionedAudio $expectedVersionedAudio -Attempts 1 -DelaySeconds 1
    if (-not $onlineVerification.ok) { $contentChanged = $true }
}
if ($Deploy) {
    if (-not $hasCredentials) { $status = 'skipped-missing-credentials' }
    elseif (-not $wranglerCommand) { $status = 'skipped-missing-wrangler' }
    elseif (-not $contentChanged) { $status = 'verified-no-content-change' }
    else {
        $baseArguments = @() + $wranglerPrefix + @(
            'pages', 'deploy', '.',
            '--project-name', $ProjectName,
            '--branch', $Branch,
            '--commit-hash', $head,
            '--commit-dirty=true'
        )
        $deploymentAttemptSummaries = @()
        Push-Location $stagePath
        $previousErrorActionPreference = $ErrorActionPreference
        $savedAccountId = $env:CLOUDFLARE_ACCOUNT_ID
        $savedApiToken = $env:CLOUDFLARE_API_TOKEN
        $savedHttpsProxy = $env:HTTPS_PROXY
        $savedHttpProxy = $env:HTTP_PROXY
        $accountOverrideWasPresent = Test-Path Env:CLOUDFLARE_ACCOUNT_ID
        $apiTokenWasPresent = Test-Path Env:CLOUDFLARE_API_TOKEN
        $httpsProxyWasPresent = Test-Path Env:HTTPS_PROXY
        $httpProxyWasPresent = Test-Path Env:HTTP_PROXY
        $clashPreviousChoice = $null
        $clashRouteChanged = $false
        $clashRestoreSucceeded = $null
        try {
            if ($useOAuthDefaultAccount) {
                # Stale environment placeholders/tokens must not override the account selected
                # by wrangler login when OAuth was explicitly requested.
                Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
                Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
            }
            if (-not [string]::IsNullOrWhiteSpace($HttpsProxy)) {
                $proxyUri = $null
                if (-not [Uri]::TryCreate($HttpsProxy, [UriKind]::Absolute, [ref]$proxyUri) -or $proxyUri.Scheme -notin @('http', 'https') -or $proxyUri.UserInfo) {
                    throw 'HttpsProxy must be an absolute HTTP(S) proxy URL without embedded credentials.'
                }
                $env:HTTPS_PROXY = $proxyUri.AbsoluteUri
                $env:HTTP_PROXY = $proxyUri.AbsoluteUri
            }
            if ($manageClashRoute) {
                $clashPreviousChoice = Set-LocalClashProxyChoice -Controller $ClashController -Group $ClashProxyGroup -Choice $ClashProxyChoice -ReturnPrevious
                # Restoring an unchanged selection is harmless and also handles the
                # ASCII __AUTO__ alias without comparing it to the resolved name.
                $clashRouteChanged = $true
            }
            # A Pages deployment remains one complete snapshot. Retrying the same staging tree
            # is safe and lets Cloudflare reuse content-addressed assets already accepted by an
            # earlier attempt; splitting the tree across independent deployments is not safe.
            $ErrorActionPreference = 'Continue'
            for ($attempt = 1; $attempt -le $DeployAttempts; $attempt++) {
                $attemptStartedAt = [DateTime]::UtcNow
                # Try the efficient differential path first. If it fails, alternate a
                # clean cache-bypass attempt with another differential attempt. The
                # latter can reuse content-addressed assets accepted before a prior
                # command failed, while every command still submits the full snapshot.
                $cleanUpload = $attempt % 2 -eq 0
                $attemptArguments = @() + $baseArguments
                if ($cleanUpload) { $attemptArguments += '--skip-caching' }
                $attemptOutput = @(& $wranglerCommand.Source @attemptArguments 2>&1 | ForEach-Object { $_.ToString() })
                $processExitCode = $LASTEXITCODE
                # Wrangler 4.130.0 can report an async upload rejection while leaving the
                # Node process exit code at zero (for example ENOENT in a bucket). Treat the
                # structured diagnostic as authoritative and never record a false deployment.
                $reportedFailure = Test-WranglerReportedFailure -Lines $attemptOutput
                $exitCode = if ($processExitCode -ne 0 -or $reportedFailure) { 1 } else { 0 }
                $retryable = $exitCode -ne 0 -and (Test-RetryableWranglerFailure -Lines $attemptOutput)
                if ($exitCode -eq 0) {
                    $pagesMatches = [regex]::Matches(($attemptOutput -join "`n"), 'https://[a-z0-9-]+\.xsl-songlist\.pages\.dev')
                    $additionalPagesUrl = if ($pagesMatches.Count -gt 0) { $pagesMatches[$pagesMatches.Count - 1].Value } else { $null }
                    $onlineVerification = Wait-PublicDeployment -PrimaryBaseUrl $VerifyBaseUrl -AdditionalBaseUrl $additionalPagesUrl -ExpectedAudio $expectedAudioMap -ExpectedSongCount $expectedSongCount -ExpectedStaticHashes $expectedStaticHashes -ExpectedVersionedAudio $expectedVersionedAudio -Attempts $VerifyAttempts -DelaySeconds $VerifyDelaySeconds
                    if (-not $onlineVerification.ok) {
                        $attemptOutput += 'PUBLIC DEPLOYMENT VERIFICATION FAILED: the published snapshot did not match local data.'
                        $reportedFailure = $true
                        $exitCode = 1
                        $retryable = $attempt -lt $DeployAttempts
                    }
                }
                $delaySeconds = 0
                if ($retryable -and $attempt -lt $DeployAttempts) {
                    $delaySeconds = [int][Math]::Min($RetryMaxSeconds, $RetryBaseSeconds * [Math]::Pow(2, $attempt - 1))
                }
                $deploymentOutput += "--- Wrangler attempt $attempt/$DeployAttempts ---"
                $deploymentOutput += $attemptOutput
                $deploymentAttemptSummaries += [ordered]@{
                    attempt = $attempt
                    startedAt = $attemptStartedAt.ToString('o')
                    durationSeconds = [Math]::Round(([DateTime]::UtcNow - $attemptStartedAt).TotalSeconds, 3)
                    cleanUpload = [bool]$cleanUpload
                    processExitCode = $processExitCode
                    reportedFailure = [bool]$reportedFailure
                    exitCode = $exitCode
                    retryable = [bool]$retryable
                    delayBeforeNextSeconds = $delaySeconds
                }
                if ($exitCode -eq 0 -or -not $retryable -or $attempt -eq $DeployAttempts) { break }
                Start-Sleep -Seconds $delaySeconds
            }
        } finally {
            if ($manageClashRoute -and $clashRouteChanged) {
                try {
                    Set-LocalClashProxyChoice -Controller $ClashController -Group $ClashProxyGroup -Choice $clashPreviousChoice
                    $clashRestoreSucceeded = $true
                } catch {
                    $clashRestoreSucceeded = $false
                    $deploymentOutput += 'WARNING: failed to restore the previous local Clash proxy choice.'
                }
            } elseif ($manageClashRoute) {
                $clashRestoreSucceeded = $true
            }
            if ($accountOverrideWasPresent) {
                $env:CLOUDFLARE_ACCOUNT_ID = $savedAccountId
            } else {
                Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
            }
            if ($apiTokenWasPresent) {
                $env:CLOUDFLARE_API_TOKEN = $savedApiToken
            } else {
                Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
            }
            if ($httpsProxyWasPresent) { $env:HTTPS_PROXY = $savedHttpsProxy } else { Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue }
            if ($httpProxyWasPresent) { $env:HTTP_PROXY = $savedHttpProxy } else { Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue }
            $ErrorActionPreference = $previousErrorActionPreference
            Pop-Location
        }
        if ($exitCode -ne 0) {
            $status = 'deployment-failed'
        } else {
            $status = 'deployed'
            $state = [ordered]@{
                schemaVersion = 1
                deployedAt = [DateTime]::UtcNow.ToString('o')
                accountScope = $accountScope
                projectName = $ProjectName
                branch = $Branch
                commitHash = $head
                contentHash = $contentHash
                fileCount = $stageFiles.Count
            }
            $stateTempPath = "$statePath.$PID.tmp"
            [System.IO.File]::WriteAllText($stateTempPath, (($state | ConvertTo-Json -Depth 4) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
            Move-Item -LiteralPath $stateTempPath -Destination $statePath -Force
        }
    }
}

$operationFailed = $status -in @('deployment-failed', 'skipped-missing-credentials', 'skipped-missing-wrangler')
$result = [ordered]@{
    ok = -not $operationFailed
    status = $status
    projectName = $ProjectName
    branch = $Branch
    commitHash = $head
    contentHash = $contentHash
    previousContentHash = $previousHash
    contentChanged = [bool]$contentChanged
    hasCloudflareCredentials = [bool]($hasExplicitCredentials -or $AllowOAuth)
    cloudflareAuthMode = if ($AllowOAuth) { 'wrangler-oauth' } elseif ($hasExplicitCredentials) { 'environment' } else { 'none' }
    accountScope = $accountScope
    oauthDefaultAccountUsed = [bool]$useOAuthDefaultAccount
    proxyUsed = -not [string]::IsNullOrWhiteSpace($HttpsProxy)
    clashRouteManagementRequested = [bool]$manageClashRoute
    clashRouteRestoreSucceeded = if ($null -eq $clashRestoreSucceeded) { $null } else { [bool]$clashRestoreSucceeded }
    wranglerRoute = if ($wranglerCommand) { $wranglerCommand.Source } else { $null }
    stagePath = $stagePath
    stageFileCount = $stageFiles.Count
    functionsFileCount = $stageFunctionFiles.Count
    songAudioFileCount = $stagedAudioCount
    r2BindingPreserved = $true
    overlayedFiles = $overlayed
    excludedWorkingTreeChangeCount = $workingTreeStatus.Count
    wranglerVersion = $WranglerVersion
    configuredDeployAttempts = $DeployAttempts
    deploymentAttemptCount = $deploymentAttemptSummaries.Count
    deploymentAttempts = $deploymentAttemptSummaries
    onlineVerification = $onlineVerification
    deploymentOutput = $deploymentOutput
}
$resultJson = $result | ConvertTo-Json -Depth 6
Release-DeployLock
$resultJson
if ($operationFailed) {
    if ($NoProcessExit) { throw "Pages deployment operation failed with status '$status'." }
    exit 1
}
