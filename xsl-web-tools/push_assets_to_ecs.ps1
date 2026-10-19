#Requires -Version 5.1
<#
.SYNOPSIS
  Push a subtree of the deploy stage to the ECS web root in parallel chunks.

.DESCRIPTION
  The ECS -> Cloudflare link measured at roughly 3 KB/s, so anything the site
  needs must live on the ECS disk. This script ships files in size-bounded
  chunks over several concurrent scp processes, then extracts and verifies them
  on the server.

  It only ever touches the destination subtree it is given.

.PARAMETER Root
  Repository root. Defaults to the parent of this script.

.PARAMETER RelativePath
  Subtree to push, relative to the deploy stage. Defaults to 'assets'.

.PARAMETER SourcePath
  Explicit local source directory. When omitted the deploy stage is used.

.PARAMETER Destination
  Absolute destination directory on the server. Defaults to
  /var/www/viridis-site/<RelativePath>.

.PARAMETER ChunkMegabytes
  Soft size cap per shard. Defaults to 64.

.PARAMETER Parallel
  How many scp processes run at once. Defaults to 4.

.PARAMETER SshKey
  Private key used for scp/ssh.

.PARAMETER Target
  user@host for ssh/scp. Defaults to root@39.105.177.43.

.PARAMETER TimeoutMinutes
  Hard cap for the whole push. Defaults to 180.
#>
param(
    [string]$Root = '',
    [string]$RelativePath = 'assets',
    [string]$SourcePath = '',
    [string]$Destination = '',
    [int]$ChunkMegabytes = 64,
    [int]$Parallel = 4,
    [string]$SshKey = '',
    [string]$Target = 'root@39.105.177.43',
    [int]$TimeoutMinutes = 180,
    [string]$ExcludeUnder = '',
    [switch]$SkipExisting,
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not $SshKey) { $SshKey = Join-Path $env:USERPROFILE '.ssh\viridis_aliyun' }
if (-not $Destination) { $Destination = '/var/www/viridis-site/' + ($RelativePath -replace '\\', '/') }

if (-not $SourcePath) {
    $SourcePath = Join-Path $Root (Join-Path '.wrangler\deploy-stage' $RelativePath)
}
if (-not (Test-Path -LiteralPath $SourcePath)) {
    throw "source subtree not found: $SourcePath (run deploy_web.ps1 once to populate the stage)"
}

$scpExe = 'C:\Windows\System32\OpenSSH\scp.exe'
$sshExe = 'C:\Windows\System32\OpenSSH\ssh.exe'
$tarExe = 'C:\Windows\System32\tar.exe'
foreach ($exe in @($scpExe, $sshExe, $tarExe)) {
    if (-not (Test-Path -LiteralPath $exe)) { throw "required executable missing: $exe" }
}

function Write-Step { param([string]$Message) Write-Host "[push-assets] $Message" }

