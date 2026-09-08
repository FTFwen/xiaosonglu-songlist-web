#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clusterLyrics } from './cluster_lyrics.mjs';
import { fetchLiveDanmaku } from './fetch_live_danmaku.mjs';
import { loadIngestionState, upsertLiveState } from './lib/ingestion-state.mjs';
import { fetchJson, isoDateInZone, parseArgs, readJson, withFileLock, writeJsonAtomic } from './lib/io.mjs';

const CHANNEL_URL = 'https://ukamnads.icu/api/v2/channel?uid=1891335475';
const FETCHED_DECISIONS = new Set(['no-songs', 'review-needed', 'imported', 'deferred']);

export function discoverFromLives({ lives, state, segmentsDocument, since = '' }) {
  const latestSegmentDate = segmentsDocument.segments.map(item => item.replay_date).filter(Boolean).sort().at(-1) ?? '';
  const baselineDate = since || state.baselineDate || latestSegmentDate;
  const byLiveId = new Map(state.processedLives.map(item => [item.liveId, item]));
  const pendingReview = state.processedLives.filter(item => item.decision === 'review-needed' || item.decision === 'deferred');
  const unrecorded = lives
    .filter(live => live.isFinish === true && live.isFull === true && live.isMerged === true)
    .map(live => ({ ...live, date: isoDateInZone(Number(live.startDate)) }))
    // Include the baseline day: liveId, not an exclusive date watermark, decides duplication.
    .filter(live => live.date >= baselineDate && !FETCHED_DECISIONS.has(byLiveId.get(live.liveId)?.decision))
    .sort((left, right) => Number(left.startDate) - Number(right.startDate));
  return { baselineDate, unrecorded, pendingReview };
}

async function discover(state, segmentsDocument, since) {
  const payload = await fetchJson(CHANNEL_URL);
  const lives = payload?.data?.lives ?? payload?.lives ?? [];
  return discoverFromLives({ lives, state, segmentsDocument, since });
}

function baseLiveEntry(live) {
  return {
    liveId: live.liveId,
    date: live.date,
    title: live.title ?? '',
    startDate: Number(live.startDate),
    stopDate: Number(live.stopDate),
  };
}

async function runScan({ args, root, statePath, segmentsPath }) {
  let state = await loadIngestionState(statePath);
  const segmentsDocument = await readJson(segmentsPath);
  const found = await discover(state, segmentsDocument, args.since ? String(args.since) : '');
  if (!state.baselineDate) state.baselineDate = found.baselineDate;
  const limit = Number(args.limit ?? 10);
  const selected = found.unrecorded.slice(0, limit);
  const scanned = [];
  const failures = [];

  if (args.write === true) {
    for (const live of selected) {
      const base = baseLiveEntry(live);
      try {
        let updated = await upsertLiveState(statePath, state, {
          ...base,
          decision: 'fetching',
          importedSongKeys: [],
          notes: '弹幕分页抓取中；中断后从本地 artifact checkpoint 继续。',
        }, { write: true });
        state = updated.state;

        const fetched = await fetchLiveDanmaku({
          liveId: live.liveId,
          live, // Reuse the one channel response from discovery.
          onCheckpoint: async ({ target, checkpoint }) => {
            updated = await upsertLiveState(statePath, state, {
              ...base,
              sourceFile: basename(target),
              decision: 'fetching',
              nextOffset: checkpoint.nextOffset,
              apiTotal: checkpoint.apiTotal,
              fetchComplete: checkpoint.complete,
              importedSongKeys: [],
              notes: checkpoint.complete
                ? '弹幕抓取完成，等待候选聚类。'
                : `弹幕抓取中，下次从 offset ${checkpoint.nextOffset} 继续。`,
            }, { write: true });
            state = updated.state;
          },
        });
        const candidate = clusterLyrics(fetched.result, {
          gapSeconds: args['gap-seconds'] ?? 150,
          minimumLength: args['minimum-length'] ?? 6,
          minimumLines: args['minimum-lines'] ?? 1,
          contextSeconds: args['context-seconds'] ?? 45,
        });
        const candidatePath = fetched.target.replace(/_danmaku_/, '_candidate_');
        await writeJsonAtomic(candidatePath, candidate);
        const hasCandidates = candidate.stats.candidateClusters > 0;
        const entry = {
          ...base,
          sourceFile: basename(fetched.target),
          candidateFile: basename(candidatePath),
          nextOffset: Number(fetched.result.checkpoint?.nextOffset ?? fetched.result.stats?.fetchedRecords ?? 0),
          apiTotal: Number(fetched.result.checkpoint?.apiTotal ?? fetched.result.stats?.apiTotal ?? 0),
          fetchComplete: true,
          reusedArtifact: fetched.reused === true,
          lyricLineCount: candidate.stats.lyricLines,
          candidateClusterCount: candidate.stats.candidateClusters,
          decision: hasCandidates ? 'review-needed' : 'no-songs',
          importedSongKeys: [],
          notes: hasCandidates ? '存在括号歌词候选，需结合上下文与歌切人工复核。' : '未发现符合规则的括号歌词弹幕，自动标记为无歌。',
        };
        updated = await upsertLiveState(statePath, state, entry, { write: true });
        state = updated.state;
        scanned.push(updated.entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const current = state.processedLives.find(item => item.liveId === live.liveId) ?? {};
        const updated = await upsertLiveState(statePath, state, {
          ...current,
          ...base,
          decision: 'fetch-error',
          notes: `可重试抓取失败：${message}`,
        }, { write: true });
        state = updated.state;
        failures.push({ liveId: live.liveId, error: message });
      }
    }
  }

  const currentPending = state.processedLives.filter(item => item.decision === 'review-needed' || item.decision === 'deferred');
  console.log(JSON.stringify({
    ok: failures.length === 0,
    mode: args.write ? 'write' : 'discover-only',
    baselineDate: found.baselineDate,
    discoveredCount: found.unrecorded.length,
    selectedCount: selected.length,
    discovered: found.unrecorded.map(live => ({ liveId: live.liveId, date: live.date, title: live.title, startDate: live.startDate })),
    scanned,
    failures,
    pendingReview: currentPending,
    statePath,
  }, null, 2));
  if (failures.length) process.exitCode = 2;
  else if (currentPending.length) process.exitCode = 3;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(String(args.root ?? '.'));
  const statePath = resolve(root, String(args.state ?? 'data/xiaosonglu/ingestion_state.json'));
  const segmentsPath = resolve(root, 'data/xiaosonglu/replay_song_segments.json');
  if (args.write === true) {
    const lockPath = resolve(root, 'data/xiaosonglu/_ingestion_scan.lock');
    await withFileLock(lockPath, () => runScan({ args, root, statePath, segmentsPath }));
  } else {
    await runScan({ args, root, statePath, segmentsPath });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[scan-unrecorded-lives] ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}
