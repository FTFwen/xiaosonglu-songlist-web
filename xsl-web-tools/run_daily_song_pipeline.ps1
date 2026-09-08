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
        'data\xiaosonglu\song_catalog.json',
        'data\xiaosonglu\history_index.json',
        'data\xiaosonglu\song_details.json',
        'data\xiaosonglu\song_cut_info.json',
        'data\xiaosonglu\song_cut_table.csv',
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

    & $python 'tools/sync_viridis_baseline.py'
    $baselineExit = $LASTEXITCODE
    # Exit 2 means a local, content-hash divergence was preserved; it must never trigger a remote overwrite.
    Assert-ExitCode $baselineExit @(0, 2) 'remote baseline conditional sync'

    $before = Get-PipelineHashes

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
    foreach ($key in $after.Keys) {
        if ($before[$key] -ne $after[$key]) { $changedFiles += $key }
    }

    $deployArguments = @()
    if ($Deploy -and -not $pendingReview -and $changedFiles.Count -gt 0) { $deployArguments += '-Deploy' }
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
