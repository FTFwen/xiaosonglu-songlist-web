[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Check,
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
if ($Apply -and $Check) { throw 'Choose either -Apply or -Check.' }
$mode = if ($Apply) { 'apply' } else { 'check' }
$rootPath = (Resolve-Path $Root).Path

$pairs = @(
    @{ Source = 'data\xiaosonglu\song_catalog.json'; Destination = 'workshop\data\xiaosonglu\song_catalog.json' },
    @{ Source = 'data\xiaosonglu\history_index.json'; Destination = 'workshop\data\xiaosonglu\history_index.json' },
    @{ Source = 'data\xiaosonglu\song_details.json'; Destination = 'workshop\data\xiaosonglu\song_details.json' },
    @{ Source = 'data\xiaosonglu\audio_index.json'; Destination = 'workshop\data\xiaosonglu\audio_index.json' },
    @{ Source = 'data\xiaosonglu\song_cut_info.json'; Destination = 'workshop\data\xiaosonglu\song_cut_info.json' },
    @{ Source = 'js\data.js'; Destination = 'workshop\js\data.js' }
)

$results = @()
foreach ($pair in $pairs) {
    $source = Join-Path $rootPath $pair.Source
    $destination = Join-Path $rootPath $pair.Destination
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing canonical source: $($pair.Source)" }
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    $destinationHash = if (Test-Path -LiteralPath $destination -PathType Leaf) {
        (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    } else { $null }
    $changed = $sourceHash -ne $destinationHash
    if ($Apply -and $changed) {
        $parent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        $temporary = "$destination.$PID.tmp"
        [System.IO.File]::WriteAllBytes($temporary, [System.IO.File]::ReadAllBytes($source))
        Move-Item -LiteralPath $temporary -Destination $destination -Force
        $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $results += [ordered]@{
        source = $pair.Source.Replace('\', '/')
        destination = $pair.Destination.Replace('\', '/')
        changed = $changed
        sourceHash = $sourceHash
        destinationHash = $destinationHash
    }
}

$drift = @($results | Where-Object { $_.changed }).Count
[ordered]@{
    ok = if ($Apply) { $true } else { $drift -eq 0 }
    mode = $mode
    root = $rootPath
    driftCount = $drift
    files = $results
} | ConvertTo-Json -Depth 5

if (-not $Apply -and $drift -gt 0) { exit 2 }
