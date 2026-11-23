#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatDuration, isoDateInZone, fetchJson, parseArgs, readJson, requireString, writeJsonAtomic } from './lib/io.mjs';
import { decodeMsgpack } from './lib/msgpack.mjs';

// danmakus.com replaced the paginated JSON archive with a single MessagePack
// snapshot: GET /api/v3/lives/{id}/full?include=extra&includeEnter=false
// returns [channel, live, extra] where extra = [baseTimestamp, actors, emoticons, records]
// and every record is [deltaMs, type, actorIndex, uploadAccountId, subtype, payload].
// Timestamps are delta encoded: sendDate = extra[0] + cumulativeSum(record[0]).
const CHANNEL_URL = 'https://api.ukamnads.icu/api/v2/channel?uId=1891335475';
const ARCHIVE_URL = liveId => `https://api.ukamnads.icu/api/v3/lives/${encodeURIComponent(liveId)}/full?include=extra&includeEnter=false`;
const SUBTYPE_TEXT_MESSAGE = 1;

function unwrap(payload, field) {
  if (payload?.data?.[field] !== undefined) return payload.data[field];
  return payload?.[field];
}

async function findLive(liveId, fetcher = fetchJson) {
  const payload = await fetcher(CHANNEL_URL);
  const lives = unwrap(payload, 'lives') ?? [];
  const live = lives.find(item => item.liveId === liveId);
  if (!live) throw new Error(`Live ${liveId} was not found in the channel feed`);
  return live;
}

