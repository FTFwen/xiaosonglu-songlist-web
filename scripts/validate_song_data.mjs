#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { buildDerivedData, normalizeLanguageTag, normalizeSongName, typeTagPolicyFromRegistry, validateCuts, validateSegments } from './lib/song-data.mjs';
import { parseArgs, readJson } from './lib/io.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(String(args.root ?? '.'));
  const path = name => resolve(root, 'data/xiaosonglu', name);
  const [segmentsDocument, cutsDocument, overridesDocument, typeTagRegistryDocument, catalog, history, details, cutInfo, audio, audioBaseline, state] = await Promise.all([
    readJson(path('replay_song_segments.json')),
    readJson(path('song_cut_index.json')),
    readJson(path('song_metadata_overrides.json')),
    readJson(path('type_tag_registry.json')),
    readJson(path('song_catalog.json')),
    readJson(path('history_index.json')),
    readJson(path('song_details.json')),
    readJson(path('song_cut_info.json')),
    readJson(path('audio_index.json')),
    readJson(path('audio_asset_baseline.json')),
    readJson(path('ingestion_state.json')),
  ]);
  const typeTagPolicy = typeTagPolicyFromRegistry(typeTagRegistryDocument);
  const errors = [...validateSegments(segmentsDocument.segments, typeTagPolicy), ...validateCuts(cutsDocument.items)];
  Object.entries(overridesDocument.bySongName ?? {}).forEach(([songName, override]) => {
    const rawLanguage = String(override?.language ?? '').trim();
    if (rawLanguage && normalizeLanguageTag(rawLanguage) !== rawLanguage) {
      errors.push(`song_metadata_overrides.json language for ${songName} is noncanonical: ${rawLanguage}`);
    }
  });
  const warnings = [];
  const derived = buildDerivedData({
    segmentsDocument,
    cutsDocument,
    overridesDocument,
    typeTagRegistryDocument,
    currentCatalog: catalog,
    currentCutInfo: cutInfo,
  });
  for (const [name, actual, expected] of [
    ['song_catalog.json', catalog, derived.song_catalog],
    ['history_index.json', history, derived.history_index],
    ['song_details.json', details, derived.song_details],
    ['song_cut_info.json', cutInfo, derived.song_cut_info],
  ]) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${name} does not match its source ledgers; rerun the builder`);
  }

  const songIds = catalog.songs.map(song => song.song_id);
  if (new Set(songIds).size !== songIds.length) errors.push('song_catalog.json contains duplicate song_id values');
  const normalizedCatalog = new Set(catalog.songs.map(song => normalizeSongName(song.row_key || song.song_name)));
  if (normalizedCatalog.size !== catalog.songs.length) errors.push('song_catalog.json contains duplicate normalized song keys');
  const historyCount = Object.values(history.byDate ?? {}).reduce((sum, entries) => sum + entries.length, 0);
  if (historyCount !== segmentsDocument.segments.length) errors.push(`history count ${historyCount} != segment count ${segmentsDocument.segments.length}`);
  const detailCount = Object.values(details.bySongKey ?? {}).reduce((sum, song) => sum + Number(song.total_count ?? 0), 0);
  if (detailCount !== segmentsDocument.segments.length) errors.push(`detail count ${detailCount} != segment count ${segmentsDocument.segments.length}`);

  const cutNames = new Set(Object.keys(cutInfo.cuts ?? {}).map(normalizeSongName));
  const missingCuts = catalog.songs.filter(song => !cutNames.has(normalizeSongName(song.song_name))).map(song => song.song_name);
  if (missingCuts.length) warnings.push(`songs without cut display metadata: ${missingCuts.join('、')}`);
  const audioNames = new Set(Object.keys(audio.audios ?? {}).map(normalizeSongName));
  const missingAudio = catalog.songs.filter(song => !audioNames.has(normalizeSongName(song.song_name))).map(song => song.song_name);
  if (missingAudio.length) warnings.push(`songs without local audio: ${missingAudio.join('、')}`);
  const baselineFiles = audioBaseline.files ?? {};
  Object.entries(audio.audios ?? {}).forEach(([songName, rawValue]) => {
    const value = String(rawValue ?? '').replaceAll('\\', '/');
    const match = value.match(/^(assets\/audio\/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a)\?v=([0-9a-f]{12,64})$/u);
    if (!match) {
      errors.push(`audio_index.json has unsafe or non-hash-versioned mapping for ${songName}: ${value}`);
      return;
    }
    const baseline = baselineFiles[match[1]];
    if (!baseline) {
      errors.push(`audio_index.json mapping for ${songName} is absent from audio_asset_baseline.json`);
      return;
    }
    if (match[2] && !String(baseline.sha256 ?? '').toLowerCase().startsWith(match[2].toLowerCase())) {
      errors.push(`audio_index.json cache version for ${songName} does not match adopted SHA-256`);
    }
  });
  const verificationTargets = audio.verificationTargets;
  if (!Array.isArray(verificationTargets) || verificationTargets.length === 0
    || verificationTargets.some(name => typeof name !== 'string' || !name.trim())
    || new Set(verificationTargets).size !== verificationTargets.length) {
    errors.push('audio_index.json verificationTargets must be a non-empty unique string list');
  } else {
    verificationTargets.forEach(name => {
      if (!Object.hasOwn(audio.audios ?? {}, name)) errors.push(`audio verification target is not mapped: ${name}`);
    });
  }

  const liveIds = (state.processedLives ?? []).map(item => item.liveId);
  if (new Set(liveIds).size !== liveIds.length) errors.push('ingestion_state.json contains duplicate liveId values');
  const invalidDecisions = (state.processedLives ?? []).filter(item => !['no-songs', 'imported', 'review-needed', 'deferred'].includes(item.decision));
  if (invalidDecisions.length) errors.push('ingestion_state.json contains invalid decisions');

  const embeddedCode = await readFile(resolve(root, 'js/data.js'), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(embeddedCode, context, { filename: 'js/data.js', timeout: 1000 });
  const embedded = context.window.XSL_DATA;
  for (const key of ['song_catalog', 'history_index', 'song_details', 'audio_index', 'song_cut_info']) {
    const expected = key === 'audio_index' ? audio : { ...derived }[key];
    if (JSON.stringify(embedded?.[key]) !== JSON.stringify(expected)) errors.push(`js/data.js embedded ${key} is stale or missing`);
  }

  const report = {
    ok: errors.length === 0,
    counts: {
      segments: segmentsDocument.segments.length,
      cutRows: cutsDocument.items.length,
      songs: catalog.songs.length,
      historyEntries: historyCount,
      detailEntries: detailCount,
      cutInfo: Object.keys(cutInfo.cuts ?? {}).length,
      audio: Object.keys(audio.audios ?? {}).length,
      reviewedLives: (state.processedLives ?? []).filter(item => item.decision !== 'review-needed').length,
      pendingReviewLives: (state.processedLives ?? []).filter(item => item.decision === 'review-needed').length,
    },
    warnings,
    errors,
  };
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[validate-song-data] ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}
