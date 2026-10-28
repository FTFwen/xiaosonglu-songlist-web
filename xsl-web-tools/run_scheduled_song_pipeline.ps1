[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$HttpsProxy = '',
    [string]$ClashController = '',
    [string]$ClashProxyGroup = '',
    [string]$ClashProxyChoice = '',
    [switch]$DownloadSongCutAudio,
    [string]$CuratedSongBatch = '',
    [string]$SongCutSourceDir = '',
    [string]$BilibiliCookieFile = '',
    [ValidateRange(1, 90)]
    [int]$LogRetentionDays = 30
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 resolves $PSScriptRoot to an empty string inside a param()
# default expression, so the root has to be resolved here in the script body.
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path $Root).Path
$pipelinePath = Join-Path $PSScriptRoot 'run_daily_song_pipeline.ps1'
if (-not (Test-Path -LiteralPath $pipelinePath -PathType Leaf)) {
    throw 'The daily song pipeline script is missing.'
}

$logRoot = Join-Path $rootPath 'data\xiaosonglu\_automation_logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$startedAt = [DateTime]::UtcNow
$stamp = $startedAt.ToString('yyyyMMddTHHmmssZ')
$logPath = Join-Path $logRoot "daily-$stamp.log"
$statusPath = Join-Path $rootPath 'data\xiaosonglu\_automation_status.json'
$output = New-Object System.Collections.Generic.List[string]
$exitCode = 0
$errorSummary = $null
$pipelineExitCode = $null
$pipelineStatus = $null

function Quote-ChildArgument {
    param([string]$Value)
    if ($Value -match '["\r\n]') { throw 'Scheduled child arguments must not contain quotes or newlines.' }
    if ($Value.Length -eq 0 -or $Value -match '\s') { return '"' + $Value + '"' }
    return $Value
}

$parameters = @{
    Root = $rootPath
    Deploy = $true
    AllowOAuth = $true
}
if (-not [string]::IsNullOrWhiteSpace($HttpsProxy)) { $parameters.HttpsProxy = $HttpsProxy }
if (-not [string]::IsNullOrWhiteSpace($ClashController)) { $parameters.ClashController = $ClashController }
if (-not [string]::IsNullOrWhiteSpace($ClashProxyGroup)) { $parameters.ClashProxyGroup = $ClashProxyGroup }
if (-not [string]::IsNullOrWhiteSpace($ClashProxyChoice)) { $parameters.ClashProxyChoice = $ClashProxyChoice }
if ($DownloadSongCutAudio) { $parameters.DownloadSongCutAudio = $true }
if (-not [string]::IsNullOrWhiteSpace($CuratedSongBatch)) { $parameters.CuratedSongBatch = $CuratedSongBatch }
if (-not [string]::IsNullOrWhiteSpace($SongCutSourceDir)) { $parameters.SongCutSourceDir = $SongCutSourceDir }
if (-not [string]::IsNullOrWhiteSpace($BilibiliCookieFile)) { $parameters.BilibiliCookieFile = $BilibiliCookieFile }