export async function fetchArchiveBinary(url, fetcher = globalThis.fetch) {
  const response = await fetcher(url, { headers: { accept: 'application/x-msgpack, application/octet-stream;q=0.9, */*;q=0.1' } });
  if (!response.ok) throw new Error(`Danmaku archive request failed: HTTP ${response.status}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error('Danmaku archive request returned an empty body');
  if (buffer[0] === 0x7b) {
    throw new Error(`Danmaku archive request returned JSON instead of MessagePack: ${new TextDecoder().decode(buffer.subarray(0, 160))}`);
  }
  return buffer;
}

export function decodeLiveArchive(buffer, startDate) {
  const root = decodeMsgpack(buffer);
  if (!Array.isArray(root) || root.length < 3) throw new Error('Danmaku archive payload does not match [channel, live, extra]');
  const [channelTuple, liveTuple, extra] = root;
  if (!Array.isArray(extra) || extra.length < 4) throw new Error('Danmaku archive payload has no record block');

  const baseTimestamp = Number(extra[0]);
  const actors = Array.isArray(extra[1]) ? extra[1] : [];
  const rawRecords = Array.isArray(extra[3]) ? extra[3] : [];
  if (!Number.isFinite(baseTimestamp)) throw new Error('Danmaku archive payload has no base timestamp');

  let cursor = baseTimestamp;
  const byIdentity = new Map();
  for (const raw of rawRecords) {
    if (!Array.isArray(raw) || raw.length < 6) continue;
    cursor += Number(raw[0] ?? 0);
    if (Number(raw[4]) !== SUBTYPE_TEXT_MESSAGE) continue;
    const payload = raw[5];
    const text = Array.isArray(payload) && typeof payload[0] === 'string' ? payload[0] : null;
    if (!text) continue;
    const actorIndex = Number(raw[2]);
    const actor = actorIndex > 0 ? actors[actorIndex - 1] : undefined;
    const record = {
      ts: cursor,
      offsetMs: cursor - startDate,
      relativeTime: formatDuration((cursor - startDate) / 1000),
      text,
      ...(Array.isArray(actor) ? { userId: actor[0], userName: actor[1] } : {}),
    };
    byIdentity.set(`${record.ts}\u0000${text}`, record);
  }

  return {
    channel: Array.isArray(channelTuple) ? { uId: channelTuple[0], uName: channelTuple[1], roomId: channelTuple[2] } : null,
    live: Array.isArray(liveTuple)
      ? {
        liveId: liveTuple[0],
        title: liveTuple[1],
        startDate: liveTuple[3],
        stopDate: liveTuple[4],
        isFinish: liveTuple[5] === true,
        isFull: liveTuple[6] === true,
        isMerged: liveTuple[7] === true,
        danmakusCount: Number(liveTuple[8] ?? 0),
      }
      : null,
    rawRecordCount: rawRecords.length,
    textRecords: [...byIdentity.values()].sort((left, right) => Number(left.ts) - Number(right.ts) || String(left.text).localeCompare(String(right.text))),
  };
}

async function readCachedResult(target) {
  try {
    return await readJson(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function isCompleteCache(cached) {
  if (!cached) return false;
  if (cached.checkpoint?.complete === true) return true;
  // schema v1 was written only after every page had been fetched.
  return cached.schemaVersion === 1 && Array.isArray(cached.records) && cached.stats;
}

function makeResult({ live, date, startDate, target, cached, textRecords, apiTotal, rawRecordCount, complete, pageSize }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    source: 'danmakus-live-full-v3',
    fetchedAt: cached?.fetchedAt ?? now,
    updatedAt: now,
    live: {
      liveId: live.liveId,
      title: live.title ?? '',
      isFinish: live.isFinish === true,
      isFull: live.isFull === true,
      isMerged: live.isMerged === true,
      startDate,
      stopDate: Number(live.stopDate),
      date,
      startIso: new Date(startDate).toISOString(),
      stopIso: new Date(Number(live.stopDate)).toISOString(),
    },
    checkpoint: {
      nextOffset: rawRecordCount,
      apiTotal,
      complete,
      pageSize,
      rawRecords: rawRecordCount,
      updatedAt: now,
    },
    stats: {
      apiTotal,
      fetchedRecords: rawRecordCount,
      textRecords: textRecords.length,
      firstTextAt: textRecords.at(0)?.ts ?? null,
      lastTextAt: textRecords.at(-1)?.ts ?? null,
    },
    records: textRecords,
    localFile: target,
  };
}

export async function fetchLiveDanmaku({
  liveId,
  live: suppliedLive,
  pageSize = 500,
  output,
  expectedDate,
  onCheckpoint,
  fetcher = fetchArchiveBinary,
}) {
  const live = suppliedLive ?? await findLive(liveId);
  if (live.liveId !== liveId) throw new Error(`Supplied live metadata belongs to ${live.liveId}, not ${liveId}`);
  const startDate = Number(live.startDate);
  const date = isoDateInZone(startDate);
  if (expectedDate && date !== expectedDate) {
    throw new Error(`Live ${liveId} belongs to ${date}, not requested date ${expectedDate}`);
  }

  const target = output ?? resolve(`data/xiaosonglu/_danmaku_${date}_${liveId.slice(0, 8)}.json`);
  const cached = await readCachedResult(target);
  if (cached?.live?.liveId && cached.live.liveId !== liveId) {
    throw new Error(`Cached artifact ${target} belongs to ${cached.live.liveId}, not ${liveId}`);
  }
  if (isCompleteCache(cached)) return { target, result: cached, reused: true };

  const archive = await fetcher(ARCHIVE_URL(liveId));
  const decoded = decodeLiveArchive(archive, startDate);
  if (decoded.live?.liveId && decoded.live.liveId !== liveId) {
    throw new Error(`Danmaku archive belongs to ${decoded.live.liveId}, not ${liveId}`);
  }

  const apiTotal = Math.max(Number(decoded.live?.danmakusCount ?? 0), decoded.rawRecordCount);
  const result = makeResult({
    live,
    date,
    startDate,
    target,
    cached,
    textRecords: decoded.textRecords,
    apiTotal,
    rawRecordCount: decoded.rawRecordCount,
    complete: true,
    pageSize,
  });

  // Artifact first: if state persistence is interrupted, the next run can still resume here.
  await writeJsonAtomic(target, result);
  if (typeof onCheckpoint === 'function') await onCheckpoint({ target, result, checkpoint: result.checkpoint });
  process.stderr.write(`[danmaku] ${liveId}: ${decoded.rawRecordCount}/${apiTotal || '?'} records, ${result.stats.textRecords} text complete\n`);

  return { target, result, reused: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const liveId = requireString(args['live-id'], '--live-id');
  const pageSize = Number(args['page-size'] ?? 500);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('--page-size must be 1..1000');
  const { target, result, reused } = await fetchLiveDanmaku({
    liveId,
    pageSize,
    output: args.output ? resolve(String(args.output)) : undefined,
    expectedDate: args.date ? String(args.date) : undefined,
  });
  console.log(JSON.stringify({
    ok: true,
    output: target,
    reused,
    live: result.live,
    checkpoint: result.checkpoint ?? { complete: true, nextOffset: result.stats?.fetchedRecords ?? 0 },
    stats: result.stats,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[fetch-live-danmaku] ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}
