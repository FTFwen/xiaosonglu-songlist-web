# 周表定时同步 runner：抓 B 站置顶周表 → 有更新则提交、推送、双部署、验证、通知
# 由 install_weekly_sync.ps1 注册的 Windows 计划任务调用，也可手动运行。
[CmdletBinding()]
param(
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path $Root).Path
Set-Location $rootPath
$logPath = Join-Path $rootPath 'tools\weekly\sync.log'
function Write-SyncLog([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $logPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Send-SyncToast([string]$Title, [string]$Message) {
    # Windows 原生 Toast 通知（尽力而为，失败不影响同步结果）
    try {
        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $template = @"
<toast><visual><binding template="ToastGeneric"><text>$Title</text><text>$Message</text></binding></visual></toast>
"@
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($template)
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('PowerShell').Show($toast)
    } catch {
        Write-SyncLog "toast 通知失败（忽略）: $($_.Exception.Message)"
    }
}

try {
    Write-SyncLog '=== 周表同步开始 ==='
    $fetchOutput = & node (Join-Path $rootPath 'tools\weekly\fetch-weekly.mjs') 2>&1 | ForEach-Object { "$_" }
    $fetchText = $fetchOutput -join "`n"
    Write-SyncLog ($fetchText.Trim())

    if ($LASTEXITCODE -ne 0) {
        Write-SyncLog "抓取失败 exit=$LASTEXITCODE，本次结束"
        Send-SyncToast '小松绿周表同步' '周表抓取失败，详见 tools/weekly/sync.log'
        exit 2
    }

    if ($fetchText -notmatch 'UPDATED') {
        Write-SyncLog '周表未变化，本次结束'
        exit 0
    }

    # 有更新：提交推送
    $manifest = Get-Content (Join-Path $rootPath 'workshop\data\weekly\manifest.json') -Raw | ConvertFrom-Json
    $title = if ($manifest.title) { $manifest.title } else { '置顶更新' }
    git add -- workshop/assets/weekly workshop/data/weekly
    if ($LASTEXITCODE -ne 0) { throw "git add 失败 exit=$LASTEXITCODE" }
    git commit -m "周表自动更新：$title"
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw "git push 失败 exit=$LASTEXITCODE（本地提交已保留，下次部署前需先解决）" }
    Write-SyncLog "已提交推送：周表自动更新：$title"

    # 部署主站
    $deployMain = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $rootPath 'xsl-web-tools\deploy_web.ps1') -Deploy -AllowOAuth 2>&1 | ForEach-Object { "$_" }
    $mainTail = ($deployMain | Select-Object -Last 5) -join ' '
    Write-SyncLog "主站部署输出（尾部）: $mainTail"
    if ($deployMain -join "`n" -notmatch '"ok":\s*true|"status":\s*"deployed"') { throw "主站部署未确认成功" }

    # 部署 workshop 独立项目
    Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
    $deployWorkshop = & npx wrangler pages deploy workshop --project-name=xsl-workshop --commit-dirty=true 2>&1 | ForEach-Object { "$_" }
    Write-SyncLog ("workshop 部署输出（尾部）: " + (($deployWorkshop | Select-Object -Last 3) -join ' '))
    if ($deployWorkshop -join "`n" -notmatch 'Deployment complete') { throw 'workshop 项目部署未确认成功' }

    # 线上验证
    Start-Sleep -Seconds 5
    $remote = Invoke-RestMethod -Uri "https://workshop.viridis.love/data/weekly/manifest.json" -TimeoutSec 30
    if ($remote.fingerprint -ne $manifest.fingerprint) { throw "线上指纹未更新（本地 $($manifest.fingerprint) / 线上 $($remote.fingerprint)）" }
    $img = Invoke-WebRequest -Uri 'https://workshop.viridis.love/assets/weekly/current.jpg' -Method Head -TimeoutSec 30 -UseBasicParsing
    if ($img.StatusCode -ne 200) { throw "线上 current.jpg 状态 $($img.StatusCode)" }
    Write-SyncLog "线上验证通过 fingerprint=$($manifest.fingerprint)"

    Send-SyncToast '小松绿周表已更新' "$title 已上线 workshop.viridis.love"
    Write-SyncLog '=== 周表同步完成 ==='
    exit 0
} catch {
    $msg = $_.Exception.Message
    Write-SyncLog "ERROR $msg"
    Send-SyncToast '小松绿周表同步出错' $msg
    exit 1
}