$childStdoutPath = Join-Path $env:TEMP "xsl-daily-$PID.out"
$childStderrPath = Join-Path $env:TEMP "xsl-daily-$PID.err"
try {
    $output.Add("startedAt=$($startedAt.ToString('o'))")
    $output.Add('mode=scheduled-daily-static-pages')
    # Newest-performance audio: an indexed track whose song was sung again gets
    # the newest cut audio before the build, so one deployed snapshot always
    # carries the latest performance (no archive copy of the old cut is kept).
    # Failure here is reported but never blocks the data pipeline: the build and
    # validation steps that follow reject any half-applied audio change.
    $audioSyncScript = Join-Path $rootPath 'tools\sync_latest_performance_audio.py'
    if (Test-Path -LiteralPath $audioSyncScript) {
        $syncStdout = Join-Path $env:TEMP "xsl-audio-sync-$PID.out"
        $syncStderr = Join-Path $env:TEMP "xsl-audio-sync-$PID.err"
        try {
            $syncArgs = @($audioSyncScript, '--root', $rootPath)
            # Cookie file only feeds the audio download; keeping it out of the
            # child pipeline arguments avoids tripping the "song-cut paths
            # require an ingest/download switch" guard inside run_daily.
            $syncCookie = $BilibiliCookieFile
            if ([string]::IsNullOrWhiteSpace($syncCookie)) { $syncCookie = $env:XSL_BILIBILI_COOKIE_FILE }
            if (-not [string]::IsNullOrWhiteSpace($syncCookie)) { $syncArgs += @('--cookies-file', $syncCookie) }
            $syncChild = Start-Process -FilePath 'python.exe' `
                -ArgumentList (($syncArgs | ForEach-Object { Quote-ChildArgument ([string]$_) }) -join ' ') `
                -WorkingDirectory $rootPath -RedirectStandardOutput $syncStdout -RedirectStandardError $syncStderr -Wait -PassThru
            $syncLines = if (Test-Path -LiteralPath $syncStdout) { [IO.File]::ReadAllLines($syncStdout, [Text.Encoding]::UTF8) } else { @() }
            $syncErrLines = if (Test-Path -LiteralPath $syncStderr) { [IO.File]::ReadAllLines($syncStderr, [Text.Encoding]::UTF8) } else { @() }
            foreach ($line in $syncLines) { if (-not [string]::IsNullOrWhiteSpace($line)) { $output.Add("[audio-sync] $line") } }
            foreach ($line in $syncErrLines) { if (-not [string]::IsNullOrWhiteSpace($line)) { $output.Add("[audio-sync] [stderr] $line") } }
            if ([int]$syncChild.ExitCode -ne 0) { $output.Add("[audio-sync] WARNING: audio replacement exited with code $($syncChild.ExitCode)") }
        } catch {
            $output.Add("[audio-sync] WARNING: could not run audio replacement: $($_.Exception.Message)")
        } finally {
            foreach ($path in @($syncStdout, $syncStderr)) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue } }
        }
    } else {
        $output.Add('[audio-sync] skipped: tools/sync_latest_performance_audio.py is missing')
    }
    # Run the pipeline in a separate PowerShell process and keep stdout/stderr
    # separate. The pipeline intentionally emits native Node checkpoint messages
    # on stderr; merging that stream inside Windows PowerShell with ErrorAction=Stop
    # would turn harmless progress into a terminating ErrorRecord.
    $childArgs = New-Object System.Collections.Generic.List[string]
    @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      (Quote-ChildArgument $pipelinePath)) | ForEach-Object { $childArgs.Add($_) }
    foreach ($entry in $parameters.GetEnumerator()) {
        if ($entry.Value -is [bool]) {
            if ($entry.Value) { $childArgs.Add("-$($entry.Key)") }
        } elseif ($null -ne $entry.Value) {
            $childArgs.Add("-$($entry.Key)")
            $childArgs.Add((Quote-ChildArgument ([string]$entry.Value)))
        }
    }
    $child = Start-Process -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
        -ArgumentList ($childArgs -join ' ') -WorkingDirectory $rootPath `
        -RedirectStandardOutput $childStdoutPath -RedirectStandardError $childStderrPath -Wait -PassThru
    $pipelineExitCode = [int]$child.ExitCode
    $stdoutLines = if (Test-Path -LiteralPath $childStdoutPath) { [IO.File]::ReadAllLines($childStdoutPath, [Text.Encoding]::UTF8) } else { @() }
    $stderrLines = if (Test-Path -LiteralPath $childStderrPath) { [IO.File]::ReadAllLines($childStderrPath, [Text.Encoding]::UTF8) } else { @() }
    foreach ($line in $stdoutLines) { $output.Add($line) }
    foreach ($line in $stderrLines) { $output.Add("[stderr] $line") }
    $statusMatch = [regex]::Match(($stdoutLines -join "`n"), '"deployStatus"\s*:\s*"([^"]+)"')
    if ($statusMatch.Success) { $pipelineStatus = $statusMatch.Groups[1].Value }
    if ($pipelineExitCode -ne 0) {
        $exitCode = $pipelineExitCode
        $errorLine = @($stderrLines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1)
        if ($errorLine.Count -eq 0) { $errorLine = @($stdoutLines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1) }
        $errorSummary = ([string]($errorLine -join '')) -replace 'https?://[^\s"'']+', '[url]'
        if ([string]::IsNullOrWhiteSpace($errorSummary)) { $errorSummary = "daily pipeline exited with code $pipelineExitCode" }
        $output.Add("ERROR: $errorSummary")
    }
} catch {
    $exitCode = 1
    # Keep the status useful without persisting command lines, cookies or signed URLs.
    $errorSummary = ([string]$_.Exception.Message) -replace 'https?://[^\s"'']+', '[url]'
    $output.Add("ERROR: $errorSummary")
} finally {
    $finishedAt = [DateTime]::UtcNow
    $output.Add("finishedAt=$($finishedAt.ToString('o'))")
    $output.Add("exitCode=$exitCode")
    [IO.File]::WriteAllLines($logPath, $output, (New-Object Text.UTF8Encoding($false)))
    $status = [ordered]@{
        schemaVersion = 1
        startedAt = $startedAt.ToString('o')
        finishedAt = $finishedAt.ToString('o')
        ok = $exitCode -eq 0
        exitCode = $exitCode
        pipelineExitCode = $pipelineExitCode
        pipelineStatus = $pipelineStatus
        logFile = $logPath.Substring($rootPath.Length + 1).Replace('\', '/')
        error = $errorSummary
    }
    $statusTemp = "$statusPath.$PID.tmp"
    [IO.File]::WriteAllText($statusTemp, (($status | ConvertTo-Json -Depth 3) + "`n"), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $statusTemp -Destination $statusPath -Force
    $cutoff = (Get-Date).AddDays(-$LogRetentionDays)
    Get-ChildItem -LiteralPath $logRoot -File -Filter 'daily-*.log' -ErrorAction SilentlyContinue |
        Where-Object LastWriteTime -lt $cutoff |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $childStdoutPath, $childStderrPath -Force -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0) { exit $exitCode }
