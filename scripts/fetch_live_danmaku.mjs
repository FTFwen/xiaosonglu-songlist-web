#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchJson, formatDuration, isoDateInZone, parseArgs, readJson, requireString, writeJsonAtomic } from './lib/io.mjs';

const CHANNEL_URL = 'https://ukamnads.icu/api/v2/channel?uid=1891335475';
const DANMAKU_URL = liveId => `https://ukamnads.icu/api/v3/lives/${encodeURIComponent(liveId)}/danmakus`;

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

function textRecordIdentity(record) {
  return `${Number(record.ts)}\u0000${String(record.text ?? '')}`;
}

function mergeTextRecords(existing, page, startDate) {
  const byIdentity = new Map();
  for (const record of existing) byIdentity.set(textRecordIdentity(record), record);
  for (const record of page) {
    if (record.payloadKind !== 1 || typeof record.payload?.rawText !== 'string') continue;
    const normalized = {
      ts: Number(record.ts),
      offsetMs: Number(record.ts) - startDate,
      relativeTime: formatDuration((Number(record.ts) - startDate) / 1000),
      text: record.payload.rawText,
    };
    byIdentity.set(textRecordIdentity(normalized), normalized);
  }
  return [...byIdentity.values()].sort((left, right) => Number(left.ts) - Number(right.ts));
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

function makeResult({ live, date, startDate, target, cached, textRecords, apiTotal, nextOffset, complete, pageSize, fetchedRecords }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    source: 'ukamnads-danmaku-v3',
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
      nextOffset,
      apiTotal,
      complete,
      pageSize,
      updatedAt: now,
    },
    stats: {
      apiTotal,
      fetchedRecords,
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
  fetcher = fetchJson,
}) {
  const live = suppliedLive ?? await findLive(liveId, fetcher);
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

  let textRecords = Array.isArray(cached?.records) ? cached.records : [];
  let offset = Number(cached?.checkpoint?.nextOffset ?? 0);
  let apiTotal = Number(cached?.checkpoint?.apiTotal ?? cached?.stats?.apiTotal ?? 0);
  let fetchedRecords = Number(cached?.stats?.fetchedRecords ?? offset);
  let result = cached;

  for (;;) {
    const url = new URL(DANMAKU_URL(liveId));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(pageSize));
    const payload = await fetcher(url.href);
    const data = payload?.data ?? payload;
    const page = data?.frame?.records ?? data?.records ?? [];
    if (!Array.isArray(page)) throw new Error(`Danmaku page at offset ${offset} has no records array`);

    apiTotal = Number(data?.total ?? apiTotal);
    textRecords = mergeTextRecords(textRecords, page, startDate);
    const nextOffset = offset + page.length;
    fetchedRecords = Math.max(fetchedRecords, nextOffset);
    const complete = data?.hasMore !== true || page.length === 0;
    result = makeResult({
      live, date, startDate, target, cached: result ?? cached, textRecords,
      apiTotal, nextOffset, complete, pageSize, fetchedRecords,
    });

    // Artifact first: if state persistence is interrupted, the next run can still resume here.
    await writeJsonAtomic(target, result);
    if (typeof onCheckpoint === 'function') await onCheckpoint({ target, result, checkpoint: result.checkpoint });
    process.stderr.write(`[danmaku] ${liveId}: ${nextOffset}/${apiTotal || '?'}${complete ? ' complete' : ''}\n`);
    if (complete) break;
    offset = nextOffset;
  }

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
