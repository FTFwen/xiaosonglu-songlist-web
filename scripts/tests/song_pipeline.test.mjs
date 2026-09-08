import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clusterLyrics, lyricBody } from '../cluster_lyrics.mjs';
import { fetchLiveDanmaku } from '../fetch_live_danmaku.mjs';
import { discoverFromLives } from '../scan_unrecorded_lives.mjs';
import { upsertLiveState } from '../lib/ingestion-state.mjs';
import { buildDerivedData, importCuratedBatch, performanceKey, validateCuts, validateSegments } from '../lib/song-data.mjs';

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

const emptyCuts = {
  roomKey: 'xiaosonglu', roomId: '1727071052', sourceType: 'bilibili-song-cut-index', updatedAt: '2026-01-01T00:00:00.000Z', items: [],
};

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

test('performance dedupe normalizes width, case, and whitespace but keeps different dates', () => {
  assert.equal(performanceKey('2026-09-01', ' Ｆｌｙ   My Wings '), performanceKey('2026-09-01', 'fly my wings'));
  assert.notEqual(performanceKey('2026-09-01', '同一首歌'), performanceKey('2026-09-02', '同一首歌'));
});

test('curated import is idempotent per date and song', () => {
  const documents = {
    segmentsDocument: { roomKey: 'xiaosonglu', roomId: '1727071052', updatedAt: '2026-01-01T00:00:00.000Z', segments: [segment('2026-09-01', '同一首歌')] },
    cutsDocument: structuredClone(emptyCuts),
  };
  const batch = {
    live: { liveId: 'abc', date: '2026-09-01', title: '测试' },
    songs: [{ songName: ' 同一首歌 ' }, { songName: '新歌', startTime: '00:05:00' }],
  };
  const first = importCuratedBatch({ ...documents, batch, now: '2026-09-02T00:00:00.000Z' });
  assert.deepEqual(first.skipped, ['2026-09-01::同一首歌']);
  assert.equal(first.insertedSegments.length, 1);
  const second = importCuratedBatch({ segmentsDocument: first.segmentsDocument, cutsDocument: first.cutsDocument, batch, now: '2026-09-03T00:00:00.000Z' });
  assert.equal(second.insertedSegments.length, 0);
  assert.equal(second.skipped.length, 2);
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
  assert.equal(validateSegments([segment('2026-09-01', '歌'), segment('2026-09-01', ' 歌 ')]).length, 1);
  const cut = {
    clip_date: '2026-09-01', song_name: '歌', clip_url: 'https://example.test/1',
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
