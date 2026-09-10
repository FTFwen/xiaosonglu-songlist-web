function Get-Utf8TextSha256 {
    param([string]$Text)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $encoding.GetBytes($Text)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Test-CloudflareAnalyticsScriptTag {
    param([string]$Script)
    $tagPattern = '(?is)^<script(?<attrs>(?:\s+[A-Za-z][A-Za-z0-9-]*(?:\s*=\s*(?:"[^"]*"|''[^'']*''))?)*)\s*></script>$'
    $tagMatch = [regex]::Match($Script, $tagPattern)
    if (-not $tagMatch.Success) { return $false }
    $rawAttributes = $tagMatch.Groups['attrs'].Value
    $attributePattern = '\s+(?<name>[A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*(?:"(?<double>[^"]*)"|''(?<single>[^'']*)''))?'
    $attributeMatches = @([regex]::Matches($rawAttributes, $attributePattern))
    if (((@($attributeMatches | ForEach-Object { $_.Value })) -join '') -cne $rawAttributes) { return $false }
    $attributes = @{}
    foreach ($item in $attributeMatches) {
        $name = $item.Groups['name'].Value.ToLowerInvariant()
        if ($attributes.ContainsKey($name)) { return $false }
        $value = if ($item.Groups['double'].Success) { $item.Groups['double'].Value } elseif ($item.Groups['single'].Success) { $item.Groups['single'].Value } else { $null }
        $attributes[$name] = $value
    }
    $keys = @($attributes.Keys | Sort-Object)
    $moduleKeys = @('crossorigin', 'data-cf-beacon', 'integrity', 'src', 'type')
    $deferKeys = @('crossorigin', 'data-cf-beacon', 'defer', 'integrity', 'src')
    $isModuleForm = ($keys -join ',') -ceq ($moduleKeys -join ',') -and [string]$attributes.type -ceq 'module'
    $isDeferForm = ($keys -join ',') -ceq ($deferKeys -join ',') -and $null -eq $attributes.defer
    if (-not ($isModuleForm -or $isDeferForm)) { return $false }
    if ([string]$attributes.src -notmatch '^https://static\.cloudflareinsights\.com/beacon\.min\.js/[A-Za-z0-9._~!$&()*+,;=:@%/-]+$') { return $false }
    if ([string]$attributes.integrity -notmatch '^sha512-[A-Za-z0-9+/]+={0,2}$') { return $false }
    if ([string]$attributes.crossorigin -cne 'anonymous') { return $false }
    $rawBeacon = [string]$attributes['data-cf-beacon']
    if ($rawBeacon.Length -gt 3072 -or $rawBeacon -match '[<>]' -or -not $rawBeacon.StartsWith('{') -or -not $rawBeacon.EndsWith('}')) { return $false }
    try { $beacon = $rawBeacon | ConvertFrom-Json } catch { return $false }
    if ($null -eq $beacon -or $beacon -is [array] -or $beacon -is [string] -or $beacon -is [bool]) { return $false }
    $topLevelNames = @($beacon.PSObject.Properties.Name | Sort-Object)
    $serverTimingNames = @('r', 'server_timing', 'token', 'version')
    $spaNames = @('r', 'spa', 'token', 'version')
    $isServerTimingVariant = ($topLevelNames -join ',') -ceq ($serverTimingNames -join ',')
    $isSpaVariant = ($topLevelNames -join ',') -ceq ($spaNames -join ',')
    if (-not ($isServerTimingVariant -or $isSpaVariant)) { return $false }
    if ([string]$beacon.version -notmatch '^\d{4}\.\d{1,2}\.\d+$' -or [string]$beacon.token -notmatch '^[0-9a-f]{32}$') { return $false }
    if ($beacon.r -is [bool] -or [double]$beacon.r -ne 1) { return $false }
    if ($isSpaVariant) {
        if ($beacon.spa -isnot [int] -or [int]$beacon.spa -ne 2) { return $false }
    } else {
        $serverTiming = $beacon.server_timing
        if ($null -eq $serverTiming -or $serverTiming -is [array] -or $serverTiming -is [string] -or $serverTiming -is [bool]) { return $false }
        $timingNames = @($serverTiming.PSObject.Properties.Name)
        if ($timingNames -cnotcontains 'name' -or @($timingNames | Where-Object { $_ -cnotin @('name', 'location_startswith') }).Count -gt 0) { return $false }
        $locationProperty = $serverTiming.PSObject.Properties['location_startswith']
        if ($locationProperty -and $null -ne $locationProperty.Value -and ($locationProperty.Value -isnot [string] -or [string]$locationProperty.Value -notmatch '^/[A-Za-z0-9._~!$&()*+,;=:@%/?-]*$')) { return $false }
        $timingFlags = $serverTiming.name
        if ($null -eq $timingFlags -or $timingFlags -is [array] -or $timingFlags -is [string] -or $timingFlags -is [bool]) { return $false }
        $flagProperties = @($timingFlags.PSObject.Properties)
        if ($flagProperties.Count -eq 0 -or @($flagProperties | Where-Object { $_.Name -notmatch '^cf[A-Za-z0-9]+$' -or $_.Value -isnot [bool] }).Count -gt 0) { return $false }
    }
    return $true
}

function Test-CloudflareAnalyticsHtmlEquivalent {
    param([string]$Path, [string]$ExpectedHash)
    $text = [IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
    if ([regex]::Matches($text, 'https://static\.cloudflareinsights\.com/beacon\.min\.js/').Count -ne 1) { return $false }
    $commentPattern = '(?is)<!-- Cloudflare Web Analytics -->(?<script><script\b[^>]*></script>)<!-- End Cloudflare Web Analytics -->(?=(?:\r?\n)?</body>)'
    $commentMatches = @([regex]::Matches($text, $commentPattern))
    $injection = $null
    $script = ''
    if ($commentMatches.Count -eq 1) {
        $injection = $commentMatches[0]
        $script = $injection.Groups['script'].Value
    } elseif ($commentMatches.Count -gt 1) {
        return $false
    } else {
        $barePattern = '(?is)(?<script><script\b[^>]*></script>)(?=(?:\r?\n)?</body>)'
        $bareMatches = @([regex]::Matches($text, $barePattern) | Where-Object { $_.Groups['script'].Value -match 'https://static\.cloudflareinsights\.com/beacon\.min\.js/' })
        if ($bareMatches.Count -ne 1) { return $false }
        $injection = $bareMatches[0]
        $script = $injection.Groups['script'].Value
    }
    if ($injection.Length -gt 4096 -or -not (Test-CloudflareAnalyticsScriptTag $script)) { return $false }
    $before = $text.Substring(0, $injection.Index)
    $after = $text.Substring($injection.Index + $injection.Length)
    $candidates = @($before + $after)
    if ($before.EndsWith("`r`n")) { $candidates += $before.Substring(0, $before.Length - 2) + $after }
    elseif ($before.EndsWith("`n")) { $candidates += $before.Substring(0, $before.Length - 1) + $after }
    if ($after.StartsWith("`r`n")) { $candidates += $before + $after.Substring(2) }
    elseif ($after.StartsWith("`n")) { $candidates += $before + $after.Substring(1) }
    foreach ($candidate in $candidates) {
        if ((Get-Utf8TextSha256 $candidate) -eq $ExpectedHash) { return $true }
    }
    return $false
}
