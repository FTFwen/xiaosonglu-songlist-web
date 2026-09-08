#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadIngestionState, upsertLiveState } from './lib/ingestion-state.mjs';
import { performanceKey } from './lib/song-data.mjs';
import { parseArgs, readJson, requireString } from './lib/io.mjs';

const DECISIONS = new Set(['no-songs', 'imported', 'review-needed', 'deferred']);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(String(args.root ?? '.'));
  const candidatePath = resolve(root, requireString(args.candidate, '--candidate'));
  const decision = requireString(args.decision, '--decision');
  if (!DECISIONS.has(decision)) throw new Error(`--decision must be one of: ${[...DECISIONS].join(', ')}`);
  const candidate = await readJson(candidatePath);
  const live = candidate.live ?? {};
  const liveId = requireString(live.liveId, 'candidate.live.liveId');
  const statePath = resolve(root, String(args.state ?? 'data/xiaosonglu/ingestion_state.json'));
  const state = await loadIngestionState(statePath);
  if (!state.baselineDate) state.baselineDate = String(args.baseline ?? '2026-09-03');
  let importedSongKeys;
  if (args['songs-base64']) {
    importedSongKeys = JSON.parse(Buffer.from(String(args['songs-base64']), 'base64url').toString('utf8'));
  } else if (args['songs-json']) {
    importedSongKeys = JSON.parse(String(args['songs-json']));
  } else {
    // `|` is deliberate: commas occur in real titles such as “Fly, My Wings”.
    importedSongKeys = String(args.songs ?? '').split('|').map(value => value.trim()).filter(Boolean);
  }
  if (!Array.isArray(importedSongKeys) || importedSongKeys.some(value => typeof value !== 'string')) {
    throw new Error('--songs-json/--songs-base64 must encode an array of song-name/date::song-name strings');
  }
  if (decision === 'imported') {
    if (!importedSongKeys.length) throw new Error('--decision imported requires --songs, --songs-json, or --songs-base64');
    const segments = await readJson(resolve(root, 'data/xiaosonglu/replay_song_segments.json'));
    const factKeys = new Set((segments.segments ?? []).map(item => performanceKey(item.replay_date, item.song_name)));
    importedSongKeys = importedSongKeys.map(value => {
      const separator = value.indexOf('::');
      const date = separator === -1 ? String(live.date ?? '') : value.slice(0, separator);
      const name = separator === -1 ? value : value.slice(separator + 2);
      const key = performanceKey(date, name);
      if (!factKeys.has(key)) throw new Error(`Imported song key is missing from replay_song_segments.json: ${value}`);
      return key;
    });
  }
  const result = await upsertLiveState(statePath, state, {
    liveId,
    date: live.date ?? '',
    title: live.title ?? '',
    startDate: live.startDate ?? null,
    stopDate: live.stopDate ?? null,
    sourceFile: basename(candidatePath).replace('_candidate_', '_danmaku_'),
    candidateFile: basename(candidatePath),
    lyricLineCount: Number(candidate.stats?.lyricLines ?? 0),
    candidateClusterCount: Number(candidate.stats?.candidateClusters ?? 0),
    decision,
    importedSongKeys,
    notes: String(args.notes ?? ''),
  }, { write: args.write === true });
  console.log(JSON.stringify({ ok: true, mode: args.write ? 'write' : 'dry-run', changed: result.changed, statePath, entry: result.entry }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[record-live-review] ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}
