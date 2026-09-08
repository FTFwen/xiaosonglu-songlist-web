[CmdletBinding()]
param(
    [switch]$Deploy,
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path $Root).Path
$node = (Get-Command node -ErrorAction Stop).Source
$python = (Get-Command python -ErrorAction Stop).Source
$git = (Get-Command git -ErrorAction Stop).Source

function Assert-ExitCode {
    param([int]$Code, [int[]]$Allowed, [string]$Step)
    if ($Allowed -notcontains $Code) { throw "$Step failed with exit code $Code" }
}

function Get-PipelineHashes {
    $relativePaths = @(
        'data\xiaosonglu\audio_index.json',
        'data\xiaosonglu\history_index.json',
        'data\xiaosonglu\replay_song_segments.json',
        'data\xiaosonglu\song_catalog.json',
        'data\xiaosonglu\song_cut_index.json',
        'data\xiaosonglu\song_cut_info.json',
        'data\xiaosonglu\song_cut_table.csv',
        'data\xiaosonglu\song_details.json',
        'data\xiaosonglu\song_metadata_overrides.json',
        'js\data.js',
        'workshop\data\xiaosonglu\song_catalog.json',
        'workshop\data\xiaosonglu\history_index.json',
        'workshop\data\xiaosonglu\song_details.json',
        'workshop\data\xiaosonglu\song_cut_info.json',
        'workshop\data\xiaosonglu\audio_index.json',
        'workshop\js\data.js'
    )
    $hashes = [ordered]@{}
    foreach ($relative in $relativePaths) {
        $path = Join-Path $rootPath $relative
        $hashes[$relative.Replace('\', '/')] = if (Test-Path -LiteralPath $path -PathType Leaf) {
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        } else { $null }
    }
    $audioIndexPath = Join-Path $rootPath 'data\xiaosonglu\audio_index.json'
    if (Test-Path -LiteralPath $audioIndexPath -PathType Leaf) {
        $audioIndex = Get-Content -LiteralPath $audioIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($value in @($audioIndex.audios.PSObject.Properties.Value | Sort-Object -Unique)) {
            $rawPath = [string]$value
            if ($rawPath -notmatch '^assets/audio/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a(?:\?[^#]*)?$') { throw "Unsafe audio path in audio_index.json: $rawPath" }
            $relative = $rawPath.Split('?')[0].Replace('/', '\')
            $path = Join-Path $rootPath $relative
            $hashes[$relative.Replace('\', '/')] = if (Test-Path -LiteralPath $path -PathType Leaf) {
                (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            } else { $null }
        }
    }
    return $hashes
}

Push-Location $rootPath
try {
    $startingStatus = @(& $git status --short)
    Assert-ExitCode $LASTEXITCODE @(0) 'initial git status'
    $trackedVideos = @(& $git ls-files | Where-Object {
        $_ -match '(^|/)(video|videos)/' -or $_ -match '\.(mp4|webm|mkv|mov|flv)$' -or $_ -match '(^|/)(video|videos)/.*\.ts$'
    })
    Assert-ExitCode $LASTEXITCODE @(0) 'tracked-video audit'
    if ($trackedVideos.Count -gt 0) { throw "Tracked video assets detected: $($trackedVideos -join ', ')" }

    $before = Get-PipelineHashes

    $audioSourceBase = if ([string]::IsNullOrWhiteSpace($env:XSL_AUDIO_BASE_URL)) { 'https://viridis.love/' } else { $env:XSL_AUDIO_BASE_URL }
    & $python 'tools/sync_song_audio_assets.py' '--source-base' $audioSourceBase '--quiet'
    Assert-ExitCode $LASTEXITCODE @(0) 'song audio baseline sync'

    & $python 'tools/sync_viridis_baseline.py'
    $baselineExit = $LASTEXITCODE
    # Exit 2 means a local, content-hash divergence was preserved; it must never trigger a remote overwrite.
    Assert-ExitCode $baselineExit @(0, 2) 'remote baseline conditional sync'

    & $node 'scripts/scan_unrecorded_lives.mjs' '--write'
    $scanExit = $LASTEXITCODE
    Assert-ExitCode $scanExit @(0, 3) 'live scan'
    $pendingReview = $scanExit -eq 3

    & $node 'scripts/build_xiaosonglu_song_data.mjs' '--write'
    Assert-ExitCode $LASTEXITCODE @(0) 'song data build'
    & $node 'scripts/build_xiaosonglu_song_data.mjs' '--check'
    Assert-ExitCode $LASTEXITCODE @(0) 'song data idempotency check'
    & $node 'scripts/validate_song_data.mjs'
    Assert-ExitCode $LASTEXITCODE @(0) 'song data validation'
    & $node '--test' '--test-isolation=none' 'scripts/tests/song_pipeline.test.mjs'
    Assert-ExitCode $LASTEXITCODE @(0) 'song pipeline tests'

    & (Join-Path $PSScriptRoot 'sync_workspace_data.ps1') -Apply | Out-Host
    Assert-ExitCode $LASTEXITCODE @(0) 'workspace data sync'
    & (Join-Path $PSScriptRoot 'sync_workspace_data.ps1') -Check | Out-Host
    Assert-ExitCode $LASTEXITCODE @(0) 'workspace data sync check'

    $after = Get-PipelineHashes
    $changedFiles = @()
    $allHashKeys = @(@($before.Keys) + @($after.Keys) | Sort-Object -Unique)
    foreach ($key in $allHashKeys) {
        if ($before[$key] -ne $after[$key]) { $changedFiles += $key }
    }

    $deployArguments = @()
    if ($Deploy -and -not $pendingReview) { $deployArguments += '-Deploy' }
    $deployText = (& (Join-Path $PSScriptRoot 'deploy_web.ps1') @deployArguments | Out-String).Trim()
    Assert-ExitCode $LASTEXITCODE @(0) 'deployment preflight/operation'
    $deployResult = $deployText | ConvertFrom-Json

    $endingStatus = @(& $git status --short)
    Assert-ExitCode $LASTEXITCODE @(0) 'final git status'
    $trackedVideosAfter = @(& $git ls-files | Where-Object {
        $_ -match '(^|/)(video|videos)/' -or $_ -match '\.(mp4|webm|mkv|mov|flv)$' -or $_ -match '(^|/)(video|videos)/.*\.ts$'
    })
    if ($trackedVideosAfter.Count -gt 0) { throw "Tracked video assets appeared during the run: $($trackedVideosAfter -join ', ')" }

    [ordered]@{
        ok = $true
        status = if ($pendingReview) { 'review-needed' } else { 'complete' }
        baselineExitCode = $baselineExit
        baselineStatus = if ($baselineExit -eq 2) { 'local-divergence-preserved' } else { 'in-sync' }
        scanExitCode = $scanExit
        pipelineDataChanged = $changedFiles.Count -gt 0
        changedPipelineFiles = $changedFiles
        deployRequested = [bool]$Deploy
        deployStatus = $deployResult.status
        trackedVideoCountBefore = $trackedVideos.Count
        trackedVideoCountAfter = $trackedVideosAfter.Count
        startingWorkingTreeChangeCount = $startingStatus.Count
        endingWorkingTreeChangeCount = $endingStatus.Count
    } | ConvertTo-Json -Depth 5
} finally {
    Pop-Location
}
