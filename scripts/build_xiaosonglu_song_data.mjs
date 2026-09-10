#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCutCsv, buildDerivedData, buildEmbeddedData, contentHash } from './lib/song-data.mjs';
import { parseArgs, readJson, writeJsonAtomic, writeTextAtomic } from './lib/io.mjs';

async function readOptionalJson(path, fallback) {
  try { return await readJson(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function textOrNull(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function buildSongData(options = {}) {
  const root = resolve(options.root ?? '.');
  const dataDirectory = resolve(root, 'data/xiaosonglu');
  const paths = {
    segments: resolve(dataDirectory, 'replay_song_segments.json'),
    cuts: resolve(dataDirectory, 'song_cut_index.json'),
    overrides: resolve(dataDirectory, 'song_metadata_overrides.json'),
    typeTagRegistry: resolve(dataDirectory, 'type_tag_registry.json'),
    audio: resolve(dataDirectory, 'audio_index.json'),
    catalog: resolve(dataDirectory, 'song_catalog.json'),
    history: resolve(dataDirectory, 'history_index.json'),
    details: resolve(dataDirectory, 'song_details.json'),
    cutInfo: resolve(dataDirectory, 'song_cut_info.json'),
    cutCsv: resolve(dataDirectory, 'song_cut_table.csv'),
    embedded: resolve(root, 'js/data.js'),
  };
  const [segmentsDocument, cutsDocument, overridesDocument, typeTagRegistryDocument, audioIndex, currentCatalog, currentCutInfo] = await Promise.all([
    readJson(paths.segments),
    readJson(paths.cuts),
    readOptionalJson(paths.overrides, { bySongName: {} }),
    readJson(paths.typeTagRegistry),
    readOptionalJson(paths.audio, { roomKey: 'xiaosonglu', roomId: '1727071052', audios: {} }),
    readOptionalJson(paths.catalog, { songs: [] }),
    readOptionalJson(paths.cutInfo, { cuts: {} }),
  ]);
  const derived = buildDerivedData({ segmentsDocument, cutsDocument, overridesDocument, typeTagRegistryDocument, currentCatalog, currentCutInfo });
  const currentCutCsv = await textOrNull(paths.cutCsv);
  const outputs = new Map([
    [paths.catalog, jsonText(derived.song_catalog)],
    [paths.history, jsonText(derived.history_index)],
    [paths.details, jsonText(derived.song_details)],
    [paths.cutInfo, jsonText(derived.song_cut_info)],
    [paths.cutCsv, buildCutCsv(cutsDocument.items, currentCutCsv ?? '')],
    [paths.embedded, buildEmbeddedData(derived, audioIndex)],
  ]);
  const report = [];
  for (const [path, content] of outputs) {
    const before = await textOrNull(path);
    const normalizedBefore = before?.replaceAll('\r\n', '\n') ?? null;
    const normalizedAfter = content.replaceAll('\r\n', '\n');
    const changed = normalizedBefore !== normalizedAfter;
    report.push({
      path,
      changed,
      beforeHash: normalizedBefore === null ? null : contentHash(normalizedBefore),
      afterHash: contentHash(normalizedAfter),
    });
    if (changed && options.write) {
      if (path.endsWith('.json')) await writeJsonAtomic(path, JSON.parse(content));
      else await writeTextAtomic(path, content);
    }
  }
  return {
    ok: true,
    mode: options.write ? 'write' : 'check',
    counts: {
      segments: segmentsDocument.segments.length,
      cuts: cutsDocument.items.length,
      songs: derived.song_catalog.songs.length,
      dates: Object.keys(derived.history_index.byDate).length,
      cutInfo: derived.song_cut_info.count,
      audio: Object.keys(audioIndex.audios ?? {}).length,
    },
    changed: report.filter(item => item.changed).map(item => item.path),
    unchanged: report.filter(item => !item.changed).map(item => item.path),
    report,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.write && args.check) throw new Error('Choose either --write or --check');
  const result = await buildSongData({ root: args.root, write: args.write === true });
  console.log(JSON.stringify(result, null, 2));
  if (args.check && result.changed.length) process.exitCode = 2;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[build-song-data] ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}
