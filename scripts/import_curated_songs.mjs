#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSongData } from './build_xiaosonglu_song_data.mjs';
import { loadIngestionState, upsertLiveState } from './lib/ingestion-state.mjs';
import { importCuratedBatch, performanceKey } from './lib/song-data.mjs';
import { parseArgs, readJson, requireString, writeJsonAtomic } from './lib/io.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(String(args.root ?? '.'));
  const input = resolve(root, requireString(args.input, '--input'));
  const segmentsPath = resolve(root, 'data/xiaosonglu/replay_song_segments.json');
  const cutsPath = resolve(root, 'data/xiaosonglu/song_cut_index.json');
  const [batch, segmentsDocument, cutsDocument] = await Promise.all([
    readJson(input), readJson(segmentsPath), readJson(cutsPath),
  ]);
  const imported = importCuratedBatch({ segmentsDocument, cutsDocument, batch });
  if (args.write === true && imported.insertedSegments.length) {
    await writeJsonAtomic(segmentsPath, imported.segmentsDocument);
    if (imported.insertedCuts.length) await writeJsonAtomic(cutsPath, imported.cutsDocument);
  }
  const build = args.write === true && imported.insertedSegments.length
    ? await buildSongData({ root, write: true })
    : null;

  let stateUpdate = null;
  if (args.write === true && batch.live?.liveId) {
    const date = String(batch.live.date ?? '');
    const importedSongKeys = (batch.songs ?? []).map(song => performanceKey(date, song.songName ?? song.song_name));
    const factKeys = new Set(imported.segmentsDocument.segments.map(item => performanceKey(item.replay_date, item.song_name)));
    const missing = importedSongKeys.filter(key => !factKeys.has(key));
    if (missing.length) throw new Error(`Cannot mark live imported; missing facts: ${missing.join(', ')}`);
    const statePath = resolve(root, String(args.state ?? 'data/xiaosonglu/ingestion_state.json'));
    const state = await loadIngestionState(statePath);
    stateUpdate = await upsertLiveState(statePath, state, {
      liveId: String(batch.live.liveId),
      date,
      title: String(batch.live.title ?? ''),
      startDate: batch.live.startDate ?? null,
      stopDate: batch.live.stopDate ?? null,
      fetchComplete: true,
      decision: 'imported',
      importedSongKeys,
      notes: `已验证 ${importedSongKeys.length} 个日期+歌曲键存在于事实源。`,
    }, { write: true });
  }

  console.log(JSON.stringify({
    ok: true,
    mode: args.write ? 'write' : 'dry-run',
    input,
    insertedSegments: imported.insertedSegments.map(item => `${item.replay_date}::${item.song_name}`),
    insertedCuts: imported.insertedCuts.map(item => `${item.clip_date}::${item.song_name}`),
    skipped: imported.skipped,
    build,
    ingestionState: stateUpdate ? { changed: stateUpdate.changed, entry: stateUpdate.entry } : null,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[import-curated-songs] ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}
