import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clusterLyrics, lyricBody } from '../cluster_lyrics.mjs';
import { fetchLiveDanmaku } from '../fetch_live_danmaku.mjs';
import { discoverFromLives } from '../scan_unrecorded_lives.mjs';
import { upsertLiveState } from '../lib/ingestion-state.mjs';
import { collectSameNameReviews, mergeLiveImportEvidence } from '../import_curated_songs.mjs';
import { buildDerivedData, canonicalizeBilibiliCutUrl, getNonCanonicalTypeTags, importCuratedBatch, normalizeLanguageTag, normalizeTypeTags, performanceKey, validateCuts, validateSegments, validateTypeTagRegistry } from '../lib/song-data.mjs';

function segment(date, name, extra = {}) {
  return {
    replay_id: `live:${date}`,
    replay_title: date,
    replay_url: '',
    replay_date: date,
    replay_date_source: 'live-api-date',
    segment_index: 1,
    start_time: '00:01:00',
    end_time: '00:02:00',
    lyric_excerpt: '',
    song_search_query: name,
    song_resolution_method: 'test',
    song_name: name,
    display_song_name: name,
    artist: '',
    artist_search: '',
    feat_artist: '',
    language: '',
    tone: '',
    status_labels: ['歌回'],
    display_version: '',
    type: '',
    remark: '',
    identification: '',
    cut_link: '',
    confidence: 0.9,
    row_key: name,
    search_name: '',
    resolution_candidates: [],
    ...extra,
  };
}

function curatedCut(bvid = 'BV1fixture') {
  return { url: `https://www.bilibili.com/video/${bvid}/`, bvid, kind: 'single' };
}

const emptyCuts = {
  roomKey: 'xiaosonglu', roomId: '1727071052', sourceType: 'bilibili-song-cut-index', updatedAt: '2026-01-01T00:00:00.000Z', items: [],
};

test('durable audio baseline exactly matches the published audio index', async () => {
  const dataDir = new URL('../../data/xiaosonglu/', import.meta.url);
  const audioIndex = JSON.parse(await readFile(new URL('audio_index.json', dataDir), 'utf8'));
  const baseline = JSON.parse(await readFile(new URL('audio_asset_baseline.json', dataDir), 'utf8'));
  const indexedPaths = [...new Set(Object.values(audioIndex.audios).map((value) => String(value).split('?', 1)[0]))].sort();
  const baselinePaths = Object.keys(baseline.files).sort();
  assert.equal(Object.keys(audioIndex.audios).length, audioIndex.count);
  assert.equal(indexedPaths.length, audioIndex.count);
  assert.equal(baselinePaths.length, baseline.count);
  assert.deepEqual(indexedPaths, baselinePaths);
  const indexedValues = new Set(Object.values(audioIndex.audios));
  for (const [path, expected] of Object.entries(baseline.files)) {
    assert.match(path, /^assets\/audio\/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a$/);
    assert.ok(Number.isSafeInteger(expected.bytes) && expected.bytes > 0);
    assert.match(expected.sha256, /^[a-f0-9]{64}$/);
    assert.ok(indexedValues.has(`${path}?v=${expected.sha256.slice(0, 12)}`), `missing SHA-versioned mapping for ${path}`);
  }
  assert.deepEqual(audioIndex.verificationTargets, ['中华墨水娘', '中华铄金娘']);
});

