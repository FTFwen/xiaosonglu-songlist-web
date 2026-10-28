#Requires -Version 5.1
<#
.SYNOPSIS
  Refresh the ECS local mirror that nginx serves viridis.love from.

.DESCRIPTION
  viridis.love resolves to the Aliyun ECS, and nginx serves pages, data and assets
  from /var/www/viridis-site instead of proxying to Cloudflare. That is deliberate:
  the ECS -> Cloudflare hop measures roughly 3 KB/s, far too slow to stream a
  1 MB data file or a 6 MB audio track, and it truncates responses halfway.

  Because of that, every deployment has to publish two places: Cloudflare Pages
  (the origin of record, also used by workshop.viridis.love) and this mirror.
  deploy_web.ps1 calls this script after a successful upload.

  Steps:
    1. sync_site_to_ecs.ps1  - HTML/JS/CSS/JSON, atomic swap, hash verified
    2. push_assets_to_ecs.ps1 - /assets (images + audio), only new files

.PARAMETER Root
  Repository root. Defaults to the parent of this script.

.PARAMETER SshKey
  Private key for ssh/scp. Defaults to ~/.ssh/viridis_aliyun.

.PARAMETER Target
  user@host of the ECS. Defaults to root@39.105.177.43.

.PARAMETER SkipAssets
  Only refresh text resources; leave /assets untouched.

.PARAMETER TimeoutMinutes
  Hard cap for each phase. Defaults to 30.
#>
param(
    [string]$Root = '',
    [string]$SshKey = '',
    [string]$Target = 'root@39.105.177.43',
    [switch]$SkipAssets,
    [int]$TimeoutMinutes = 30,
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not $SshKey) { $SshKey = Join-Path $env:USERPROFILE '.ssh\viridis_aliyun' }

$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$stage = Join-Path $Root '.wrangler\deploy-stage'
if (-not (Test-Path -LiteralPath $stage)) {
    throw "deploy stage missing: $stage (run deploy_web.ps1 once to populate it)"
}

function Write-Step { param([string]$Message) Write-Host "[ecs-mirror] $Message" }

function Invoke-Phase {
    param([string]$Name, [string]$Script, [string[]]$Arguments, [int]$Attempts = 3)
    Write-Step "--- $Name ---"
    $callArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Script) + $Arguments
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        & $powershellPath @callArgs | Out-Host
        if ($LASTEXITCODE -eq 0) {
            Write-Step "$Name ok"
            return
        }
        # A dropped ssh/scp connection must not be mistaken for a bad deploy: the
        # sequential verification gate compares against this mirror, so retry the
        # transport before giving up.
        if ($attempt -lt $Attempts) {
            $delay = [Math]::Min(30, 5 * $attempt)
            Write-Step "$Name failed with exit code $LASTEXITCODE; retrying in $delay seconds (attempt $attempt/$Attempts)"
            Start-Sleep -Seconds $delay
        }
    }
    throw "$Name failed after $Attempts attempts"
}

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$textScript = Join-Path $PSScriptRoot 'sync_site_to_ecs.ps1'
$assetScript = Join-Path $PSScriptRoot 'push_assets_to_ecs.ps1'

# sync_site_to_ecs.ps1 takes -Server / -SshUser, push_assets_to_ecs.ps1 takes -Target
$serverHost = $Target
$sshUser = 'root'
if ($Target.Contains('@')) {
    $parts = $Target.Split('@', 2)
    $sshUser = $parts[0]
    $serverHost = $parts[1]
}

Invoke-Phase -Name 'text mirror' -Script $textScript -Arguments @(
    '-Root', $Root,
    '-KeyPath', $SshKey,
    '-Server', $serverHost,
    '-SshUser', $sshUser
)

if (-not $SkipAssets) {
    $assetArguments = @(
        '-Root', $Root,
        '-RelativePath', 'assets',
        '-SshKey', $SshKey,
        '-Target', $Target,
        '-ChunkMegabytes', '48',
        '-Parallel', '6',
        '-SkipExisting',
        '-TimeoutMinutes', "$TimeoutMinutes"
    )
    if ($Verify) { $assetArguments += '-Verify' }
    Invoke-Phase -Name 'assets mirror' -Script $assetScript -Arguments $assetArguments

    # The main site also serves the workshop copy under /workshop, so its assets
    # need to exist locally too (workshop.viridis.love itself is served by Cloudflare).
    $workshopAssets = Join-Path $stage 'workshop\assets'
    if (Test-Path -LiteralPath $workshopAssets) {
        $workshopArguments = @(
            '-Root', $Root,
            '-RelativePath', 'workshop\assets',
            '-SshKey', $SshKey,
            '-Target', $Target,
            '-ChunkMegabytes', '48',
            '-Parallel', '4',
            '-SkipExisting',
            '-TimeoutMinutes', "$TimeoutMinutes"
        )
        Invoke-Phase -Name 'workshop assets mirror' -Script $assetScript -Arguments $workshopArguments
    }
}

Write-Step ("done in {0:N1}s" -f $stopwatch.Elapsed.TotalSeconds)
[ordered]@{
    ok = $true
    textMirrored = $true
    assetsMirrored = -not $SkipAssets
    elapsedSeconds = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
    stage = $stage
} | ConvertTo-Json -Compress
