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
$configText = Get-Content -LiteralPath $configPath -Raw
if ($configText -notmatch '(?m)^\s*pages_build_output_dir\s*=') { throw 'wrangler.toml has no pages_build_output_dir.' }
if ($configText -notmatch '(?m)^\s*\[\[r2_buckets\]\]') { throw 'wrangler.toml has no R2 binding; refusing deployment.' }

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
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
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
$previousHash = $null
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try { $previousHash = (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).contentHash } catch { $previousHash = $null }
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
                projectName = $ProjectName
                branch = $Branch
                commitHash = $head
                contentHash = $contentHash
                fileCount = $stageFiles.Count
            }
            [System.IO.File]::WriteAllText($statePath, (($state | ConvertTo-Json -Depth 4) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
        }
    }
}

$result = [ordered]@{
    ok = $status -ne 'deployment-failed'
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
    functionsFileCount = @(Get-ChildItem -LiteralPath (Join-Path $stagePath 'functions') -Recurse -File).Count
    r2BindingPreserved = $true
    overlayedFiles = $overlayed
    excludedWorkingTreeChangeCount = $workingTreeStatus.Count
    deploymentOutput = $deploymentOutput
}
$result | ConvertTo-Json -Depth 6
if ($status -eq 'deployment-failed') { exit 1 }
