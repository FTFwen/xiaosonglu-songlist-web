[CmdletBinding()]
param(
    [switch]$Deploy,
    [switch]$Force,
    [switch]$AllowOAuth,
    [string]$ProjectName = 'xsl-songlist',
    [string]$Branch = 'main',
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path $Root).Path
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
    if ($rawPath -notmatch '^assets/audio/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a(?:\?[^#]*)?$') { throw "Unsafe audio path in audio_index.json: $rawPath" }
    $audioRelativePaths += $rawPath.Split('?')[0].Replace('/', '\')
}
$audioRelativePaths = @($audioRelativePaths | Sort-Object -Unique)
if ($audioRelativePaths.Count -ne $audioProperties.Count) { throw 'audio_index.json contains duplicate or colliding audio targets.' }
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
$overlayRelativePaths = @(
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
    'workshop\data\xiaosonglu\audio_index.json',
    'workshop\data\xiaosonglu\history_index.json',
    'workshop\data\xiaosonglu\song_catalog.json',
    'workshop\data\xiaosonglu\song_cut_info.json',
    'workshop\data\xiaosonglu\song_details.json',
    'workshop\js\data.js'
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

# Defense in depth: downloaded videos and transient review files can never enter the stage.
$blockedDirectories = @(
    'assets\video', 'assets\videos', 'data\xiaosonglu\videos',
    'scripts', 'xsl-web-tools', 'tools'
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
$accountScope = if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_ACCOUNT_ID)) { 'wrangler-oauth-default' } else { $env:CLOUDFLARE_ACCOUNT_ID }
$previousHash = $null
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try {
        $previousState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($previousState.accountScope -eq $accountScope -and $previousState.projectName -eq $ProjectName -and $previousState.branch -eq $Branch) { $previousHash = $previousState.contentHash }
    } catch { $previousHash = $null }
}
$contentChanged = $Force -or ($contentHash -ne $previousHash)
$hasExplicitCredentials = -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN) -and -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_ACCOUNT_ID)
$hasCredentials = $hasExplicitCredentials -or $AllowOAuth

$wranglerCommand = Get-Command wrangler.cmd -ErrorAction SilentlyContinue
$wranglerPrefix = @()
if (-not $wranglerCommand) { $wranglerCommand = Get-Command wrangler -ErrorAction SilentlyContinue }
if (-not $wranglerCommand) {
    $wranglerCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if (-not $wranglerCommand) { $wranglerCommand = Get-Command npx -ErrorAction SilentlyContinue }
    if ($wranglerCommand) { $wranglerPrefix = @('--yes', 'wrangler@latest') }
}

$status = 'preflight-only'
$deploymentOutput = @()
if ($Deploy) {
    if (-not $hasCredentials) { $status = 'skipped-missing-credentials' }
    elseif (-not $wranglerCommand) { $status = 'skipped-missing-wrangler' }
    elseif (-not $contentChanged) { $status = 'skipped-no-content-change' }
    else {
        $arguments = @() + $wranglerPrefix + @(
            'pages', 'deploy', '.',
            '--project-name', $ProjectName,
            '--branch', $Branch,
            '--commit-hash', $head,
            '--commit-dirty=true'
        )
        Push-Location $stagePath
        try {
            $deploymentOutput = @(& $wranglerCommand.Source @arguments 2>&1 | ForEach-Object { $_.ToString() })
            $exitCode = $LASTEXITCODE
        } finally { Pop-Location }
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
    hasCloudflareCredentials = [bool]$hasExplicitCredentials
    cloudflareAuthMode = if ($hasExplicitCredentials) { 'environment' } elseif ($AllowOAuth) { 'wrangler-oauth' } else { 'none' }
    wranglerRoute = if ($wranglerCommand) { $wranglerCommand.Source } else { $null }
    stagePath = $stagePath
    stageFileCount = $stageFiles.Count
    functionsFileCount = $stageFunctionFiles.Count
    songAudioFileCount = $stagedAudioCount
    r2BindingPreserved = $true
    overlayedFiles = $overlayed
    excludedWorkingTreeChangeCount = $workingTreeStatus.Count
    deploymentOutput = $deploymentOutput
}
$result | ConvertTo-Json -Depth 6
if ($operationFailed) { exit 1 }
