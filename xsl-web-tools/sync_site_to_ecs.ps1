#Requires -Version 5.1
<#
.SYNOPSIS
Push the public static payload of this workspace to the Aliyun ECS that fronts viridis.love.

.DESCRIPTION
Why this exists (2026-10-19):
  The ECS -> Cloudflare Pages origin link is unreliable for anything but tiny files:
  TLS handshakes time out, and 170KB / 1MB responses routinely die half way. That made
  cold cache misses on viridis.love return truncated HTML/JS/JSON. Cloudflare stays the
  origin of record for /assets (audio, images: versioned, cached 30 days on the ECS), but
  the text payload (HTML/JS/CSS/data JSON: ~8 MB, 78 files) is now served from the ECS
  local disk, so domestic visitors never depend on that flaky hop.

How it works:
  1. reads the deploy staging tree produced by xsl-web-tools/deploy_web.ps1
     (.wrangler/deploy-stage) so we mirror exactly what went public, nothing more;
  2. skips /assets (stays on Cloudflare + nginx cache), dot files, Cloudflare-only
     plumbing (_headers/_redirects/_routes.json/wrangler.toml/functions);
  3. packs a tar.gz, copies it to the ECS, extracts next to the live tree, then swaps
     directories atomically (rename both sides) so visitors never see a half-written site;
  4. verifies a sample of files by SHA-256 on both ends and fails loudly on mismatch.

.PARAMETER Root
Workspace root. Defaults to the parent of this script's folder.

.PARAMETER KeyPath
Private key used for root@<Server>.

.PARAMETER Server
SSH target host (IP or DNS name).

.PARAMETER RemoteRoot
Absolute directory on the server that nginx serves as the site root.

.PARAMETER SkipVerify
Skip the post-sync SHA-256 cross-check (not recommended).

.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File xsl-web-tools\sync_site_to_ecs.ps1

.NOTES
Exit codes: 0 = synced and verified, 1 = packed/copied but verification failed,
            2 = prerequisite missing (no deploy stage), 3 = transport failure.
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$KeyPath = 'C:\Users\Taihexiongdi251215\.ssh\viridis_aliyun',
    [string]$Server = '39.105.177.43',
    [string]$RemoteRoot = '/var/www/viridis-site',
    [string]$SshUser = 'root',
    [int]$CopyAttempts = 4,
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$Message) Write-Host "[sync-site] $Message" }

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path (Join-Path $Root 'index.html'))) { throw "Root does not look like the site workspace: $Root" }
if (-not (Test-Path $KeyPath)) { throw "SSH key not found: $KeyPath" }

$stage = Join-Path $Root '.wrangler\deploy-stage'
if (-not (Test-Path (Join-Path $stage 'index.html'))) {
    Write-Step "deploy stage missing ($stage). Run deploy_web.ps1 first."
    exit 2
}

$sshExe = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$scpExe = Join-Path $env:SystemRoot 'System32\OpenSSH\scp.exe'
foreach ($exe in @($sshExe, $scpExe)) { if (-not (Test-Path $exe)) { throw "OpenSSH client missing: $exe" } }

