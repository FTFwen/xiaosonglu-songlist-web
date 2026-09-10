[CmdletBinding()]
param(
    [switch]$Deploy,
    [switch]$AllowOAuth,
    [switch]$IngestSongCutAudio,
    [switch]$DownloadSongCutAudio,
    [string]$CuratedSongBatch = '',
    [string]$SongCutSourceDir = '',
    [string[]]$ReviewedSongCutSourceSpec = @(),
    [string]$BilibiliCookieFile = '',
    [string]$YtDlpPath = 'tools/yt-dlp/yt-dlp.exe',
    [string]$FfmpegDir = 'tools/ffmpeg',
    [ValidateRange(1, 8)]
    [int]$DeployAttempts = 5,
    [ValidateRange(1, 900)]
    [int]$RetryBaseSeconds = 30,
    [ValidateRange(1, 1800)]
    [int]$RetryMaxSeconds = 300,
    [string]$WranglerVersion = '4.130.0',
    [ValidateRange(1, 48)]
    [int]$VerifyAttempts = 20,
    [ValidateRange(1, 120)]
    [int]$VerifyDelaySeconds = 15,
    [string]$VerifyBaseUrl = 'https://viridis.love',
    [string]$HttpsProxy = '',
    [string]$ClashController = '',
    [string]$ClashProxyGroup = '',
    [string]$ClashProxyChoice = '',
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path $Root).Path
$node = (Get-Command node -ErrorAction Stop).Source
$python = (Get-Command python -ErrorAction Stop).Source
$git = (Get-Command git -ErrorAction Stop).Source

# Prevent overlapping scheduled/manual daily runs from mutating fact and derived files
# concurrently. The nested deployment uses its own independent staging/upload lock.
$dailyLockPath = Join-Path $rootPath 'data\xiaosonglu\_daily_pipeline.lock'
try {
    $dailyLockStream = [System.IO.File]::Open(
        $dailyLockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
} catch [System.IO.IOException] {
    throw 'Another daily song pipeline is already running in this workspace.'
}

function Assert-ExitCode {
    param([int]$Code, [int[]]$Allowed, [string]$Step)
    if ($Allowed -notcontains $Code) { throw "$Step failed with exit code $Code" }
}

function ConvertTo-NormalizedSongName {
    param([object]$Value)
    return (([string]$Value).Normalize([Text.NormalizationForm]::FormKC).Trim() -replace '\s+', ' ').ToLowerInvariant()
}

function ConvertTo-PositiveSafeInteger {
    param([object]$Value, [string]$Label)
    if ($null -eq $Value -or $Value -is [bool]) { throw "$Label must be a positive safe integer." }
    try { $numeric = [double]$Value } catch { throw "$Label must be a positive safe integer." }
    if ([double]::IsNaN($numeric) -or [double]::IsInfinity($numeric) -or $numeric -le 0 -or [math]::Truncate($numeric) -ne $numeric -or $numeric -gt 9007199254740991) {
        throw "$Label must be a positive safe integer."
    }
    return [long]$numeric
}

function ConvertTo-NormalizedReviewUrl {
    param([object]$Value)
    $text = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) { return '' }
    $uri = $null
    if (-not [Uri]::TryCreate($text, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or -not [string]::IsNullOrWhiteSpace($uri.UserInfo)) { return '' }
    $port = if ($uri.IsDefaultPort) { '' } else { ':' + $uri.Port }
    $hostName = $uri.Host.ToLowerInvariant()
    if (@('www.bilibili.com', 'bilibili.com', 'm.bilibili.com') -contains $hostName) { $hostName = 'bilibili.com' }
    return "https://$hostName$port$($uri.AbsolutePath.TrimEnd('/').ToLowerInvariant())"
}

function Test-TrustedSameNameEvidenceUrl {
    param([object]$Value)
    $text = ([string]$Value).Trim()
    $uri = $null
    if ([string]::IsNullOrWhiteSpace($text) -or -not [Uri]::TryCreate($text, [UriKind]::Absolute, [ref]$uri)) { return $false }
    return $uri.Scheme -eq 'https' -and $uri.IsDefaultPort -and [string]::IsNullOrWhiteSpace($uri.UserInfo) -and
        @('www.bilibili.com', 'bilibili.com', 'm.bilibili.com') -contains $uri.Host.ToLowerInvariant() -and
        $uri.AbsolutePath -match '^/video/BV[0-9A-Za-z]+/?$'
}

function Get-SongCutSourcePath {
    param([string]$CuratedRelativePath, [string]$ExplicitPath)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) { return $ExplicitPath }
    $curatedPath = Join-Path $rootPath $CuratedRelativePath
    $curated = Get-Content -LiteralPath $curatedPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $identity = [string]$curated.live.replayId
    if ([string]::IsNullOrWhiteSpace($identity)) { $identity = [string]$curated.live.replay_id }
    if ([string]::IsNullOrWhiteSpace($identity)) { $identity = [string]$curated.live.liveId }
    if ([string]::IsNullOrWhiteSpace($identity)) { throw 'CuratedSongBatch needs liveId or replayId before choosing a source directory.' }
    $safeIdentity = ($identity -replace '[^A-Za-z0-9._-]', '_').Trim('_')
    if ([string]::IsNullOrWhiteSpace($safeIdentity)) { throw 'CuratedSongBatch live identity cannot form a safe source directory.' }
    return "assets/audio/source/$safeIdentity"
}