test('same-name collection correction preserves both 中华墨水娘 and 中华铄金娘', async () => {
  const dataDir = new URL('../../data/xiaosonglu/', import.meta.url);
  const [segments, catalog, cuts, cutInfo, audio] = await Promise.all([
    'replay_song_segments.json', 'song_catalog.json', 'song_cut_index.json', 'song_cut_info.json', 'audio_index.json',
  ].map(name => readFile(new URL(name, dataDir), 'utf8').then(JSON.parse)));
  const inkSegment = segments.segments.find(item => item.replay_date === '2026-09-08' && item.segment_index === 18);
  const metalSegment = segments.segments.find(item => item.replay_date === '2026-09-08' && item.segment_index === 22);
  assert.equal(inkSegment.song_name, '中华墨水娘');
  assert.equal(inkSegment.cut_link, 'https://www.bilibili.com/video/BV165YJ6gEUy/');
  assert.equal(metalSegment.song_name, '中华铄金娘');
  assert.equal(metalSegment.cut_link, 'https://www.bilibili.com/video/BV1ceYE6BEPo/');
  assert.ok(catalog.songs.some(song => song.song_name === '中华墨水娘'));
  assert.ok(catalog.songs.some(song => song.song_name === '中华铄金娘'));
  assert.equal(cutInfo.cuts['中华墨水娘'].url, 'https://www.bilibili.com/video/BV165YJ6gEUy/');
  assert.equal(cutInfo.cuts['中华铄金娘'].url, 'https://www.bilibili.com/video/BV1ceYE6BEPo/');
  assert.equal(audio.audios['中华墨水娘'], 'assets/audio/song_156.m4a?v=f79d52634080');
  assert.equal(audio.audios['中华铄金娘'], 'assets/audio/song_167.m4a?v=384bfce6d87d');
  assert.notEqual(audio.audios['中华墨水娘'], audio.audios['中华铄金娘']);
  assert.equal(cuts.items.filter(item => item.clip_date === '2026-09-08' && ['中华墨水娘', '中华铄金娘'].includes(item.song_name)).length, 2);
});

test('lyric detector accepts only full-width lyric brackets', () => {
  assert.equal(lyricBody('【这是足够长的一句歌词】'), '这是足够长的一句歌词');
  assert.equal(lyricBody('［这是另一句足够长的歌词］'), '这是另一句足够长的歌词');
  assert.equal(lyricBody('[爱][爱][爱][爱]'), null);
  assert.equal(lyricBody('【太短】'), null);
});

test('lyric clustering starts a new segment after 150 seconds', () => {
  const startDate = 1_000_000;
  const payload = {
    live: { startDate },
    records: [
      { ts: startDate, relativeTime: '00:00:00', text: '【这是第一句足够长的歌词】' },
      { ts: startDate + 149_000, relativeTime: '00:02:29', text: '【这是第二句足够长的歌词】' },
      { ts: startDate + 300_000, relativeTime: '00:05:00', text: '【这是第三句足够长的歌词】' },
    ],
  };
  const result = clusterLyrics(payload);
  assert.equal(result.clusters.length, 2);
  assert.equal(result.clusters[0].lineCount, 2);
  assert.equal(result.clusters[1].lineCount, 1);
});

test('language tags use 日文 as the canonical Japanese label', () => {
  assert.equal(normalizeLanguageTag('日语'), '日文');
  assert.equal(normalizeLanguageTag(' 日语 / 英文 '), '日文/英文');
  assert.equal(normalizeLanguageTag('日文'), '日文');
  assert.match(validateSegments([segment('2026-09-09', '旧标签', { language: '日语' })])[0], /noncanonical language tag 日语/u);
});

test('curated imports canonicalize language aliases before writing facts', () => {
  const result = importCuratedBatch({
    segmentsDocument: { segments: [] },
    cutsDocument: emptyCuts,
    now: '2026-09-09T00:00:00.000Z',
    batch: {
      live: { date: '2026-09-09', liveId: 'language-test', title: 'test' },
      songs: [{ songName: '语言测试', language: '日语', statusLabels: ['歌回'], cut: curatedCut('BV1language') }],
    },
  });
  assert.equal(result.insertedSegments[0].language, '日文');
});

