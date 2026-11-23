#!/usr/bin/env node
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchLiveDanmaku } from './fetch_live_danmaku.mjs';
import { fetchJson, isoDateInZone, parseArgs, readJson, withFileLock, writeJsonAtomic, writeTextAtomic } from './lib/io.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CHANNEL_URL = 'https://api.ukamnads.icu/api/v2/channel?uId=1891335475';
const PUBLIC_URL = 'https://viridis.love/api/memes';
const USER_ID_START = 1_000_000;
const FIRST_NEW_SEED_ID = 86;
const MAX_SEEDS = 512;
const MAX_ADDITIONS = 6;
const RECENT_STREAMS = 20;
// 单场爆梗通道：一场之内刷到这么多次就够格，不看跨场覆盖。
const BURST_PEAK = 15;
const RECENT_AGE_MS = 30 * 86400_000;
const LIVE_ID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const byText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const natural = value => Number.isSafeInteger(value) && value >= 0;
const validId = value => natural(value) && value > 0;

// Whole-message keys follow the historical local ranking. Keep internal punctuation
// and emoji, and never count substrings or transliterate words.
export function memeKey(text) {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[\s\u200b-\u200d\ufeff]/gu, '');
  return normalized.replace(/[!?,.。！？、，~～…]+$/gu, '') || normalized;
}

// Positive publication gate: review short phrases from the local ranking here.
// No arbitrary archive text or public submission text can become a seed, however often
// it repeats. Add only safe, context-specific whole lines, never generic greetings,
// spam, links, identifiers, abuse, or ordinary audience conversation.
const REVIEWED = [
  '大大方方',
  '无穷无尽的卫',
  '宇宙冷漠',
];

function checkedRows(rows, label) {
  const ids = new Set();
  if (!Array.isArray(rows) || rows.some(row => !validId(row?.id) ||
    ids.has(row.id) || !ids.add(row.id) || typeof row.text !== 'string' || !memeKey(row.text) ||
    typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
    !Array.isArray(row.tags) || !row.tags.length || row.tags.some(tag => typeof tag !== 'string' || !tag.trim()))) {
    throw new Error(`Invalid ${label} rows`);
  }
  return rows;
}

function publicSubmissions(payload, seed) {
  if (payload?.ok !== true) throw new Error('Public meme list unavailable');
  const rows = checkedRows(payload.entries, 'public meme');
  const seedById = new Map(seed.map(row => [row.id, row]));
  const publicById = new Map(rows.map(row => [row.id, row]));
  for (const row of seed) {
    if (row.id < FIRST_NEW_SEED_ID && !publicById.has(row.id)) {
      throw new Error(`Public meme list is missing baseline seed ${row.id}`);
    }
  }
  return rows.filter(row => {
    const local = seedById.get(row.id);
    if (local && memeKey(local.text) !== memeKey(row.text)) {
      throw new Error(`Public meme ID ${row.id} collides with the local seed`);
    }
    return !local;
  });
}

