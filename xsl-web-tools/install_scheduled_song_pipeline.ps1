[CmdletBinding()]
param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [string]$TaskName = 'XSL Viridis Daily Song Pipeline',
    [string]$DailyAt = '12:30',
    [ValidateSet('S4U', 'Interactive')]
    [string]$LogonType = 'Interactive',
    [string]$HttpsProxy = 'http://127.0.0.1:17890',
    [string]$ClashController = 'http://127.0.0.1:8765',
    [string]$ClashProxyGroup = 'Pluto',
    [string]$ClashProxyChoice = '__AUTO__',
    [switch]$DownloadSongCutAudio,
    [string]$CuratedSongBatch = 'data/xiaosonglu/_curated_2026-09-08.json',
    [string]$SongCutSourceDir = '',
    [string]$BilibiliCookieFile = ''
)

$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path $Root).Path
$runnerPath = Join-Path $PSScriptRoot 'run_scheduled_song_pipeline.ps1'
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) { throw 'The scheduled pipeline runner is missing.' }
$when = [DateTime]::MinValue
if (-not [DateTime]::TryParseExact($DailyAt, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$when)) {
    throw 'DailyAt must use 24-hour HH:mm format.'
}

function Quote-TaskArgument {
    param([string]$Value)
    if ($Value -match '["\r\n]') { throw 'Scheduled task argument values must not contain quotes or newlines.' }
    return '"' + $Value + '"'
}

$arguments = New-Object System.Collections.Generic.List[string]
@('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File') | ForEach-Object { $arguments.Add($_) }
$arguments.Add((Quote-TaskArgument $runnerPath))
$arguments.Add('-Root'); $arguments.Add((Quote-TaskArgument $rootPath))
if (-not [string]::IsNullOrWhiteSpace($HttpsProxy)) { $arguments.Add('-HttpsProxy'); $arguments.Add((Quote-TaskArgument $HttpsProxy)) }
if (-not [string]::IsNullOrWhiteSpace($ClashController)) { $arguments.Add('-ClashController'); $arguments.Add((Quote-TaskArgument $ClashController)) }
if (-not [string]::IsNullOrWhiteSpace($ClashProxyGroup)) { $arguments.Add('-ClashProxyGroup'); $arguments.Add((Quote-TaskArgument $ClashProxyGroup)) }
if (-not [string]::IsNullOrWhiteSpace($ClashProxyChoice)) { $arguments.Add('-ClashProxyChoice'); $arguments.Add((Quote-TaskArgument $ClashProxyChoice)) }
if ($DownloadSongCutAudio) {
    $arguments.Add('-DownloadSongCutAudio')
    $arguments.Add('-CuratedSongBatch'); $arguments.Add((Quote-TaskArgument $CuratedSongBatch))
    if (-not [string]::IsNullOrWhiteSpace($SongCutSourceDir)) { $arguments.Add('-SongCutSourceDir'); $arguments.Add((Quote-TaskArgument $SongCutSourceDir)) }
    if (-not [string]::IsNullOrWhiteSpace($BilibiliCookieFile)) {
        $cookieFullPath = [IO.Path]::GetFullPath($BilibiliCookieFile)
        $rootPrefix = $rootPath.TrimEnd('\') + '\'
        if ($cookieFullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The Bilibili cookie file must stay outside the workspace.' }
        $arguments.Add('-BilibiliCookieFile'); $arguments.Add((Quote-TaskArgument $cookieFullPath))
    }
}

$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $powershell -Argument ($arguments -join ' ') -WorkingDirectory $rootPath
$triggerTime = (Get-Date).Date.Add($when.TimeOfDay)
$trigger = New-ScheduledTaskTrigger -Daily -At $triggerTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 6) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 30) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType $LogonType -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Runs the validated Viridis song-data, static-audio and complete Cloudflare Pages deployment pipeline.'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
$registered = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[ordered]@{
    ok = $true
    taskName = $registered.TaskName
    state = [string]$registered.State
    nextRunTime = $info.NextRunTime.ToString('o')
    runAs = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    logonType = $LogonType
    staticPages = $true
    songAudioUsesR2 = $false
    songCutDownloadEnabled = [bool]$DownloadSongCutAudio
} | ConvertTo-Json -Depth 3