function Test-CuratedAudioAlreadyIndexed {
    param([string]$CuratedRelativePath)
    $curatedFullPath = [IO.Path]::GetFullPath((Join-Path $rootPath $CuratedRelativePath))
    $rootPrefix = $rootPath.TrimEnd('\') + '\'
    if (-not $curatedFullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $curatedFullPath -PathType Leaf) -or
        ((Get-Item -LiteralPath $curatedFullPath).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'CuratedSongBatch must be a regular file inside the workspace.'
    }
    $curated = Get-Content -LiteralPath $curatedFullPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $songs = @($curated.songs)
    if ($songs.Count -eq 0) { throw 'CuratedSongBatch must contain at least one song.' }
    $audioIndexPath = Join-Path $rootPath 'data\xiaosonglu\audio_index.json'
    $audioIndex = Get-Content -LiteralPath $audioIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $audioBaselinePath = Join-Path $rootPath 'data\xiaosonglu\audio_asset_baseline.json'
    $audioBaseline = Get-Content -LiteralPath $audioBaselinePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $baselineByPath = @{}
    foreach ($property in @($audioBaseline.files.PSObject.Properties)) { $baselineByPath[$property.Name] = $property.Value }
    $segmentsPath = Join-Path $rootPath 'data\xiaosonglu\replay_song_segments.json'
    $segmentsDocument = Get-Content -LiteralPath $segmentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $segments = @($segmentsDocument.segments)
    $cuts = @((Get-Content -LiteralPath (Join-Path $rootPath 'data\xiaosonglu\song_cut_index.json') -Raw -Encoding UTF8 | ConvertFrom-Json).items)
    $liveDate = [string]$curated.live.date
    if ($liveDate -notmatch '^\d{4}-\d{2}-\d{2}$') { throw 'CuratedSongBatch live.date must be YYYY-MM-DD.' }
    $stableLiveIdentity = [string]$curated.live.replayId
    if ([string]::IsNullOrWhiteSpace($stableLiveIdentity)) { $stableLiveIdentity = [string]$curated.live.replay_id }
    if ([string]::IsNullOrWhiteSpace($stableLiveIdentity)) { $stableLiveIdentity = [string]$curated.live.liveId }
    if ([string]::IsNullOrWhiteSpace($stableLiveIdentity)) { throw 'CuratedSongBatch live must contain a stable liveId or replayId.' }
    $expectedReplayId = [string]$curated.live.replayId
    if ([string]::IsNullOrWhiteSpace($expectedReplayId)) { $expectedReplayId = [string]$curated.live.replay_id }
    if ([string]::IsNullOrWhiteSpace($expectedReplayId) -and -not [string]::IsNullOrWhiteSpace([string]$curated.live.liveId)) {
        $expectedReplayId = 'live:' + [string]$curated.live.liveId
    }
    $supersededSegments = @{}
    $factPosition = 0
    foreach ($song in $songs) {
        $factPosition++
        $factAction = [string]$song.factAction
        if ([string]::IsNullOrWhiteSpace($factAction)) { $factAction = [string]$song.fact_action }
        if ([string]::IsNullOrWhiteSpace($factAction)) { $factAction = 'keep-existing' }
        $factAction = $factAction.Trim().ToLowerInvariant()
        if ($factAction -notin @('keep-existing', 'replace-existing-segment')) { throw "Unsupported factAction '$factAction'." }
        if ($factAction -ne 'replace-existing-segment') { continue }
        $rawTargetPart = if ($null -ne $song.segmentIndex) { $song.segmentIndex } else { $song.segment_index }
        $targetPart = ConvertTo-PositiveSafeInteger $rawTargetPart 'replace-existing-segment segmentIndex'
        $previousName = [string]$song.previousSongName
        if ([string]::IsNullOrWhiteSpace($previousName)) { $previousName = [string]$song.previous_song_name }
        $previousBvid = [string]$song.previousCutBvid
        if ([string]::IsNullOrWhiteSpace($previousBvid)) { $previousBvid = [string]$song.previous_cut_bvid }
        $replacementReason = [string]$song.factReplacementReason
        if ([string]::IsNullOrWhiteSpace($replacementReason)) { $replacementReason = [string]$song.fact_replacement_reason }
        if ($targetPart -le 0 -or [string]::IsNullOrWhiteSpace($previousName) -or $previousBvid -notmatch '^BV[0-9A-Za-z]+$' -or [string]::IsNullOrWhiteSpace($replacementReason)) { throw 'replace-existing-segment requires segmentIndex, previousSongName, previousCutBvid, and factReplacementReason.' }
        if ($null -eq $song.cut) { throw 'replace-existing-segment requires a nested replacement cut.' }
        $declaredReplacementBvid = [string]$song.cut.bvid
        if ([string]::IsNullOrWhiteSpace($declaredReplacementBvid)) { $declaredReplacementBvid = [string]$song.cut.clip_bvid }
        $replacementCutUrl = [string]$song.cut.url
        if ([string]::IsNullOrWhiteSpace($replacementCutUrl)) { $replacementCutUrl = [string]$song.cut.clip_url }
        $replacementUrlBvid = [regex]::Match($replacementCutUrl, '/video/(BV[0-9A-Za-z]+)', [Text.RegularExpressions.RegexOptions]::IgnoreCase).Groups[1].Value
        if ([string]::IsNullOrWhiteSpace($declaredReplacementBvid) -or $declaredReplacementBvid -ine $replacementUrlBvid) { throw 'replace-existing-segment requires cut.bvid matching its Bilibili video URL.' }
        $slot = "$expectedReplayId::$targetPart"
        $coordinateMatches = @($segments | Where-Object { [string]$_.replay_id -eq $expectedReplayId -and (ConvertTo-PositiveSafeInteger $_.segment_index 'existing segment_index') -eq $targetPart })
        if ($coordinateMatches.Count -ne 1) { throw "replace-existing-segment requires exactly one fact at $slot." }
        $currentNameKey = ConvertTo-NormalizedSongName $coordinateMatches[0].song_name
        $previousNameKey = ConvertTo-NormalizedSongName $previousName
        $desiredFactName = [string]$song.songName
        if ([string]::IsNullOrWhiteSpace($desiredFactName)) { $desiredFactName = [string]$song.song_name }
        $desiredNameKey = ConvertTo-NormalizedSongName $desiredFactName
        if ($currentNameKey -eq $previousNameKey) {
            $matchingPreviousCuts = @($cuts | Where-Object { [string]$_.clip_date -eq $liveDate -and (ConvertTo-NormalizedSongName $_.song_name) -eq $previousNameKey -and [string]$_.clip_bvid -ieq $previousBvid })
            if ([string]$coordinateMatches[0].cut_link -notmatch ("/video/{0}(?:/|\?|$)" -f [regex]::Escape($previousBvid)) -or $matchingPreviousCuts.Count -ne 1) { throw 'replace-existing-segment previousCutBvid must exactly match the stale segment and cut ledger.' }
        } elseif ($currentNameKey -ne $desiredNameKey) {
            throw 'replace-existing-segment target has an unexpected song name.'
        }
        $supersededSegments[$slot] = [ordered]@{ previous = $previousNameKey; desired = $desiredNameKey }
    }
    if ($supersededSegments.Count -gt 0) {
        $segments = @($segments | Where-Object {
            $slot = "$([string]$_.replay_id)::$((ConvertTo-PositiveSafeInteger $_.segment_index 'existing segment_index'))"
            -not ($supersededSegments.ContainsKey($slot) -and (ConvertTo-NormalizedSongName $_.song_name) -eq $supersededSegments[$slot].previous)
        })
    }
    $indexedNames = @{}
    foreach ($property in @($audioIndex.audios.PSObject.Properties)) {
        $indexedNames[(ConvertTo-NormalizedSongName $property.Name)] = [string]$property.Value
    }
    $verificationTargetNames = @{}
    foreach ($targetName in @($audioIndex.verificationTargets)) {
        $verificationTargetNames[(ConvertTo-NormalizedSongName $targetName)] = $true
    }
    $curatedNames = @{}
    $sourceUrlsByName = @{}
    foreach ($candidate in $songs) {
        $candidateNameKey = ConvertTo-NormalizedSongName $candidate.songName
        $candidateCutUrl = [string]$candidate.cut.url
        if ([string]::IsNullOrWhiteSpace($candidateCutUrl)) { $candidateCutUrl = [string]$candidate.cut.clip_url }
        $candidateNormalizedUrl = ConvertTo-NormalizedReviewUrl $candidateCutUrl
        if (-not [string]::IsNullOrWhiteSpace($candidateNameKey) -and -not [string]::IsNullOrWhiteSpace($candidateNormalizedUrl)) {
            $sourceUrlsByName[$candidateNameKey] = @(@($sourceUrlsByName[$candidateNameKey]) + $candidateNormalizedUrl | Select-Object -Unique)
        }
    }
    $position = 0
    foreach ($song in $songs) {
        $position++
        $name = [string]$song.songName
        if ([string]::IsNullOrWhiteSpace($name)) { $name = [string]$song.song_name }
        if ([string]::IsNullOrWhiteSpace($name)) { throw 'Every curated song must have a non-empty songName/song_name.' }
        if ($null -eq $song.cut) { throw "Curated song '$name' must use a nested cut object." }
        $cutKind = [string]$song.cut.kind
        if ([string]::IsNullOrWhiteSpace($cutKind)) { $cutKind = [string]$song.cut.clip_kind }
        $cutKind = $cutKind.Trim().ToLowerInvariant()
        if ($cutKind -notin @('single', 'collection', 'collection-chapter', 'compilation')) { throw "Curated song '$name' has unsupported or missing cut kind '$cutKind'." }
        $canonicalCutUrl = [string]$song.cut.url
        if ([string]::IsNullOrWhiteSpace($canonicalCutUrl)) { $canonicalCutUrl = [string]$song.cut.clip_url }
        if (-not (Test-TrustedSameNameEvidenceUrl $canonicalCutUrl)) { throw "Curated song '$name' must use a canonical HTTPS Bilibili video URL." }
        $nameKey = ConvertTo-NormalizedSongName $name
        $rawPart = if ($null -ne $song.segmentIndex) { $song.segmentIndex } elseif ($null -ne $song.segment_index) { $song.segment_index } else { $position }
        $part = ConvertTo-PositiveSafeInteger $rawPart "curated song '$name' segmentIndex"
        $existing = @($segments | Where-Object {
            [string]$_.replay_date -eq $liveDate -and (ConvertTo-NormalizedSongName $_.song_name) -eq $nameKey
        })
        $idempotent = @($existing | Where-Object {
            [int]$_.segment_index -eq $part -and [string]$_.replay_id -eq $expectedReplayId
        }).Count -gt 0
        $sourceSet = @{}
        foreach ($url in @($sourceUrlsByName[$nameKey])) {
            $normalized = ConvertTo-NormalizedReviewUrl $url
            if (-not [string]::IsNullOrWhiteSpace($normalized)) { $sourceSet[$normalized] = $true }
        }
        foreach ($segment in $existing) {
            $normalized = ConvertTo-NormalizedReviewUrl $segment.cut_link
            if (-not [string]::IsNullOrWhiteSpace($normalized)) { $sourceSet[$normalized] = $true }
        }
        $cutUrl = [string]$song.cut.url
        if ([string]::IsNullOrWhiteSpace($cutUrl)) { $cutUrl = [string]$song.cut.clip_url }
        $normalizedCutUrl = ConvertTo-NormalizedReviewUrl $cutUrl
        if (-not [string]::IsNullOrWhiteSpace($normalizedCutUrl)) { $sourceSet[$normalizedCutUrl] = $true }
        $needsReview = $curatedNames.ContainsKey($nameKey) -or ($existing.Count -gt 0 -and -not $idempotent)
        if ($needsReview) {
            $review = if ($null -ne $song.sameNameReview) { $song.sameNameReview } else { $song.same_name_review }
            $evidenceUrls = @()
            if ($null -ne $review) {
                $evidenceUrls = @($review.evidenceUrls | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
                if ($evidenceUrls.Count -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$review.evidenceUrl)) {
                    $evidenceUrls = @([string]$review.evidenceUrl)
                }
            }
            $hasIndependentEvidence = @($evidenceUrls | Where-Object {
                $normalized = ConvertTo-NormalizedReviewUrl $_
                (Test-TrustedSameNameEvidenceUrl $_) -and -not [string]::IsNullOrWhiteSpace($normalized) -and -not $sourceSet.ContainsKey($normalized)
            }).Count -gt 0
            $reviewValid = $null -ne $review -and [string]$review.decision -eq 'confirmed-repeat' -and -not [string]::IsNullOrWhiteSpace([string]$review.notes) -and $hasIndependentEvidence
            if (-not $reviewValid) {
                throw "Curated song '$name' collides with another chapter without a confirmed sameNameReview backed by an independent Bilibili video URL. Recheck another uploader or search Bilibili before using the cut collection."
            }
        }
        $curatedNames[$nameKey] = $true
        $sourceUrlsByName[$nameKey] = @($sourceSet.Keys)
        if (-not $indexedNames.ContainsKey($nameKey)) { return $false }
        $audioAction = [string]$song.audioAction
        if ([string]::IsNullOrWhiteSpace($audioAction)) { $audioAction = [string]$song.audio_action }
        if ([string]::IsNullOrWhiteSpace($audioAction)) { $audioAction = 'keep-existing' }
        if ($song.replaceExistingAudio -eq $true) { $audioAction = 'replace-existing' }
        $audioAction = $audioAction.Trim().ToLowerInvariant()
        if ($audioAction -notin @('keep-existing', 'replace-existing')) { throw "Unsupported audioAction '$audioAction' for '$name'." }
        if ($audioAction -eq 'replace-existing') {
            if (-not $verificationTargetNames.ContainsKey($nameKey)) { return $false }
            $replacementReason = [string]$song.audioReplacementReason
            if ([string]::IsNullOrWhiteSpace($replacementReason)) { $replacementReason = [string]$song.audio_replacement_reason }
            if ([string]::IsNullOrWhiteSpace($replacementReason)) { throw "replace-existing for '$name' requires audioReplacementReason." }
            $declaredBvid = [string]$song.cut.bvid
            if ([string]::IsNullOrWhiteSpace($declaredBvid)) { $declaredBvid = [string]$song.cut.clip_bvid }
            $cutUri = [Uri]$canonicalCutUrl
            $urlBvid = [regex]::Match($cutUri.AbsolutePath, '/video/(BV[0-9A-Za-z]+)/?', [Text.RegularExpressions.RegexOptions]::IgnoreCase).Groups[1].Value
            if ([string]::IsNullOrWhiteSpace($declaredBvid) -or $declaredBvid -ine $urlBvid) { throw "replace-existing for '$name' requires cut.bvid matching its URL." }
            $expectedHash = ([string]$song.audioSha256).Trim().ToLowerInvariant()
            if ([string]::IsNullOrWhiteSpace($expectedHash)) { $expectedHash = ([string]$song.audio_sha256).Trim().ToLowerInvariant() }
            $rawExpectedBytes = if ($null -ne $song.audioBytes) { $song.audioBytes } else { $song.audio_bytes }
            if ($null -eq $rawExpectedBytes -or $rawExpectedBytes -is [bool]) { throw "replace-existing for '$name' requires integer audioBytes." }
            $numericExpectedBytes = [double]$rawExpectedBytes
            if ([double]::IsNaN($numericExpectedBytes) -or [double]::IsInfinity($numericExpectedBytes) -or $numericExpectedBytes -le 0 -or [math]::Truncate($numericExpectedBytes) -ne $numericExpectedBytes -or $numericExpectedBytes -gt 9007199254740991) { throw "replace-existing for '$name' requires safe integer audioBytes." }
            $expectedBytes = [long]$numericExpectedBytes
            $expectedTarget = ([string]$song.audioTarget).Trim().Split('?')[0].Replace('\', '/')
            if ([string]::IsNullOrWhiteSpace($expectedTarget)) { $expectedTarget = ([string]$song.audio_target).Trim().Split('?')[0].Replace('\', '/') }
            if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or $expectedBytes -le 0) { throw "replace-existing for '$name' requires reviewed audioSha256 and audioBytes." }
            if ($expectedTarget -notmatch '^assets/audio/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a$') { throw "replace-existing for '$name' requires a safe explicit audioTarget." }
            $expectedMapping = "${expectedTarget}?v=$($expectedHash.Substring(0, 12))"
            if ([string]$indexedNames[$nameKey] -ne $expectedMapping) { return $false }
            $relativeAudio = $expectedTarget.Replace('/', '\')
            $audioPath = Join-Path $rootPath $relativeAudio
            if (-not (Test-Path -LiteralPath $audioPath -PathType Leaf)) { return $false }
            $audioFile = Get-Item -LiteralPath $audioPath
            if ($audioFile.Length -ne $expectedBytes) { return $false }
            $actualHash = (Get-FileHash -LiteralPath $audioPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne $expectedHash) { return $false }
            if (-not $baselineByPath.ContainsKey($expectedTarget)) { return $false }
            $baselineEntry = $baselineByPath[$expectedTarget]
            if ([long]$baselineEntry.bytes -ne $expectedBytes -or ([string]$baselineEntry.sha256).ToLowerInvariant() -ne $expectedHash) { return $false }
        }
    }
    return $true
}

function Get-PipelineHashes {
    $relativePaths = @(
        'data\xiaosonglu\audio_index.json',
        'data\xiaosonglu\history_index.json',
        'data\xiaosonglu\replay_song_segments.json',
        'data\xiaosonglu\song_catalog.json',
        'data\xiaosonglu\song_cut_index.json',
        'data\xiaosonglu\song_cut_info.json',
        'data\xiaosonglu\song_cut_table.csv',
        'data\xiaosonglu\song_details.json',
        'data\xiaosonglu\song_metadata_overrides.json',
        'data\xiaosonglu\type_tag_registry.json',
        'index.html',
        '24xsl\index.html',
        'buttons\index.html',
        'buttons\buttons.js',
        'js\app.js',
        'js\cross-page-player.js',
        'js\data.js',
        'js\shared.js',
        'workshop\index.html',
        'workshop\js\app.js',
        'workshop\js\shared.js',
        'workshop\js\start.js',
        'workshop\data\xiaosonglu\song_catalog.json',
        'workshop\data\xiaosonglu\history_index.json',
        'workshop\data\xiaosonglu\song_details.json',
        'workshop\data\xiaosonglu\song_cut_info.json',
        'workshop\data\xiaosonglu\audio_index.json',
        'workshop\js\data.js'
    )
    $hashes = [ordered]@{}
    foreach ($relative in $relativePaths) {
        $path = Join-Path $rootPath $relative
        $hashes[$relative.Replace('\', '/')] = if (Test-Path -LiteralPath $path -PathType Leaf) {
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        } else { $null }
    }
    $audioIndexPath = Join-Path $rootPath 'data\xiaosonglu\audio_index.json'
    if (Test-Path -LiteralPath $audioIndexPath -PathType Leaf) {
        $audioIndex = Get-Content -LiteralPath $audioIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($value in @($audioIndex.audios.PSObject.Properties.Value | Sort-Object -Unique)) {
            $rawPath = [string]$value
            if ($rawPath -notmatch '^assets/audio/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a(?:\?[^#]*)?$') { throw "Unsafe audio path in audio_index.json: $rawPath" }
            $relative = $rawPath.Split('?')[0].Replace('/', '\')
            $path = Join-Path $rootPath $relative
            $hashes[$relative.Replace('\', '/')] = if (Test-Path -LiteralPath $path -PathType Leaf) {
                (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            } else { $null }
        }
    }
    return $hashes
}

Push-Location $rootPath
try {
    $startingStatus = @(& $git status --short)
    Assert-ExitCode $LASTEXITCODE @(0) 'initial git status'
    $trackedVideos = @(& $git ls-files | Where-Object {
        $_ -match '(^|/)(video|videos)/' -or $_ -match '\.(mp4|webm|mkv|mov|flv)$' -or $_ -match '(^|/)(video|videos)/.*\.ts$'
    })
    Assert-ExitCode $LASTEXITCODE @(0) 'tracked-video audit'
    if ($trackedVideos.Count -gt 0) { throw "Tracked video assets detected: $($trackedVideos -join ', ')" }

    $before = Get-PipelineHashes
    $downloadResult = $null
    $ingestionResult = $null
    $skipSongCutWork = $false
    $audioSourceBase = if ([string]::IsNullOrWhiteSpace($env:XSL_AUDIO_BASE_URL)) { 'https://viridis.love/' } else { $env:XSL_AUDIO_BASE_URL }

    if ($DownloadSongCutAudio) {
        $curatedPath = if ([string]::IsNullOrWhiteSpace($CuratedSongBatch)) { 'data/xiaosonglu/_curated_2026-09-08.json' } else { $CuratedSongBatch }
        $sourcePath = Get-SongCutSourcePath -CuratedRelativePath $curatedPath -ExplicitPath $SongCutSourceDir
        if (Test-CuratedAudioAlreadyIndexed -CuratedRelativePath $curatedPath) {
            # A scheduled rerun must not download a reviewed collection again after all
            # normalized song names have already been mapped into the authoritative index.
            $skipSongCutWork = $true
            $downloadResult = [ordered]@{ ok = $true; changed = $false; status = 'already-indexed'; curated = $curatedPath }
            $ingestionResult = [ordered]@{ ok = $true; changed = $false; status = 'already-indexed'; curated = $curatedPath }
        } else {
            $cookiePath = if ([string]::IsNullOrWhiteSpace($BilibiliCookieFile)) { $env:XSL_BILIBILI_COOKIE_FILE } else { $BilibiliCookieFile }
            if ([string]::IsNullOrWhiteSpace($cookiePath)) { throw 'DownloadSongCutAudio requires BilibiliCookieFile or XSL_BILIBILI_COOKIE_FILE.' }
            $downloadText = (& $python 'tools/download_song_cut_audio.py' '--root' $rootPath '--curated' $curatedPath '--source-dir' $sourcePath '--cookies-file' $cookiePath '--yt-dlp' $YtDlpPath '--ffmpeg-dir' $FfmpegDir | Out-String).Trim()
            Assert-ExitCode $LASTEXITCODE @(0) 'song-cut audio download'
            $downloadResult = $downloadText | ConvertFrom-Json
        }
    }

    if (($IngestSongCutAudio -or $DownloadSongCutAudio) -and -not $skipSongCutWork) {
        $curatedPath = if ([string]::IsNullOrWhiteSpace($CuratedSongBatch)) { 'data/xiaosonglu/_curated_2026-09-08.json' } else { $CuratedSongBatch }
        $sourcePath = Get-SongCutSourcePath -CuratedRelativePath $curatedPath -ExplicitPath $SongCutSourceDir
        # Keep index, durable baseline and local manifest transactional across the two tools.
        # A failed baseline adoption must not leave a new index with an old baseline.
        $ingestionBackupRoot = Join-Path $rootPath ("data\xiaosonglu\_ingest_transaction_{0}" -f $PID)
        New-Item -ItemType Directory -Path $ingestionBackupRoot -Force | Out-Null
        $ingestionBackupRecords = @()
        $audioReplacementBackupRecords = @()
        $hasReplacementActions = $false
        foreach ($relative in @(
            'data\xiaosonglu\audio_index.json',
            'data\xiaosonglu\audio_asset_baseline.json',
            'data\xiaosonglu\_audio_asset_manifest.json'
        )) {
            $original = Join-Path $rootPath $relative
            $backup = Join-Path $ingestionBackupRoot ([IO.Path]::GetFileName($relative))
            $exists = Test-Path -LiteralPath $original -PathType Leaf
            if ($exists) { Copy-Item -LiteralPath $original -Destination $backup -Force }
            $ingestionBackupRecords += [ordered]@{ original = $original; backup = $backup; existed = $exists }
        }
        $curatedForReplacementBackup = Get-Content -LiteralPath (Join-Path $rootPath $curatedPath) -Raw -Encoding UTF8 | ConvertFrom-Json
        $indexForReplacementBackup = Get-Content -LiteralPath (Join-Path $rootPath 'data\xiaosonglu\audio_index.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $replacementBackupDir = Join-Path $ingestionBackupRoot 'audio'
        foreach ($song in @($curatedForReplacementBackup.songs)) {
            $audioAction = [string]$song.audioAction
            if ([string]::IsNullOrWhiteSpace($audioAction)) { $audioAction = [string]$song.audio_action }
            if ($song.replaceExistingAudio -eq $true) { $audioAction = 'replace-existing' }
            if ($audioAction.Trim().ToLowerInvariant() -ne 'replace-existing') { continue }
            $hasReplacementActions = $true
            $relativeAudio = ([string]$song.audioTarget).Trim().Split('?')[0].Replace('/', '\')
            if ([string]::IsNullOrWhiteSpace($relativeAudio)) { $relativeAudio = ([string]$song.audio_target).Trim().Split('?')[0].Replace('/', '\') }
            if ($relativeAudio -notmatch '^assets\\audio\\[A-Za-z0-9][A-Za-z0-9._-]*\.m4a$') { throw "Unsafe replacement audio path for '$($song.songName)'." }
            $originalAudio = Join-Path $rootPath $relativeAudio
            $targetExisted = Test-Path -LiteralPath $originalAudio -PathType Leaf
            New-Item -ItemType Directory -Path $replacementBackupDir -Force | Out-Null
            $backupAudio = Join-Path $replacementBackupDir ([IO.Path]::GetFileName($relativeAudio))
            if ($targetExisted) { Copy-Item -LiteralPath $originalAudio -Destination $backupAudio -Force }
            $audioReplacementBackupRecords += [ordered]@{ original = $originalAudio; backup = $backupAudio; existed = $targetExisted }
        }
        $retainIngestionBackup = $false
        try {
            $ingestArguments = @('tools/ingest_song_cut_audio.py', '--root', $rootPath, '--curated', $curatedPath, '--source-dir', $sourcePath)
            foreach ($spec in $ReviewedSongCutSourceSpec) { $ingestArguments += @('--reviewed-source-spec', $spec) }
            $ingestionText = (& $python @ingestArguments | Out-String).Trim()
            Assert-ExitCode $LASTEXITCODE @(0) 'curated song-cut audio ingestion'
            $ingestionResult = $ingestionText | ConvertFrom-Json
            if ($ingestionResult.changed -eq $true -or $hasReplacementActions -or @($ingestionResult.recovered).Count -gt 0) {
                # Baseline adoption is intentionally coupled to the explicit ingestion switch;
                # routine daily runs never silently accept a changed audio set.
                $reviewedAdoptItems = @(@($ingestionResult.copied) + @($ingestionResult.replaced) + @($ingestionResult.recovered))
                $reviewedAdoptSpecs = @{}
                foreach ($item in $reviewedAdoptItems) {
                    $relative = ([string]$item.target).Split('?')[0]
                    $bytes = [long]$item.bytes
                    $hash = ([string]$item.sha256).Trim().ToLowerInvariant()
                    if ($relative -notmatch '^assets/audio/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a$' -or $bytes -le 0 -or $hash -notmatch '^[0-9a-f]{64}$') { throw 'Ingestion returned an invalid reviewed adoption target.' }
                    $spec = "$relative|$bytes|$hash"
                    if ($reviewedAdoptSpecs.ContainsKey($relative) -and $reviewedAdoptSpecs[$relative] -ne $spec) { throw "Ingestion returned conflicting adoption metadata for $relative." }
                    $reviewedAdoptSpecs[$relative] = $spec
                }
                if ($reviewedAdoptSpecs.Count -eq 0) { throw 'Audio baseline adoption has no reviewed ingestion targets.' }
                $adoptArguments = @('tools/sync_song_audio_assets.py', '--root', $rootPath, '--source-base', $audioSourceBase, '--adopt-baseline', '--quiet')
                foreach ($spec in @($reviewedAdoptSpecs.Values | Sort-Object)) { $adoptArguments += @('--adopt-spec', $spec) }
                & $python @adoptArguments
                Assert-ExitCode $LASTEXITCODE @(0) 'curated audio baseline adoption'
            }
        } catch {
            $originalFailure = $_
            $rollbackErrors = @()
            foreach ($item in @($ingestionResult.copied)) {
                $relativeTarget = ([string]$item.target).Split('?')[0]
                if ($relativeTarget -notmatch '^assets/audio/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a$') { continue }
                try {
                    $copiedTarget = Join-Path $rootPath $relativeTarget
                    if (Test-Path -LiteralPath $copiedTarget) { Remove-Item -LiteralPath $copiedTarget -Force -ErrorAction Stop }
                } catch { $rollbackErrors += "remove created target '$relativeTarget': $($_.Exception.Message)" }
            }
            foreach ($record in $audioReplacementBackupRecords) {
                try {
                    if ($record.existed) {
                        Copy-Item -LiteralPath $record.backup -Destination $record.original -Force -ErrorAction Stop
                    } elseif (Test-Path -LiteralPath $record.original) {
                        Remove-Item -LiteralPath $record.original -Force -ErrorAction Stop
                    }
                } catch { $rollbackErrors += "restore audio '$($record.original)': $($_.Exception.Message)" }
            }
            foreach ($record in $ingestionBackupRecords) {
                try {
                    if ($record.existed) {
                        Copy-Item -LiteralPath $record.backup -Destination $record.original -Force -ErrorAction Stop
                    } elseif (Test-Path -LiteralPath $record.original) {
                        Remove-Item -LiteralPath $record.original -Force -ErrorAction Stop
                    }
                } catch { $rollbackErrors += "restore metadata '$($record.original)': $($_.Exception.Message)" }
            }
            if ($rollbackErrors.Count -gt 0) {
                $retainIngestionBackup = $true
                $rollbackDetail = $rollbackErrors -join '; '
                throw "Audio ingestion failed: $($originalFailure.Exception.Message). Rollback was incomplete; backups retained at '$ingestionBackupRoot'. Restoration errors: $rollbackDetail"
            }
            throw $originalFailure
        } finally {
            if (-not $retainIngestionBackup) {
                Remove-Item -LiteralPath $ingestionBackupRoot -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    } elseif (-not ($IngestSongCutAudio -or $DownloadSongCutAudio) -and
        (-not [string]::IsNullOrWhiteSpace($CuratedSongBatch) -or -not [string]::IsNullOrWhiteSpace($SongCutSourceDir) -or $ReviewedSongCutSourceSpec.Count -gt 0 -or -not [string]::IsNullOrWhiteSpace($BilibiliCookieFile))) {
        throw 'Song-cut paths require -IngestSongCutAudio or -DownloadSongCutAudio.'
    }

    & $python 'tools/sync_song_audio_assets.py' '--root' $rootPath '--source-base' $audioSourceBase '--quiet'
    Assert-ExitCode $LASTEXITCODE @(0) 'song audio baseline sync'

    & $python 'tools/sync_viridis_baseline.py'
    $baselineExit = $LASTEXITCODE
    # Exit 2 means a local, content-hash divergence was preserved; it must never trigger a remote overwrite.
    Assert-ExitCode $baselineExit @(0, 2) 'remote baseline conditional sync'

    & $node 'scripts/scan_unrecorded_lives.mjs' '--write'
    $scanExit = $LASTEXITCODE
    Assert-ExitCode $scanExit @(0, 3) 'live scan'
    $pendingReview = $scanExit -eq 3

    & $node 'scripts/build_xiaosonglu_song_data.mjs' '--write'
    Assert-ExitCode $LASTEXITCODE @(0) 'song data build'
    & $node 'scripts/build_xiaosonglu_song_data.mjs' '--check'
    Assert-ExitCode $LASTEXITCODE @(0) 'song data idempotency check'
    & $node 'scripts/validate_song_data.mjs'
    Assert-ExitCode $LASTEXITCODE @(0) 'song data validation'
    $nodeTestFiles = @(Get-ChildItem -LiteralPath (Join-Path $rootPath 'scripts\tests') -Filter '*.test.mjs' -File | Sort-Object Name | ForEach-Object { $_.FullName })
    & $node '--test' '--test-isolation=none' @nodeTestFiles
    Assert-ExitCode $LASTEXITCODE @(0) 'web and song pipeline tests'
    $savedDontWriteBytecode = $env:PYTHONDONTWRITEBYTECODE
    try {
        $env:PYTHONDONTWRITEBYTECODE = '1'
        & $python '-m' 'unittest' 'discover' '-s' 'tools/tests' '-p' 'test_*.py' '-v'
        Assert-ExitCode $LASTEXITCODE @(0) 'audio pipeline Python tests'
    } finally {
        if ($null -eq $savedDontWriteBytecode) { Remove-Item Env:PYTHONDONTWRITEBYTECODE -ErrorAction SilentlyContinue } else { $env:PYTHONDONTWRITEBYTECODE = $savedDontWriteBytecode }
    }
    & (Join-Path $PSScriptRoot 'tests\test_deploy_verification_helpers.ps1') | Out-Host
    Assert-ExitCode $LASTEXITCODE @(0) 'deployment verification helper tests'

    & (Join-Path $PSScriptRoot 'sync_workspace_data.ps1') -Apply | Out-Host
    Assert-ExitCode $LASTEXITCODE @(0) 'workspace data sync'
    & (Join-Path $PSScriptRoot 'sync_workspace_data.ps1') -Check | Out-Host
    Assert-ExitCode $LASTEXITCODE @(0) 'workspace data sync check'

    $after = Get-PipelineHashes
    $changedFiles = @()
    $allHashKeys = @(@($before.Keys) + @($after.Keys) | Sort-Object -Unique)
    foreach ($key in $allHashKeys) {
        if ($before[$key] -ne $after[$key]) { $changedFiles += $key }
    }

    $deployParameters = @{
        Root = $rootPath
        DeployAttempts = $DeployAttempts
        RetryBaseSeconds = $RetryBaseSeconds
        RetryMaxSeconds = $RetryMaxSeconds
        WranglerVersion = $WranglerVersion
        VerifyAttempts = $VerifyAttempts
        VerifyDelaySeconds = $VerifyDelaySeconds
        VerifyBaseUrl = $VerifyBaseUrl
        NoProcessExit = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($HttpsProxy)) { $deployParameters.HttpsProxy = $HttpsProxy }
    if (-not [string]::IsNullOrWhiteSpace($ClashController)) { $deployParameters.ClashController = $ClashController }
    if (-not [string]::IsNullOrWhiteSpace($ClashProxyGroup)) { $deployParameters.ClashProxyGroup = $ClashProxyGroup }
    if (-not [string]::IsNullOrWhiteSpace($ClashProxyChoice)) { $deployParameters.ClashProxyChoice = $ClashProxyChoice }
    if ($Deploy -and -not $pendingReview) { $deployParameters.Deploy = $true }
    if ($AllowOAuth) { $deployParameters.AllowOAuth = $true }
    # A hashtable is required for named-parameter splatting. An array containing
    # '-Root', value pairs is treated positionally by Windows PowerShell and can
    # accidentally bind '-Root' to DeployAttempts.
    $deployText = (& (Join-Path $PSScriptRoot 'deploy_web.ps1') @deployParameters | Out-String).Trim()
    Assert-ExitCode $LASTEXITCODE @(0) 'deployment preflight/operation'
    $deployResult = $deployText | ConvertFrom-Json

    $endingStatus = @(& $git status --short)
    Assert-ExitCode $LASTEXITCODE @(0) 'final git status'
    $trackedVideosAfter = @(& $git ls-files | Where-Object {
        $_ -match '(^|/)(video|videos)/' -or $_ -match '\.(mp4|webm|mkv|mov|flv)$' -or $_ -match '(^|/)(video|videos)/.*\.ts$'
    })
    if ($trackedVideosAfter.Count -gt 0) { throw "Tracked video assets appeared during the run: $($trackedVideosAfter -join ', ')" }

    [ordered]@{
        ok = $true
        status = if ($pendingReview) { 'review-needed' } else { 'complete' }
        baselineExitCode = $baselineExit
        baselineStatus = if ($baselineExit -eq 2) { 'local-divergence-preserved' } else { 'in-sync' }
        scanExitCode = $scanExit
        songCutAudioDownloadRequested = [bool]$DownloadSongCutAudio
        songCutAudioDownload = $downloadResult
        songCutAudioIngestionRequested = [bool]($IngestSongCutAudio -or $DownloadSongCutAudio)
        songCutAudioIngestion = $ingestionResult
        pipelineDataChanged = $changedFiles.Count -gt 0
        changedPipelineFiles = $changedFiles
        deployRequested = [bool]$Deploy
        allowOAuthRequested = [bool]$AllowOAuth
        deployStatus = $deployResult.status
        trackedVideoCountBefore = $trackedVideos.Count
        trackedVideoCountAfter = $trackedVideosAfter.Count
        startingWorkingTreeChangeCount = $startingStatus.Count
        endingWorkingTreeChangeCount = $endingStatus.Count
    } | ConvertTo-Json -Depth 5
} finally {
    Pop-Location
    if ($dailyLockStream) { $dailyLockStream.Dispose() }
}
