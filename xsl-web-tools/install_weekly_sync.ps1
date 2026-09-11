# 注册周表定时同步计划任务：每周二/三/四 10:30 检查 B 站置顶周表，有更新则替换并部署
[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$TaskName = 'XSL Viridis Weekly Schedule Sync',
    [string]$DailyAt = '10:30',
    [ValidateSet('S4U', 'Interactive')]
    [string]$LogonType = 'Interactive'
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path $Root).Path
$runnerPath = Join-Path $PSScriptRoot 'run_weekly_sync.ps1'
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) { throw 'The weekly sync runner is missing.' }
$when = [DateTime]::MinValue
if (-not [DateTime]::TryParseExact($DailyAt, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$when)) {
    throw 'DailyAt must use 24-hour HH:mm format.'
}

$arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$runnerPath`"", '-Root', "`"$rootPath`"") -join ' '
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $rootPath
$triggerTime = (Get-Date).Date.Add($when.TimeOfDay)
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Tuesday, Wednesday, Thursday -At $triggerTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes 15) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType $LogonType -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description '每周二三四检查小松绿B站置顶周表，有更新则替换图片并部署 viridis.love 与 workshop.viridis.love。'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
$registered = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[ordered]@{
    ok = $true
    taskName = $registered.TaskName
    state = [string]$registered.State
    nextRunTime = $info.NextRunTime.ToString('yyyy-MM-dd HH:mm:ss')
    runAs = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    schedule = '每周 周二/三/四 ' + $DailyAt
} | ConvertTo-Json -Depth 3