$sshTarget = "$SshUser@$Server"
$sshArgs = @('-i', $KeyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new')

# ---------------------------------------------------------------- build payload
$excludedTop = @('assets', 'functions')
$excludedFiles = @('_headers', '_redirects', '_routes.json', 'wrangler.toml')

$harvest = Join-Path $env:TEMP ("xsl-site-{0}" -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
New-Item -ItemType Directory -Path $harvest -Force | Out-Null
$archive = Join-Path $env:TEMP ("xsl-site-{0}.tar.gz" -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss'))

try {
    $files = Get-ChildItem -Path $stage -Recurse -File |
        Where-Object {
            $rel = $_.FullName.Substring($stage.Length).TrimStart('\')
            $top = ($rel -split '\\')[0]
            if ($excludedTop -contains $top) { return $false }
            if ($excludedFiles -contains $rel) { return $false }
            if ($top.StartsWith('.')) { return $false }
            if ($rel.StartsWith('_')) { return $false }
            return $true
        }

    if (-not $files -or $files.Count -lt 10) { throw "refusing to sync an implausibly small payload ($(@($files).Count) files)" }

    $totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
    Write-Step ("payload: {0} files / {1:N0} bytes" -f @($files).Count, $totalBytes)

    foreach ($file in $files) {
        $rel = $file.FullName.Substring($stage.Length).TrimStart('\')
        $dest = Join-Path $harvest $rel
        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        Copy-Item -LiteralPath $file.FullName -Destination $dest -Force
    }

    $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path $tarExe)) { $tarExe = 'tar.exe' }
    & $tarExe -czf $archive -C $harvest . 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
    $archiveBytes = (Get-Item $archive).Length
    Write-Step ("archive: {0:N0} bytes -> {1}" -f $archiveBytes, $archive)

    # ------------------------------------------------------------ copy with retry
    $remoteArchive = "/tmp/xsl-site-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmss')).tar.gz"
    $copied = $false
    for ($attempt = 1; $attempt -le $CopyAttempts; $attempt++) {
        Write-Step "scp attempt $attempt/$CopyAttempts"
        & $scpExe @sshArgs $archive "${sshTarget}:$remoteArchive" 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $copied = $true; break }
        Start-Sleep -Seconds ([Math]::Min(30, 5 * $attempt))
    }
    if (-not $copied) { Write-Step 'scp failed for every attempt'; exit 3 }

    # --------------------------------------------------------------- remote swap
    $remoteScript = @'
set -eu
ARCHIVE="$1"
DEST="$2"
STAGING="$DEST.new"
PREV="$DEST.prev"
rm -rf "$STAGING"
mkdir -p "$STAGING"
tar -xzf "$ARCHIVE" -C "$STAGING"
if [ ! -f "$STAGING/index.html" ]; then
  echo "extracted tree has no index.html" >&2
  exit 1
fi
FILE_COUNT=$(find "$STAGING" -type f | wc -l)
# /assets never travels in this archive (it is hundreds of MB of audio, pushed
# incrementally by push_assets_to_ecs.ps1). Carry the live copy across the swap
# with hardlinks, otherwise the atomic swap would leave the site without audio
# and images until the next asset push.
if [ -d "$DEST/assets" ]; then
  cp -al "$DEST/assets" "$STAGING/assets"
fi
rm -rf "$PREV"
if [ -d "$DEST" ]; then mv "$DEST" "$PREV"; fi
mv "$STAGING" "$DEST"
rm -f "$ARCHIVE"
echo "swapped $FILE_COUNT files into $DEST"
'@
    $remoteScript = $remoteScript -replace "`r`n", "`n"
    $remoteScriptPath = Join-Path $env:TEMP ("xsl-site-remote-{0}.sh" -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
    [System.IO.File]::WriteAllText($remoteScriptPath, $remoteScript, (New-Object System.Text.UTF8Encoding($false)))

    $burst = Get-Content -LiteralPath $remoteScriptPath -Raw
    $burstRemote = "/tmp/xsl-site-remote-$([guid]::NewGuid().ToString('N').Substring(0,8)).sh"
    & $scpExe @sshArgs $remoteScriptPath "${sshTarget}:$burstRemote" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Step 'failed to upload the remote swap script'; exit 3 }

    $swapOutput = & $sshExe @sshArgs $sshTarget "sed -i 's/\r$//' $burstRemote; bash $burstRemote '$remoteArchive' '$RemoteRoot'" 2>&1
    $swapExit = $LASTEXITCODE
    $swapOutput | ForEach-Object { Write-Step "remote: $_" }
    if ($swapExit -ne 0) { Write-Step "remote swap failed (exit $swapExit)"; exit 3 }

    if ($SkipVerify) { Write-Step 'verification skipped'; exit 0 }

    # --------------------------------------------------------------- verify sample
    $sample = @('index.html', 'js/app.js', 'js/data.js', 'data/xiaosonglu/song_catalog.json')
    $sample += @($files | Where-Object { $_.FullName -match '\\workshop\\' } | Select-Object -First 1 | ForEach-Object { $_.FullName.Substring($stage.Length).TrimStart('\').Replace('\','/') })
    $sample = $sample | Select-Object -Unique

    $mismatches = @()
    foreach ($rel in $sample) {
        $localPath = Join-Path $harvest ($rel -replace '/', '\')
        if (-not (Test-Path $localPath)) { continue }
        $localHash = (Get-FileHash -LiteralPath $localPath -Algorithm SHA256).Hash.ToLower()
        $remoteHash = (& $sshExe @sshArgs $sshTarget "sha256sum '$RemoteRoot/$rel' 2>/dev/null | cut -d' ' -f1") -join ''
        $remoteHash = $remoteHash.Trim().ToLower()
        if ($localHash -ne $remoteHash) {
            $mismatches += "$rel local=$localHash remote=$remoteHash"
        } else {
            Write-Step "verified $rel"
        }
    }

    if ($mismatches.Count -gt 0) {
        $mismatches | ForEach-Object { Write-Step "MISMATCH $_" }
        exit 1
    }

    Write-Step 'sync complete and verified'
    exit 0
}
finally {
    if (Test-Path $harvest) { Remove-Item -LiteralPath $harvest -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
    if ($remoteScriptPath -and (Test-Path $remoteScriptPath)) { Remove-Item -LiteralPath $remoteScriptPath -Force -ErrorAction SilentlyContinue }
}