test('broad 虚拟歌手 input requires a precise existing type tag', () => {
  assert.deepEqual(normalizeTypeTags(['虚拟歌手', '中V', '流行', '中V']), ['虚拟歌手', '中V', '流行']);
  assert.deepEqual(getNonCanonicalTypeTags('中V、虚拟歌手'), ['虚拟歌手']);
  assert.throws(() => importCuratedBatch({
    segmentsDocument: { segments: [segment('2026-09-08', '既有中V歌曲', { type: '中V' })] },
    cutsDocument: emptyCuts,
    now: '2026-09-09T00:00:00.000Z',
    batch: {
      live: { date: '2026-09-09', liveId: 'type-test', title: 'test' },
      songs: [{ songName: '类型归类测试', typeTags: ['虚拟歌手'], statusLabels: ['歌回'], cut: curatedCut('BV1ambiguous') }],
    },
  }), /Ambiguous type tag/u);
  const result = importCuratedBatch({
    segmentsDocument: { segments: [segment('2026-09-08', '既有中V歌曲', { type: '中V' })] },
    cutsDocument: emptyCuts,
    now: '2026-09-09T00:00:00.000Z',
    batch: {
      live: { date: '2026-09-09', liveId: 'type-test-precise', title: 'test' },
      songs: [{ songName: '类型归类测试', typeTags: ['中V'], statusLabels: ['歌回'], cut: curatedCut('BV1precise') }],
    },
  });
  assert.equal(result.insertedSegments[0].type, '中V');
  assert.deepEqual(result.newTypeTags, []);
});

test('new type tags require registry approval after existing tags are checked', () => {
  const args = {
    segmentsDocument: { segments: [segment('2026-09-08', '既有中V歌曲', { type: '中V' })] },
    cutsDocument: emptyCuts,
    batch: {
      live: { date: '2026-09-09', liveId: 'new-type-test', title: 'test' },
      songs: [{ songName: '待确认新类别', typeTags: ['待确认类别'], statusLabels: ['歌回'], cut: curatedCut('BV1newtype') }],
    },
  };
  assert.throws(() => importCuratedBatch(args), /Unapproved type tag/u);
  const approved = importCuratedBatch({ ...args, approvedTypeTags: ['中V', '待确认类别'] });
  assert.deepEqual(approved.newTypeTags, ['待确认类别']);
  assert.equal(approved.insertedSegments[0].type, '待确认类别');
});

test('type tag registry requires a reason for every approved category', () => {
  const registry = {
    schemaVersion: 1,
    approvedTags: ['中V'],
    approvalLog: [{ date: '2026-09-09', tags: ['中V'], reason: '已有标签基线' }],
    blockedTags: {
      '虚拟歌手': { reason: '过于宽泛', suggestedExistingTags: ['中V'] },
    },
  };
  assert.deepEqual(validateTypeTagRegistry(registry), []);
  assert.match(validateTypeTagRegistry({ ...registry, approvalLog: [{ ...registry.approvalLog[0], reason: '' }] })[0], /requires a reason/u);
  assert.throws(() => buildDerivedData({
    segmentsDocument: { updatedAt: '2026-09-09T00:00:00.000Z', segments: [segment('2026-09-09', '直接编辑的新类别', { type: '未审批类别' })] },
    cutsDocument: structuredClone(emptyCuts),
    overridesDocument: { bySongName: {} },
    currentCatalog: { songs: [] },
    currentCutInfo: { cuts: {} },
    typeTagRegistryDocument: registry,
  }), /unapproved type tag/u);
});