$sshArgs = @('-i', $SshKey, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new')

$sourceFull = (Resolve-Path -LiteralPath $SourcePath).Path.TrimEnd('\')
$files = @(Get-ChildItem -LiteralPath $sourceFull -Recurse -File | Sort-Object FullName)
if ($ExcludeUnder) {
    $excludePrefix = ($ExcludeUnder -replace '\\', '/').Trim('/') + '/'
    $files = @($files | Where-Object {
        $relative = ($_.FullName.Substring($sourceFull.Length + 1) -replace '\\', '/')
        -not $relative.StartsWith($excludePrefix, [System.StringComparison]::OrdinalIgnoreCase)
    })
}
if (-not $files) { throw "no files under $sourceFull" }

if ($SkipExisting) {
    # Audio files are content-versioned (song_315.m4a), so a daily run only adds a
    # handful of new files. Ask the server what it already has and ship the rest.
    $listing = @(& $sshExe @sshArgs $Target "find '$Destination' -type f -printf '%s %P\n' 2>/dev/null")
    if ($LASTEXITCODE -ne 0) { throw "failed to list remote files under $Destination" }
    $remoteSizes = @{}
    foreach ($line in $listing) {
        if (-not $line) { continue }
        $split = $line.IndexOf(' ')
        if ($split -lt 1) { continue }
        $remoteSizes[$line.Substring($split + 1).Trim()] = [int64]$line.Substring(0, $split)
    }
    $before = $files.Count
    $files = @($files | Where-Object {
        $relative = ($_.FullName.Substring($sourceFull.Length + 1) -replace '\\', '/')
        -not ($remoteSizes.ContainsKey($relative) -and $remoteSizes[$relative] -eq $_.Length)
    })
    Write-Step ("skip-existing: {0} of {1} files already present; {2} to send" -f ($before - $files.Count), $before, $files.Count)
    if (-not $files) {
        Write-Step "nothing to do"
        Write-Output '{"ok":true,"skipped":true,"uploaded":0}'
        return
    }
}

$totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
Write-Step ("source: {0} files / {1:N1} MB" -f $files.Count, ($totalBytes / 1MB))
Write-Step "destination: $Destination"

# --- shard by cumulative size so parallel transfers finish about together ---
$chunkBytes = [int64]$ChunkMegabytes * 1MB
$shards = New-Object System.Collections.ArrayList
$current = New-Object System.Collections.ArrayList
$currentBytes = [int64]0
foreach ($file in $files) {
    if ($current.Count -gt 0 -and ($currentBytes + $file.Length) -gt $chunkBytes) {
        [void]$shards.Add(@{ Files = $current.ToArray(); Bytes = $currentBytes })
        $current = New-Object System.Collections.ArrayList
        $currentBytes = [int64]0
    }
    [void]$current.Add($file)
    $currentBytes += $file.Length
}
if ($current.Count -gt 0) { [void]$shards.Add(@{ Files = $current.ToArray(); Bytes = $currentBytes }) }
Write-Step ("shards: {0} x up to {1} MB" -f $shards.Count, $ChunkMegabytes)

$work = Join-Path $env:TEMP ('xsl-push-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

try {
    # --- prepare remote staging area ---
    $remoteStage = "/tmp/xsl-push-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    & $sshExe @sshArgs $Target "mkdir -p '$remoteStage' '$Destination'" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "failed to prepare remote staging directory" }

    $index = 0
    foreach ($shard in $shards) {
        if ((Get-Date) -gt $deadline) { throw "push exceeded TimeoutMinutes=$TimeoutMinutes" }
        $index++
        $name = 'shard{0:D3}' -f $index
        $archive = Join-Path $work ($name + '.tar')

        # archive relative to the source root so extraction rebuilds the subtree
        $relative = @($shard.Files | ForEach-Object { $_.FullName.Substring($sourceFull.Length + 1) })
        $listFile = Join-Path $work ($name + '.txt')
        Set-Content -LiteralPath $listFile -Value $relative -Encoding ASCII
        & $tarExe -cf $archive -C $sourceFull -T $listFile
        if ($LASTEXITCODE -ne 0) { throw "tar failed for $name" }

        $shard | Add-Member -NotePropertyName Archive -NotePropertyValue $archive -Force
        $shard | Add-Member -NotePropertyName Name -NotePropertyValue $name -Force
        Write-Step ("{0}: {1} files / {2:N1} MB" -f $name, $shard.Files.Count, ($shard.Bytes / 1MB))
    }

    # --- upload in waves ---
    $waveStart = 0
    $uploaded = 0
    while ($waveStart -lt $shards.Count) {
        if ((Get-Date) -gt $deadline) { throw "push exceeded TimeoutMinutes=$TimeoutMinutes" }
        $wave = @($shards[$waveStart..([math]::Min($waveStart + $Parallel - 1, $shards.Count - 1))])
        $running = @()
        foreach ($shard in $wave) {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $scpExe
            $psi.Arguments = (($sshArgs + @($shard.Archive, "${Target}:$remoteStage/$($shard.Name).tar")) |
                ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $running += [System.Diagnostics.Process]::Start($psi)
        }
        $failed = @()
        foreach ($process in $running) {
            $process.WaitForExit()
            if ($process.ExitCode -ne 0) { $failed += ("$($process.StartInfo.Arguments) -> exit $($process.ExitCode)") }
            $process.Dispose()
        }
        if ($failed.Count -gt 0) { throw ("scp failed: " + ($failed -join '; ')) }
        $uploaded += $wave.Count
        $doneBytes = ($shards[0..($uploaded - 1)] | ForEach-Object { [int64]$_.Bytes } | Measure-Object -Sum).Sum
        $rate = if ($stopwatch.Elapsed.TotalSeconds -gt 0) { $doneBytes / 1MB / $stopwatch.Elapsed.TotalSeconds } else { 0 }
        Write-Step ("uploaded {0}/{1} shards ({2:N1} MB/s so far)" -f $uploaded, $shards.Count, $rate)
        $waveStart += $Parallel
    }

    # --- extract remotely ---
    $extract = "set -e; cd '$Destination'; for f in '$remoteStage'/*.tar; do tar -xf `"`$f`" -C '$Destination'; done; rm -rf '$remoteStage'; find '$Destination' -type f | wc -l"
    $remoteCount = (& $sshExe @sshArgs $Target $extract | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0) { throw "remote extraction failed" }
    Write-Step "remote file count: $remoteCount"

    if ($Verify) {
        $mismatch = 0
        $sample = @($files | Get-Random -Count ([math]::Min(8, $files.Count)))
        foreach ($file in $sample) {
            $rel = $file.FullName.Substring($sourceFull.Length + 1) -replace '\\', '/'
            $remote = (& $sshExe @sshArgs $Target "sha256sum '$Destination/$rel' 2>/dev/null | cut -d' ' -f1") | Select-Object -Last 1
            $local = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            if ("$remote".Trim() -ne $local) {
                Write-Step "MISMATCH $rel"
                $mismatch++
            }
        }
        if ($mismatch -gt 0) { throw "$mismatch sampled files did not match" }
        Write-Step "sampled $($sample.Count) files: all hashes match"
    }

    Write-Step ("done in {0:N1}s" -f $stopwatch.Elapsed.TotalSeconds)
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
