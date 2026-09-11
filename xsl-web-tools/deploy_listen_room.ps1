param(
    [switch]$Deploy,
    [switch]$AllowOAuth,
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [string]$WranglerVersion = '4.130.0'
)

$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path $Root).Path
$configPath = Join-Path $rootPath 'workers\listen-room\wrangler.toml'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'listen-room wrangler.toml is missing.' }

$git = Get-Command git -ErrorAction Stop
$head = (& $git.Source -C $rootPath rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $head) { throw 'Cannot resolve Git HEAD.' }

$wranglerCommand = Get-Command wrangler.cmd -ErrorAction SilentlyContinue
$wranglerPrefix = @()
if (-not $wranglerCommand) { $wranglerCommand = Get-Command wrangler -ErrorAction SilentlyContinue }
if (-not $wranglerCommand) {
    $wranglerCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if (-not $wranglerCommand) { $wranglerCommand = Get-Command npx -ErrorAction SilentlyContinue }
    if ($wranglerCommand) { $wranglerPrefix = @('--yes', "wrangler@$WranglerVersion") }
}
if (-not $wranglerCommand) { throw 'Wrangler/npx is required to deploy listen-room Worker.' }

& $wranglerCommand.Source @wranglerPrefix 'deploy' '--config' $configPath '--dry-run' | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'listen-room Worker dry-run failed.' }

if (-not $Deploy) {
    [ordered]@{ status = 'preflight-only'; commitHash = $head; config = $configPath } | ConvertTo-Json -Depth 4
    exit 0
}

$hasToken = -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)
$hasAccount = -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_ACCOUNT_ID)
if (-not ($AllowOAuth -or ($hasToken -and $hasAccount))) { throw 'Pass -AllowOAuth or provide CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID.' }

$savedApiToken = $env:CLOUDFLARE_API_TOKEN
$savedAccountId = $env:CLOUDFLARE_ACCOUNT_ID
$apiTokenWasPresent = Test-Path Env:CLOUDFLARE_API_TOKEN
$accountIdWasPresent = Test-Path Env:CLOUDFLARE_ACCOUNT_ID
try {
    if ($AllowOAuth) {
        Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
        Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
    }
    & $wranglerCommand.Source @wranglerPrefix 'deploy' '--config' $configPath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'listen-room Worker deployment failed.' }
    [ordered]@{ status = 'deployed'; commitHash = $head; config = $configPath } | ConvertTo-Json -Depth 4
} finally {
    if ($apiTokenWasPresent) { $env:CLOUDFLARE_API_TOKEN = $savedApiToken } else { Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue }
    if ($accountIdWasPresent) { $env:CLOUDFLARE_ACCOUNT_ID = $savedAccountId } else { Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue }
}