test('checked-in type tag registry covers the current vocabulary', async () => {
  const registry = JSON.parse(await readFile(new URL('../../data/xiaosonglu/type_tag_registry.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateTypeTagRegistry(registry), []);
});

test('same-name curated chapters require evidence independent from the cut being reviewed', () => {
  const collectionUrl = 'https://www.bilibili.com/video/BV1collection/';
  const args = {
    segmentsDocument: { segments: [] },
    cutsDocument: structuredClone(emptyCuts),
    batch: {
      live: { date: '2026-09-09', liveId: 'same-name-test', title: 'test' },
      songs: [
        { songName: '疑似同名曲', cut: { url: collectionUrl, kind: 'collection' } },
        { songName: '疑似同名曲', cut: { clip_url: collectionUrl, kind: 'collection' } },
      ],
    },
  };
  assert.throws(() => importCuratedBatch(args), /search another uploader or Bilibili/u);
  args.batch.songs[1].sameNameReview = {
    decision: 'confirmed-repeat',
    evidenceUrl: `${collectionUrl}?p=2`,
    notes: '声称已核对，但证据仍是原合集。',
  };
  assert.throws(() => importCuratedBatch(args), /independent Bilibili video evidence URL/u);
  args.batch.songs[1].sameNameReview.evidenceUrl = 'https://m.bilibili.com/video/BV1collection/?p=3';
  assert.throws(() => importCuratedBatch(args), /independent Bilibili video evidence URL/u);
  args.batch.songs[1].sameNameReview.evidenceUrl = 'https://bilibili.com@evil.example/video/BV1fake/';
  assert.throws(() => importCuratedBatch(args), /independent Bilibili video evidence URL/u);
  args.batch.songs[1].sameNameReview.evidenceUrl = 'https://example.invalid/not-evidence';
  assert.throws(() => importCuratedBatch(args), /independent Bilibili video evidence URL/u);
  args.batch.songs[1].sameNameReview.evidenceUrl = 'https://www.bilibili.com:444/video/BV1collection/';
  assert.throws(() => importCuratedBatch(args), /independent Bilibili video evidence URL/u);
  args.batch.songs[1].sameNameReview.evidenceUrl = 'https://www.bilibili.com/video/BV1independent/';
  const reviewed = importCuratedBatch(args);
  assert.equal(reviewed.insertedSegments.length, 1);
  assert.equal(reviewed.skipped.length, 1);
  assert.equal(reviewed.dedupedSegments.length, 1);
});

test('reviewed same-name dedupe promotes a cut when a historical canonical fact had none', () => {
  const batch = {
    live: { date: '2026-09-09', liveId: 'mixed-cut-live', title: 'mixed cut' },
    songs: [{
      segmentIndex: 2,
      songName: '混合歌切曲',
      cut: { url: 'https://www.bilibili.com/video/BV1mixedcut/', bvid: 'BV1mixedcut', kind: 'collection' },
      sameNameReview: {
        decision: 'confirmed-repeat',
        evidenceUrl: 'https://www.bilibili.com/video/BV1independentmixed/',
        notes: '独立歌切确认第二章确为复唱。',
      },
    }],
  };
  const historicalFact = segment('2026-09-09', '混合歌切曲', { replay_id: 'live:mixed-cut-live', segment_index: 1, cut_link: '' });
  const imported = importCuratedBatch({ segmentsDocument: { segments: [historicalFact] }, cutsDocument: structuredClone(emptyCuts), batch });
  assert.equal(imported.insertedSegments.length, 0);
  assert.equal(imported.dedupedSegments.length, 1);
  assert.equal(imported.insertedCuts.length, 1);
  assert.equal(imported.insertedCuts[0].clip_url, 'https://www.bilibili.com/video/BV1mixedcut/?p=2');
});

test('same-name review cannot be bypassed by splitting one live across curated imports', () => {
  const collectionUrl = 'https://www.bilibili.com/video/BV1collection/';
  const args = {
    segmentsDocument: {
      segments: [segment('2026-09-09', '疑似同名曲', {
        replay_id: 'live:split-live', segment_index: 1, cut_link: collectionUrl,
      })],
    },
    cutsDocument: structuredClone(emptyCuts),
    batch: {
      live: { date: '2026-09-09', liveId: 'split-live', title: 'test' },
      songs: [{ segmentIndex: 2, songName: '疑似同名曲', cut: { url: collectionUrl, kind: 'collection' } }],
    },
  };
  assert.throws(() => importCuratedBatch(args), /independent Bilibili video evidence URL/u);
  args.batch.songs[0].sameNameReview = {
    decision: 'confirmed-repeat',
    evidenceUrl: 'https://www.bilibili.com/video/BV1independent/',
    notes: '使用独立歌切逐条核对，确认确为复唱。',
  };
  const reviewed = importCuratedBatch(args);
  assert.equal(reviewed.insertedSegments.length, 0);
  assert.equal(reviewed.skipped.length, 1);
  assert.equal(reviewed.dedupedSegments.length, 1);
});

test('reviewed fact replacement replays the chapter-18 correction and is independently recoverable', () => {
  const date = '2026-09-08';
  const replayId = 'live:correction-replay';
  const oldCut = {
    clip_date: date, song_name: '中华铄金娘', clip_url: 'https://www.bilibili.com/video/BV1qfYJ6gEm8/?p=18',
    clip_bvid: 'BV1qfYJ6gEm8', clip_kind: 'collection', duplicate_key: `${date}::中华铄金娘`, duplicate_status: 'primary',
  };
  const batch = {
    live: { date, liveId: 'correction-replay', title: 'correction' },
    songs: [
      {
        segmentIndex: 18, songName: '中华墨水娘', factAction: 'replace-existing-segment',
        factReplacementReason: 'reviewed correction', previousSongName: '中华铄金娘', previousCutBvid: 'BV1qfYJ6gEm8',
        cut: { url: 'https://www.bilibili.com/video/BV165YJ6gEUy/', bvid: 'BV165YJ6gEUy', kind: 'single' },
      },
      {
        segmentIndex: 22, songName: '中华铄金娘',
        cut: { url: 'https://www.bilibili.com/video/BV1ceYE6BEPo/', bvid: 'BV1ceYE6BEPo', kind: 'single' },
      },
    ],
  };
  const initial = {
    segmentsDocument: { segments: [segment(date, '中华铄金娘', { replay_id: replayId, segment_index: 18, cut_link: oldCut.clip_url })] },
    cutsDocument: { ...structuredClone(emptyCuts), items: [oldCut] },
    batch,
  };
  const corrected = importCuratedBatch(initial);
  assert.deepEqual(corrected.segmentsDocument.segments.map(item => [item.segment_index, item.song_name]), [[18, '中华墨水娘'], [22, '中华铄金娘']]);
  assert.deepEqual(corrected.cutsDocument.items.map(item => item.clip_bvid).sort(), ['BV165YJ6gEUy', 'BV1ceYE6BEPo'].sort());
  assert.equal(corrected.cutsDocument.items.some(item => item.clip_bvid === 'BV1qfYJ6gEm8'), false);
  const current = importCuratedBatch({ segmentsDocument: corrected.segmentsDocument, cutsDocument: corrected.cutsDocument, batch });
  assert.equal(current.insertedSegments.length, 0);
  assert.equal(current.cutsChanged, false);

  const partialSegments = structuredClone(corrected.segmentsDocument);
  partialSegments.segments[0].cut_link = oldCut.clip_url;
  const partialCuts = structuredClone(corrected.cutsDocument);
  partialCuts.items = partialCuts.items.filter(item => item.song_name !== '中华墨水娘');
  partialCuts.items.push(oldCut);
  const recovered = importCuratedBatch({ segmentsDocument: partialSegments, cutsDocument: partialCuts, batch });
  assert.equal(recovered.segmentsDocument.segments.find(item => item.segment_index === 18).cut_link, 'https://www.bilibili.com/video/BV165YJ6gEUy/');
  assert.equal(recovered.cutsDocument.items.some(item => item.clip_bvid === 'BV1qfYJ6gEm8'), false);
  assert.equal(recovered.cutsDocument.items.some(item => item.clip_bvid === 'BV165YJ6gEUy'), true);

  const wrong = structuredClone(initial);
  wrong.segmentsDocument.segments[0].song_name = '另一首歌';
  assert.throws(() => importCuratedBatch(wrong), /expected 中华铄金娘 or 中华墨水娘/u);
  assert.throws(() => importCuratedBatch({ ...initial, segmentsDocument: { segments: [] } }), /requires exactly one fact/u);
});

test('Bilibili collection cuts point to their exact chapter while standalone cuts stay bare', () => {
  const source = 'https://www.bilibili.com/video/BV1collection/?spm_id_from=test#fragment';
  assert.equal(canonicalizeBilibiliCutUrl(source, 'collection', 18), 'https://www.bilibili.com/video/BV1collection/?p=18');
  assert.equal(canonicalizeBilibiliCutUrl(source, 'collection-chapter', 22), 'https://www.bilibili.com/video/BV1collection/?p=22');
  assert.equal(canonicalizeBilibiliCutUrl('https://www.bilibili.com/video/BV1single/?p=18#stale', 'single', 18), 'https://www.bilibili.com/video/BV1single/');
  const invalidStandalone = {
    clip_date: '2026-09-09', song_name: '错误单集', clip_url: 'https://www.bilibili.com/video/BV1single/?p=18', clip_kind: 'single',
    duplicate_key: '2026-09-09::错误单集', duplicate_status: 'primary',
  };
  assert.match(validateCuts([invalidStandalone])[0], /standalone Bilibili cut must not contain/u);
});

test('curated cuts require one canonical nested cut kind', () => {
  const args = {
    segmentsDocument: { segments: [] },
    cutsDocument: structuredClone(emptyCuts),
    batch: { live: { date: '2026-09-09', liveId: 'cut-kind-test' }, songs: [{ songName: '歌', cut: { url: 'https://www.bilibili.com/video/BV1test/' } }] },
  };
  assert.throws(() => importCuratedBatch(args), /cut must declare kind/u);
  args.batch.songs[0].cut.kind = 'collections';
  assert.throws(() => importCuratedBatch(args), /unsupported kind collections/u);
  delete args.batch.songs[0].cut;
  args.batch.songs[0].cutLink = 'https://www.bilibili.com/video/BV1test/';
  args.batch.songs[0].cutKind = 'collection';
  assert.throws(() => importCuratedBatch(args), /nested cut object/u);
});

test('curated replace-existing audio actions require reviewed provenance and a stable target', () => {
  const args = {
    segmentsDocument: { segments: [] },
    cutsDocument: structuredClone(emptyCuts),
    batch: { live: { date: '2026-09-09', liveId: 'audio-action-test' }, songs: [{ songName: '歌', audioAction: 'replace-exsting', cut: curatedCut('BV1replacement') }] },
  };
  assert.throws(() => importCuratedBatch(args), /unsupported audioAction replace-exsting/u);
  args.batch.songs[0].audioAction = 'replace-existing';
  assert.throws(() => importCuratedBatch(args), /audioReplacementReason/u);
  Object.assign(args.batch.songs[0], {
    audioReplacementReason: 'reviewed',
    audioSha256: 'a'.repeat(64),
    audioBytes: 123,
    audioTarget: 'assets/audio/song_1.m4a',
    cut: { url: 'https://www.bilibili.com/video/BV1replacement/', bvid: 'BV1replacement', kind: 'single' },
  });
  assert.doesNotThrow(() => importCuratedBatch(args));
});

test('performance dedupe normalizes width, case, and whitespace but keeps different dates', () => {
  assert.equal(performanceKey('2026-09-01', ' Ｆｌｙ   My Wings '), performanceKey('2026-09-01', 'fly my wings'));
  assert.notEqual(performanceKey('2026-09-01', '同一首歌'), performanceKey('2026-09-02', '同一首歌'));
});

test('curated import is idempotent per date and song', () => {
  const documents = {
    segmentsDocument: { roomKey: 'xiaosonglu', roomId: '1727071052', updatedAt: '2026-01-01T00:00:00.000Z', segments: [segment('2026-09-01', '同一首歌', { replay_id: 'live:abc' })] },
    cutsDocument: structuredClone(emptyCuts),
  };
  const batch = {
    live: { liveId: 'abc', date: '2026-09-01', title: '测试' },
    songs: [
      { songName: ' 同一首歌 ', cut: curatedCut('BV1existing') },
      { songName: '新歌', startTime: '00:05:00', cut: curatedCut('BV1new') },
    ],
  };
  const first = importCuratedBatch({ ...documents, batch, now: '2026-09-02T00:00:00.000Z' });
  assert.deepEqual(first.skipped, ['2026-09-01::同一首歌']);
  assert.equal(first.insertedSegments.length, 2);
  const second = importCuratedBatch({ segmentsDocument: first.segmentsDocument, cutsDocument: first.cutsDocument, batch, now: '2026-09-03T00:00:00.000Z' });
  assert.equal(second.insertedSegments.length, 0);
  assert.equal(second.skipped.length, 2);
});

test('idempotent curated import recovers a missing cut ledger after a partial write', () => {
  const cutUrl = 'https://www.bilibili.com/video/BV1partialwrite/';
  const batch = {
    live: { liveId: 'partial-write', date: '2026-09-04', title: 'partial write' },
    songs: [{ segmentIndex: 1, songName: '待恢复歌切', cut: { url: cutUrl, bvid: 'BV1partialwrite', kind: 'single' } }],
  };
  const segmentsDocument = {
    segments: [segment('2026-09-04', '待恢复歌切', { replay_id: 'live:partial-write', segment_index: 1, cut_link: '' })],
  };
  const recovered = importCuratedBatch({ segmentsDocument, cutsDocument: structuredClone(emptyCuts), batch });
  assert.equal(recovered.insertedSegments.length, 1);
  assert.equal(recovered.segmentsDocument.segments[0].cut_link, cutUrl);
  assert.equal(recovered.insertedCuts.length, 1);
  assert.equal(recovered.cutsChanged, true);
  assert.equal(recovered.insertedCuts[0].clip_url, cutUrl);
  const replayed = importCuratedBatch({ segmentsDocument: recovered.segmentsDocument, cutsDocument: recovered.cutsDocument, batch });
  assert.equal(replayed.insertedCuts.length, 0);
  assert.equal(replayed.cutsChanged, false);
});

test('derived data counts repeat performances on different dates', () => {
  const segmentsDocument = {
    updatedAt: '2026-09-02T00:00:00.000Z',
    segments: [segment('2026-09-01', '复唱曲'), segment('2026-09-02', '复唱曲', { start_time: '00:03:00' })],
  };
  const data = buildDerivedData({
    segmentsDocument,
    cutsDocument: structuredClone(emptyCuts),
    overridesDocument: { bySongName: {} },
    currentCatalog: { songs: [] },
    currentCutInfo: { cuts: {} },
  });
  assert.equal(data.song_catalog.songs[0].sing_count, 2);
  assert.equal(data.song_catalog.songs[0].last_sing_at, '2026-09-02');
  assert.equal(data.song_details.bySongKey['复唱曲'].total_count, 2);
  assert.deepEqual(Object.keys(data.history_index.byDate), ['2026-09-01', '2026-09-02']);
});

test('validators reject duplicate performances and duplicate primary cuts', () => {
  assert.equal(validateSegments([segment('2026-09-01', '歌'), segment('2026-09-01', ' 歌 ', { segment_index: 2 })]).length, 1);
  const cut = {
    clip_date: '2026-09-01', song_name: '歌', clip_url: 'https://example.test/1', clip_kind: 'single',
    duplicate_key: '2026-09-01::歌', duplicate_status: 'primary',
  };
  assert.equal(validateCuts([cut, { ...cut, clip_url: 'https://example.test/2' }]).length, 1);
});

test('live discovery includes the baseline day and retries only non-terminal live IDs', () => {
  const startDate = Date.parse('2026-09-03T08:00:00Z');
  const live = (liveId, extra = {}) => ({
    liveId, startDate, stopDate: startDate + 60_000,
    isFinish: true, isFull: true, isMerged: true, title: liveId, ...extra,
  });
  const state = {
    baselineDate: '2026-09-03',
    processedLives: [
      { liveId: 'done', decision: 'no-songs' },
      { liveId: 'retry', decision: 'fetch-error' },
      { liveId: 'review', decision: 'review-needed' },
    ],
  };
  const found = discoverFromLives({
    lives: [live('done'), live('retry'), live('review'), live('new')],
    state,
    segmentsDocument: { segments: [segment('2026-09-03', '基线歌')] },
  });
  assert.deepEqual(found.unrecorded.map(item => item.liveId), ['retry', 'new']);
  assert.deepEqual(found.pendingReview.map(item => item.liveId), ['review']);
});

test('split curated imports preserve prior song keys and same-name review coordinates', () => {
  const firstReviews = collectSameNameReviews([{ songName: '复唱曲', sameNameReview: { decision: 'confirmed-repeat', evidenceUrl: 'https://www.bilibili.com/video/BV1evidence1/', notes: '第一批审核' } }]);
  assert.equal(firstReviews[0].segmentIndex, 1);
  const existing = { importedSongKeys: ['2026-09-09::第一首'], sameNameReviews: firstReviews };
  const secondReviews = collectSameNameReviews([{ segmentIndex: 3, songName: '另一复唱曲', sameNameReview: { decision: 'confirmed-repeat', evidenceUrl: 'https://www.bilibili.com/video/BV1evidence2/', notes: '第二批审核' } }]);
  const merged = mergeLiveImportEvidence(existing, ['2026-09-09::第二首'], secondReviews, '2026-09-09');
  assert.deepEqual(new Set(merged.importedSongKeys), new Set(['2026-09-09::第一首', '2026-09-09::第二首']));
  assert.deepEqual(merged.sameNameReviews.map(item => item.segmentIndex), [1, 3]);
});

test('ingestion-state terminal review is idempotent while preserving fetch checkpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xsl-state-'));
  const output = join(directory, 'state.json');
  const initial = {
    schemaVersion: 1,
    baselineDate: '2026-09-03',
    updatedAt: '2026-09-08T00:00:00.000Z',
    processedLives: [{ liveId: 'live', decision: 'review-needed', nextOffset: 500, scannedAt: '2026-09-08T00:00:00.000Z' }],
  };
  try {
    const first = await upsertLiveState(output, initial, { liveId: 'live', decision: 'imported', importedSongKeys: ['2026-09-03::歌'] }, { write: true });
    assert.equal(first.changed, true);
    assert.equal(first.entry.nextOffset, 500);
    const second = await upsertLiveState(output, first.state, { liveId: 'live', decision: 'imported', importedSongKeys: ['2026-09-03::歌'] }, { write: true });
    assert.equal(second.changed, false);
    assert.equal(second.entry.reviewedAt, first.entry.reviewedAt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('danmaku fetch resumes from an atomic page checkpoint and then reuses the complete artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xsl-danmaku-'));
  const output = join(directory, 'cached.json');
  const live = {
    liveId: 'live-checkpoint', title: '测试直播', isFinish: true, isFull: true, isMerged: true,
    startDate: Date.parse('2026-09-03T08:00:00Z'), stopDate: Date.parse('2026-09-03T09:00:00Z'),
  };
  const raw = (ts, text) => ({ ts, type: 1, payloadKind: 1, payload: { rawText: text } });
  const firstOffsets = [];
  try {
    await assert.rejects(fetchLiveDanmaku({
      liveId: live.liveId,
      live,
      pageSize: 2,
      output,
      fetcher: async url => {
        const offset = Number(new URL(url).searchParams.get('offset'));
        firstOffsets.push(offset);
        if (offset === 0) return { data: { total: 4, hasMore: true, records: [raw(live.startDate, '【第一句足够长的歌词】'), raw(live.startDate + 1_000, '普通弹幕')] } };
        throw new Error('simulated interruption');
      },
    }), /simulated interruption/u);
    assert.deepEqual(firstOffsets, [0, 2]);
    const partial = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(partial.checkpoint.nextOffset, 2);
    assert.equal(partial.checkpoint.complete, false);

    const resumedOffsets = [];
    const resumed = await fetchLiveDanmaku({
      liveId: live.liveId,
      live,
      pageSize: 2,
      output,
      fetcher: async url => {
        const offset = Number(new URL(url).searchParams.get('offset'));
        resumedOffsets.push(offset);
        return { data: { total: 4, hasMore: false, records: [raw(live.startDate + 2_000, '【第二句足够长的歌词】'), raw(live.startDate + 3_000, '普通弹幕二')] } };
      },
    });
    assert.deepEqual(resumedOffsets, [2]);
    assert.equal(resumed.result.checkpoint.complete, true);
    assert.equal(resumed.result.records.length, 4);

    let networkCalls = 0;
    const reused = await fetchLiveDanmaku({
      liveId: live.liveId,
      live,
      pageSize: 2,
      output,
      fetcher: async () => { networkCalls += 1; throw new Error('must not fetch'); },
    });
    assert.equal(reused.reused, true);
    assert.equal(networkCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