async function optionalJson(path) {
  try { return await readJson(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function verifyPrevious(previous) {
  if (previous === null) return;
  const counts = previous?.counts;
  const coverage = previous?.coverage?.streams;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
    !Object.entries(counts).every(([id, n]) => String(Number(id)) === id && validId(Number(id)) && natural(n)) ||
    (coverage !== undefined && (!coverage || typeof coverage !== 'object' || Array.isArray(coverage) ||
      !Object.entries(coverage).every(([id, pair]) => LIVE_ID.test(id) && Array.isArray(pair) &&
        pair.length === 2 && pair.every(natural))))) {
    throw new Error('Prior danmaku stats are invalid');
  }
}

export function completeArchive(archive) {
  const { live, stats, checkpoint, records, schemaVersion } = archive ?? {};
  if (live?.isFinish !== true || live.isFull !== true || !LIVE_ID.test(live.liveId ?? '') ||
    !validId(live.startDate) || !validId(live.stopDate) || live.startDate > live.stopDate ||
    !Array.isArray(records) || records.length !== stats?.textRecords || !natural(stats.apiTotal) ||
    stats.fetchedRecords !== stats.apiTotal || records.length > stats.apiTotal) return false;
  const paginated = schemaVersion === 2 && checkpoint?.complete === true &&
    checkpoint.apiTotal === stats.apiTotal && checkpoint.nextOffset === stats.apiTotal;
  if (!paginated && !(schemaVersion === 1 && checkpoint === undefined)) return false;
  return records.every(record => validId(record?.ts) && typeof record?.text === 'string');
}

async function archiveFiles(directory, pattern) {
  try {
    const files = await readdir(directory, { withFileTypes: true });
    return files.filter(file => file.isFile() && pattern.test(file.name)).map(file => join(directory, file.name)).sort(byText);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function loadArchives(root, cache) {
  const files = (await Promise.all([
    archiveFiles(join(root, 'data/xiaosonglu'), /^_danmaku_.*\.json$/u),
    archiveFiles(cache, /^[a-f\d-]{36}\.json$/iu),
  ])).flat();
  const archives = new Map();
  for (const file of files) {
    let archive;
    try { archive = await readJson(file); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.error(`[sync-live-memes] Invalid archive JSON: ${basename(file)}`);
      continue;
    }
    if (!completeArchive(archive)) continue;
    const id = archive.live.liveId;
    const existing = archives.get(id);
    if (!existing || archive.stats.apiTotal > existing.stats.apiTotal ||
      (archive.stats.apiTotal === existing.stats.apiTotal && archive.records.length > existing.records.length)) {
      archives.set(id, archive);
    }
  }
  return archives;
}

function readChannel(payload) {
  const data = payload?.data ?? payload;
  const lives = data?.lives;
  if (!Array.isArray(lives) || !lives.length || data.hasMoreLives !== false || data.totalLives !== lives.length ||
    new Set(lives.map(live => live?.liveId)).size !== lives.length || lives.some(live =>
      !LIVE_ID.test(live?.liveId ?? '') || !validId(live.startDate) || typeof live.isFinish !== 'boolean' ||
      typeof live.isFull !== 'boolean' || (live.isFinish && (!validId(live.stopDate) || live.stopDate < live.startDate)))) {
    throw new Error('Upstream channel listing is incomplete or malformed');
  }
  return new Map(lives.map(live => [live.liveId, live]));
}

function pageFetcher() {
  let expectedTotal;
  return async href => {
    await delay(1150);
    // Keep rate-limit pressure low. An unsuccessful fetch leaves the existing checkpoint.
    const payload = await fetchJson(href, { retries: 1, timeoutMs: 25_000 });
    const data = payload?.data ?? payload;
    const records = data?.frame?.records ?? data?.records;
    const offset = Number(new URL(href).searchParams.get('offset'));
    const next = offset + (records?.length ?? 0);
    if (!Array.isArray(records) || data.offset !== offset || !natural(data.total) ||
      (expectedTotal !== undefined && data.total !== expectedTotal) || next > data.total ||
      data.hasMore !== (next < data.total) || (data.hasMore && !records.length) || records.some(record =>
        record?.payloadKind === 1 && (!validId(record.ts) || typeof record.payload?.rawText !== 'string'))) {
      throw new Error(`Incomplete or inconsistent danmaku page at offset ${offset}`);
    }
    expectedTotal = data.total;
    return payload;
  };
}

function requiredLives(channel) {
  return [...channel.values()].filter(live => live.isFinish && live.isFull)
    .sort((a, b) => b.startDate - a.startDate || byText(a.liveId, b.liveId));
}

async function fillArchives({ archives, channel, cache, localOnly }) {
  for (const live of requiredLives(channel)) {
    const id = live.liveId;
    if (archives.has(id)) continue;
    if (localOnly) throw new Error(`Completed stream ${id} has no complete local archive`);
    const output = join(cache, `${id}.json`);
    const existing = await optionalJson(output);
    // The shared fetcher trusts a completion marker. Keep suspect finalized files
    // intact and rebuild into a different checkpoint so they cannot be silently reused.
    const target = existing && (existing.checkpoint?.complete || existing.schemaVersion === 1)
      ? join(cache, 'rebuild', `${id}.json`) : output;
    const { result } = await fetchLiveDanmaku({ liveId: id, live, output: target, pageSize: 1000, fetcher: pageFetcher() });
    if (!completeArchive(result)) throw new Error(`Completed stream ${id} has an incomplete downloaded archive`);
    if (target !== output) await writeJsonAtomic(output, result);
    archives.set(id, result);
  }
}

function verifyCoverage(archives, channel, previous) {
  if (!archives.size) throw new Error('No complete livestream archives');
  for (const [id, [events, texts]] of Object.entries(previous?.coverage?.streams ?? {})) {
    const archive = archives.get(id);
    if (!archive || archive.stats.apiTotal < events || archive.records.length < texts ||
      (channel.has(id) && !(channel.get(id).isFinish && channel.get(id).isFull))) {
      throw new Error(`Prior archive coverage shrank for ${id}`);
    }
  }
}

export function countAndSelect({ archives, channel, seed, users, previous, now = Date.now(), additions = true, reviewed = REVIEWED, discover = false }) {
  const keys = new Set([...seed, ...users].map(row => memeKey(row.text)));
  const discovery = new Map();
  const candidates = new Map(reviewed.filter(text => additions && !keys.has(memeKey(text)))
    .map(text => [memeKey(text), { text, streams: 0, dates: new Set(), recent: 0, peak: 0 }]));
  const recentIds = new Set(requiredLives(channel).filter(live => live.stopDate <= now &&
    live.stopDate >= now - RECENT_AGE_MS).slice(0, RECENT_STREAMS).map(live => live.liveId));
  const totals = new Map([...keys, ...candidates.keys()].map(key => [key, 0]));
  const first = new Map();
  const coverage = {};
  let messages = 0;
  let from = null;
  let through = null;
  for (const [id, archive] of [...archives].sort(([a], [b]) => byText(a, b))) {
    const current = channel.get(id);
    if (current && !(current.isFinish && current.isFull)) continue;
    const date = isoDateInZone(archive.live.startDate);
    from = from === null || date < from ? date : from;
    through = through === null || date > through ? date : through;
    coverage[id] = [archive.stats.apiTotal, archive.records.length];
    messages += archive.records.length;
    const recent = recentIds.has(id) ? new Map() : null;
     for (const { text, ts } of archive.records) {
      const key = memeKey(text);
      if (discover && recent && !keys.has(key) && key.length >= 4 && key.length <= 45 && /\p{Script=Han}/u.test(key)) {
        const entry = discovery.get(key) ?? { text, count: 0, streams: new Set() };
        entry.count++;
        entry.streams.add(id);
        discovery.set(key, entry);
      }
      const total = totals.get(key);
      if (total === undefined) continue;
      totals.set(key, total + 1);
      if (!candidates.has(key)) continue;
      first.set(key, Math.min(first.get(key) ?? ts, ts));
      if (!recent) continue;
      const stream = recent.get(key) ?? { count: 0, min: ts, max: ts };
      stream.count++;
      stream.min = Math.min(stream.min, ts);
      stream.max = Math.max(stream.max, ts);
      recent.set(key, stream);
    }
    for (const [key, stream] of recent ?? []) {
      const candidate = candidates.get(key);
      candidate.recent += stream.count;
      candidate.peak = Math.max(candidate.peak, stream.count);
      if (stream.count >= 3 && stream.max - stream.min >= 60_000) {
        candidate.streams++;
        candidate.dates.add(date);
      }
    }
  }
  // 准入门槛（2026-11-23 放宽两档）：
  //   A. 常规梗：30 天内累计 ≥15 次、≥2 场里各 ≥3 次且跨度 ≥60 秒、≥2 个不同直播日，
  //      且单场最高峰不超过总数的 70%。
  //   B. 单场爆梗：只在一场火起来也算——单场刷到 ≥15 次，且整场里不是单字复读
  //      （至少 3 个不同字符，且含汉字或拉丁字母）。B 通道给「一夜爆火」的梗留门。
  const burst = candidate => candidate.peak >= BURST_PEAK
    && new Set(memeKey(candidate.text)).size >= 3
    && /[\p{Script=Han}a-z]/iu.test(candidate.text);
  const winners = [...candidates].filter(([, c]) =>
    (c.recent >= 15 && c.streams >= 2 && c.dates.size >= 2 && c.peak * 10 <= c.recent * 7) || burst(c))
    .sort(([a, x], [b, y]) => y.streams - x.streams || y.recent - x.recent || byText(a, b));
  const occupied = new Set([...seed, ...users].map(row => row.id));
  let nextId = Math.max(FIRST_NEW_SEED_ID, ...seed.map(row => row.id + 1));
  const appended = [];
  for (const [key, candidate] of winners.slice(0, Math.min(MAX_ADDITIONS, MAX_SEEDS - seed.length))) {
    while (occupied.has(nextId)) nextId++;
    if (nextId >= USER_ID_START) break;
    appended.push({ id: nextId++, date: isoDateInZone(first.get(key)), tags: ['直播弹幕', '玩梗'], text: candidate.text });
  }
  const counts = {};
  for (const { id, text } of [...seed, ...appended, ...users].sort((a, b) => a.id - b.id)) {
    counts[id] = Math.max(totals.get(memeKey(text)) ?? 0, previous?.counts[id] ?? 0);
  }
  const suggestions = [...discovery.values()].filter(item => item.count >= 15)
    .sort((a, b) => b.streams.size - a.streams.size || b.count - a.count || byText(a.text, b.text))
    .slice(0, 100).map(({ text, count, streams }) => ({ text, count, streams: streams.size }));
  return { appended, stats: { counts, coverage: { from, through, messages, streams: coverage } }, suggestions };
}

async function sync({ dryRun, localOnly, review, root = ROOT }) {
  const cache = join(root, '.tmp/meme-danmaku');
  const seedPath = join(root, 'memes/seed.json');
  const statsPath = join(root, 'memes/danmaku-stats.json');
  const seedSource = await readFile(seedPath, 'utf8');
  const seed = checkedRows(JSON.parse(seedSource), 'seed');
  if (!seed.length || seed.length > MAX_SEEDS || seed.some(row => row.id >= USER_ID_START)) throw new Error('Invalid seed catalog');
  const [previous, publicPayload, channelPayload, archives] = await Promise.all([
    optionalJson(statsPath), fetchJson(PUBLIC_URL), fetchJson(CHANNEL_URL), loadArchives(root, cache),
  ]);
  verifyPrevious(previous);
  const users = publicSubmissions(publicPayload, seed);
  const channel = readChannel(channelPayload);
  await fillArchives({ archives, channel, cache, localOnly });
  verifyCoverage(archives, channel, previous);
  const approved = await optionalJson(join(root, '.tmp/approved-live-memes.json')) ?? [];
  if (!Array.isArray(approved) || approved.length > 100 || approved.some(text =>
    typeof text !== 'string' || !memeKey(text) || text.length > 90 || /[\r\n]/u.test(text))) {
    throw new Error('Invalid approved meme list');
  }
  const { appended, stats, suggestions } = countAndSelect({ archives, channel, seed, users, previous,
    reviewed: [...new Set([...REVIEWED, ...approved].map(memeKey))].map(key =>
      [...REVIEWED, ...approved].find(text => memeKey(text) === key)), discover: review });
  if (review) {
    await writeJsonAtomic(join(root, '.tmp/live-meme-candidates.json'), suggestions);
    console.log(`Prepared ${suggestions.length} local candidates for review.`);
    return;
  }
  const changed = JSON.stringify(previous) !== JSON.stringify(stats) || appended.length > 0;
  if (!dryRun && changed) {
    if (appended.length) {
      const original = seedSource.trimEnd();
      const tail = original.lastIndexOf(']');
      const items = JSON.stringify(appended, null, 2).slice(2, -2);
      // Publish seed first: interruption can delay new counts but never creates orphan stats IDs.
      await writeTextAtomic(seedPath, `${original.slice(0, tail).trimEnd()},\n${items}\n]\n`);
    }
    await writeJsonAtomic(statsPath, stats);
  }
  console.log(JSON.stringify({ dryRun, changed, completedArchives: Object.keys(stats.coverage.streams).length,
    unavailableEndedStreams: [...channel.values()].filter(live => live.isFinish && !live.isFull).length,
    coverage: { from: stats.coverage.from, through: stats.coverage.through, messages: stats.coverage.messages },
    seeds: seed.length + appended.length, submissions: users.length, countKeys: Object.keys(stats.counts).length,
    appended: appended.map(row => ({ ...row, count: stats.counts[row.id] })),
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const flags = ['help', 'dry-run', 'local-only', 'review'];
  if (Object.entries(args).some(([flag, value]) => !flags.includes(flag) || value !== true)) throw new Error('Unknown argument; use --help');
  if (args.help) {
    console.log('Usage: node scripts/sync_live_memes.mjs [--dry-run] [--local-only]\n' +
      'GETs the channel and public meme list. Reuses complete local archives and fetches missing completed ones.\n' +
      '--dry-run    Preview with no file writes or archive downloads.\n' +
      '--local-only Count only with the local archives (public GETs still required).\n' +
      '--review     Download missing archives and write local candidates without changing public data.');
    return;
  }
  if (args.review && args['dry-run']) throw new Error('--review writes a local report and cannot be used with --dry-run');
  const options = { dryRun: args['dry-run'] === true, localOnly: !!(args['local-only'] || args['dry-run']), review: args.review === true };
  if (options.dryRun) return sync(options);
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  await withFileLock(join(ROOT, '.tmp/sync-live-memes.lock'), () => sync(options));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[sync-live-memes] ${error.message}; existing public data kept if validation failed.`);
    process.exitCode = 1;
  });
}
