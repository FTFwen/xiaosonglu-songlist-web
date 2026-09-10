$ErrorActionPreference = 'Stop'
$helpers = Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy_verification_helpers.ps1'
. $helpers

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("xsl-deploy-helper-test-{0}" -f [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
    $canonical = "<!doctype html>`n<html><head><script src=`"/early.js`"></script></head><body><main>小松绿</main><script src=`"/app.js`"></script>`n</body></html>`n"
    $expectedHash = Get-Utf8TextSha256 $canonical
    $serverTimingJson = '{"version":"2024.11.0","token":"0123456789abcdef0123456789abcdef","r":1,"server_timing":{"name":{"cfCacheStatus":true},"location_startswith":null}}'
    $spaJson = '{"version":"2024.11.0","token":"0123456789abcdef0123456789abcdef","r":1,"spa":2}'
    $commentScript = "<script defer src='https://static.cloudflareinsights.com/beacon.min.js/v-test' integrity='sha512-dGVzdA==' data-cf-beacon='$serverTimingJson' crossorigin='anonymous'></script>"
    $beacon = "<!-- Cloudflare Web Analytics -->$commentScript<!-- End Cloudflare Web Analytics -->"
    $bareBeacon = "<script type=`"module`" src=`"https://static.cloudflareinsights.com/beacon.min.js/v-test`" integrity=`"sha512-dGVzdA==`" data-cf-beacon='$spaJson' crossorigin=`"anonymous`"></script>"
    $fixtures = @(
        $canonical.Replace('</body>', "$beacon</body>"),
        $canonical.Replace('</body>', "$beacon`n</body>"),
        $canonical.Replace("`n</body>", "`n$beacon</body>"),
        $canonical.Replace('</body>', "$bareBeacon`n</body>")
    )
    for ($index = 0; $index -lt $fixtures.Count; $index++) {
        $path = Join-Path $tempRoot ("fixture-{0}.html" -f $index)
        [IO.File]::WriteAllText($path, $fixtures[$index], (New-Object Text.UTF8Encoding($false)))
        if (-not (Test-CloudflareAnalyticsHtmlEquivalent -Path $path -ExpectedHash $expectedHash)) {
            throw "Known Cloudflare analytics fixture $index was not normalized."
        }
    }
    $tampered = $canonical.Replace('<main>小松绿</main>', "<main>错误内容</main>$beacon")
    $tamperedPath = Join-Path $tempRoot 'tampered.html'
    [IO.File]::WriteAllText($tamperedPath, $tampered, (New-Object Text.UTF8Encoding($false)))
    if (Test-CloudflareAnalyticsHtmlEquivalent -Path $tamperedPath -ExpectedHash $expectedHash) {
        throw 'HTML changes outside the managed analytics block must fail verification.'
    }
    $rejectedFixtures = [ordered]@{
        'unknown block' = '<!-- Cloudflare Web Analytics --><script>unknown()</script><!-- End Cloudflare Web Analytics -->'
        'extra script inside comments' = "<!-- Cloudflare Web Analytics -->$commentScript<script>evil()</script><!-- End Cloudflare Web Analytics -->"
        'extra text inside comments' = "<!-- Cloudflare Web Analytics -->$commentScript<span>unexpected</span><!-- End Cloudflare Web Analytics -->"
        'event attribute' = $bareBeacon.Replace(' crossorigin=', ' onload="evil()" crossorigin=')
        'inline script body' = $bareBeacon.Replace('></script>', '>evil()</script>')
        'extra beacon property' = $bareBeacon.Replace('"spa"', '"unexpected":true,"spa"')
        'non-integral spa' = $bareBeacon.Replace('"spa":2', '"spa":"2"')
        'unexpected spa one' = $bareBeacon.Replace('"spa":2', '"spa":1')
        'disabled spa' = $bareBeacon.Replace('"spa":2', '"spa":0')
    }
    foreach ($entry in $rejectedFixtures.GetEnumerator()) {
        $path = Join-Path $tempRoot (([string]$entry.Key).Replace(' ', '-') + '.html')
        [IO.File]::WriteAllText($path, $canonical.Replace('</body>', "$($entry.Value)`n</body>"), (New-Object Text.UTF8Encoding($false)))
        if (Test-CloudflareAnalyticsHtmlEquivalent -Path $path -ExpectedHash $expectedHash) {
            throw "Unsafe HTML variant was normalized: $($entry.Key)."
        }
    }
    [ordered]@{ ok = $true; normalizedFixtures = $fixtures.Count; tamperRejected = $true; unsafeFixturesRejected = $rejectedFixtures.Count } | ConvertTo-Json
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
