#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSongData } from './build_xiaosonglu_song_data.mjs';
import { loadIngestionState, upsertLiveState } from './lib/ingestion-state.mjs';
import { canonicalizeBilibiliCutUrl, importCuratedBatch, performanceKey, typeTagPolicyFromRegistry, validateTypeTagRegistry } from './lib/song-data.mjs';
import { parseArgs, readJson, requireString, writeJsonAtomic } from './lib/io.mjs';

export function collectSameNameReviews(songs = []) {
  return songs.flatMap((song, index) => {
    const review = song.sameNameReview ?? song.same_name_review;
    if (!review) return [];
    const evidenceUrls = Array.isArray(review.evidenceUrls)
      ? review.evidenceUrls
      : [review.evidenceUrl ?? review.evidence_url].filter(Boolean);
    return [{
      songName: String(song.songName ?? song.song_name ?? ''),
      segmentIndex: Number(song.segmentIndex ?? song.segment_index ?? index + 1),
      decision: String(review.decision ?? ''),
      evidenceUrls: evidenceUrls.map(String),
      notes: String(review.notes ?? ''),
    }];
  });
}

export function mergeLiveImportEvidence(existingLiveState, currentImportedSongKeys, currentSameNameReviews, date) {
  const importedSongKeyMap = new Map();
  for (const rawKey of [...(existingLiveState?.importedSongKeys ?? []), ...currentImportedSongKeys]) {
    const [keyDate, ...nameParts] = String(rawKey).split('::');
    const canonicalKey = performanceKey(keyDate, nameParts.join('::'));
    importedSongKeyMap.set(canonicalKey, canonicalKey);
  }
  const sameNameReviewMap = new Map();
  for (const review of [...(existingLiveState?.sameNameReviews ?? []), ...currentSameNameReviews]) {
    const reviewKey = `${performanceKey(date, review.songName)}::${Number(review.segmentIndex)}`;
    sameNameReviewMap.set(reviewKey, review);
  }
  return {
    importedSongKeys: [...importedSongKeyMap.values()].sort((left, right) => left.localeCompare(right, 'zh-CN')),
    sameNameReviews: [...sameNameReviewMap.values()].sort((left, right) => Number(left.segmentIndex) - Number(right.segmentIndex) || String(left.songName).localeCompare(String(right.songName), 'zh-CN')),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(String(args.root ?? '.'));
  const input = resolve(root, requireString(args.input, '--input'));
  const segmentsPath = resolve(root, 'data/xiaosonglu/replay_song_segments.json');
  const cutsPath = resolve(root, 'data/xiaosonglu/song_cut_index.json');
  const registryPath = resolve(root, 'data/xiaosonglu/type_tag_registry.json');
  const [batch, segmentsDocument, cutsDocument, registryDocument] = await Promise.all([
    readJson(input), readJson(segmentsPath), readJson(cutsPath), readJson(registryPath),
  ]);
  if (args.write === true && !String(batch.live?.liveId ?? '').trim()) {
    throw new Error('Writable curated imports require live.liveId so ingestion state can be updated atomically');
  }
  const registryErrors = validateTypeTagRegistry(registryDocument);
  if (registryErrors.length) throw new Error(`Invalid type_tag_registry.json:\n- ${registryErrors.join('\n- ')}`);
  const typeTagPolicy = typeTagPolicyFromRegistry(registryDocument);
  const imported = importCuratedBatch({
    segmentsDocument,
    cutsDocument,
    batch,
    approvedTypeTags: typeTagPolicy.approvedTypeTags,
    blockedTypeTags: typeTagPolicy.blockedTypeTags,
    blockedTypeTagDetails: registryDocument.blockedTags,
  });
  if (args.write === true && (imported.insertedSegments.length || imported.cutsChanged)) {
    if (imported.insertedSegments.length) await writeJsonAtomic(segmentsPath, imported.segmentsDocument);
    if (imported.cutsChanged) await writeJsonAtomic(cutsPath, imported.cutsDocument);
  }
  const build = args.write === true
    ? await buildSongData({ root, write: true })
    : null;

  let stateUpdate = null;
  if (args.write === true && batch.live?.liveId) {
    const date = String(batch.live.date ?? '');
    const currentImportedSongKeys = (batch.songs ?? []).map(song => performanceKey(date, song.songName ?? song.song_name));
    const currentSameNameReviews = collectSameNameReviews(batch.songs ?? []);
    const expectedReplayId = String(batch.live.replayId ?? batch.live.replay_id ?? `live:${batch.live.liveId}`);
    const missing = (batch.songs ?? []).flatMap((song, index) => {
      const songName = String(song.songName ?? song.song_name ?? '');
      const segmentIndex = Number(song.segmentIndex ?? song.segment_index ?? index + 1);
      const cutKind = String(song.cut?.kind ?? song.cut?.clip_kind ?? 'single');
      const expectedCutDate = String(song.cut?.clipDate ?? song.cut?.clip_date ?? date);
      const expectedCutUrl = canonicalizeBilibiliCutUrl(song.cut?.url ?? song.cut?.clip_url ?? '', cutKind, segmentIndex);
      const segment = imported.segmentsDocument.segments.find(item =>
        item.replay_id === expectedReplayId
        && Number(item.segment_index) === segmentIndex
        && performanceKey(item.replay_date, item.song_name) === performanceKey(date, songName)
        && String(item.cut_link ?? '') === expectedCutUrl);
      const cut = imported.cutsDocument.items.find(item =>
        item.clip_date === expectedCutDate
        && performanceKey(item.clip_date, item.song_name) === performanceKey(expectedCutDate, songName)
        && String(item.clip_url ?? '') === expectedCutUrl);
      if (segment && (!song.cut || cut)) return [];
      const reviewedDedupe = imported.dedupedSegments.some(item =>
        item.replay_id === expectedReplayId
        && Number(item.segment_index) === segmentIndex
        && performanceKey(item.replay_date, item.song_name) === performanceKey(date, songName));
      if (reviewedDedupe) {
        const canonicalSegment = imported.segmentsDocument.segments.find(item => performanceKey(item.replay_date, item.song_name) === performanceKey(date, songName));
        const canonicalCut = !song.cut || imported.cutsDocument.items.some(item => performanceKey(item.clip_date, item.song_name) === performanceKey(expectedCutDate, songName));
        if (canonicalSegment && canonicalCut) return [];
      }
      return [`${expectedReplayId}::${segmentIndex}::${songName}`];
    });
    if (missing.length) throw new Error(`Cannot mark live imported; missing exact replay/segment/cut facts: ${missing.join(', ')}`);
    const statePath = resolve(root, String(args.state ?? 'data/xiaosonglu/ingestion_state.json'));
    const state = await loadIngestionState(statePath);
    const existingLiveState = state.processedLives.find(item => item.liveId === String(batch.live.liveId));
    const { importedSongKeys, sameNameReviews } = mergeLiveImportEvidence(existingLiveState, currentImportedSongKeys, currentSameNameReviews, date);
    stateUpdate = await upsertLiveState(statePath, state, {
      liveId: String(batch.live.liveId),
      date,
      title: String(batch.live.title ?? ''),
      ...(batch.live.startDate != null ? { startDate: batch.live.startDate } : {}),
      ...(batch.live.stopDate != null ? { stopDate: batch.live.stopDate } : {}),
      fetchComplete: true,
      decision: 'imported',
      importedSongKeys,
      ...(sameNameReviews.length ? { sameNameReviews } : {}),
      notes: `已验证 ${importedSongKeys.length} 个日期+歌曲键存在于事实源。`,
    }, { write: true });
  }

  console.log(JSON.stringify({
    ok: true,
    mode: args.write ? 'write' : 'dry-run',
    input,
    insertedSegments: imported.insertedSegments.map(item => `${item.replay_date}::${item.song_name}`),
    insertedCuts: imported.insertedCuts.map(item => `${item.clip_date}::${item.song_name}`),
    reviewedDedupes: imported.dedupedSegments.map(item => `${item.replay_id}::${item.segment_index}::${item.song_name}`),
    newTypeTags: imported.newTypeTags,
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
