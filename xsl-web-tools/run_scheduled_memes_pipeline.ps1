[CmdletBinding()]
param(
    [string]$Root,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path
$git = (Get-Command git -ErrorAction Stop).Source
$node = (Get-Command node -ErrorAction Stop).Source
$payload = @('memes/seed.json', 'memes/danmaku-stats.json')
# Share the song pipeline lock because both routines publish from the same workspace.
$lockPath = Join-Path $rootPath 'data\xiaosonglu\_daily_pipeline.lock'
$deadline = (Get-Date).AddMinutes(25)
$lock = $null
while (-not $lock) {
    try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] {
        if ((Get-Date) -ge $deadline) { throw 'Timed out waiting for the site pipeline lock.' }
        Start-Sleep -Seconds 15
    }
}
Push-Location -LiteralPath $rootPath
try {
    if ($CheckOnly) {
        & $node --check scripts/sync_live_memes.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Meme sync syntax check failed.' }
        return
    }
    $branch = & $git branch --show-current
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw 'The live meme pipeline requires the main branch.' }
    & $git fetch origin main
    if ($LASTEXITCODE -ne 0) { throw 'Git fetch failed.' }
    & $git merge --ff-only origin/main
    if ($LASTEXITCODE -ne 0) { throw 'Git fast-forward failed.' }

    & $node scripts/sync_live_memes.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Live meme sync failed.' }
    & $node --test scripts/tests/live_memes_sync.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Live meme sync checks failed.' }
    $changes = @(& $git status --porcelain -- @payload)
    if ($LASTEXITCODE -ne 0) { throw 'Could not check generated meme data.' }
    if ($changes.Count) {
        & $git add -- @payload
        if ($LASTEXITCODE -ne 0) { throw 'Could not stage generated meme data.' }
        & $git commit --only -m 'Update live meme archive and danmaku counts' -- @payload
        if ($LASTEXITCODE -ne 0) { throw 'Could not commit generated meme data.' }
    }
    # A prior run may have committed locally and stopped before deploy or push.
    $ahead = & $git rev-list --count origin/main..HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not compare release branch with GitHub.' }
    if ([int]$ahead -eq 0) { Write-Output 'No live meme release changes.'; return }

    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'deploy_web.ps1') -Root $rootPath -Deploy -AllowOAuth -VerifyBaseUrl 'https://viridis.love'
    if ($LASTEXITCODE -ne 0) { throw 'Website deployment failed.' }
    $state = Get-Content -LiteralPath 'data/xiaosonglu/_deploy_state.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $head = & $git rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $state.commitHash -ne $head -or -not $state.onlineVerification.ok) {
        throw 'The deploy state does not confirm that this release is online.'
    }
    & $git push origin main
    if ($LASTEXITCODE -ne 0) { throw 'Website deployed, but Git push failed.' }
} finally {
    Pop-Location
    $lock.Dispose()
}
