#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatDuration, normalizeText, parseArgs, readJson, requireString, writeJsonAtomic } from './lib/io.mjs';

const BRACKETED_LYRIC = /^\s*[【［](.+?)[】］]\s*$/u;

export function lyricBody(text, minimumLength = 6) {
  const normalized = normalizeText(text);
  const match = normalized.match(BRACKETED_LYRIC);
  if (!match) return null;
  const body = normalizeText(match[1]);
  const meaningful = [...body.replace(/[\p{P}\p{S}\s]/gu, '')].length;
  return meaningful >= minimumLength ? body : null;
}

function contextFor(records, startTs, endTs, radiusMs, lyrics) {
  const lyricKeys = new Set(lyrics.map(item => `${item.ts}\u0000${item.text}`));
  const frequencies = new Map();
  const messages = [];
  for (const record of records) {
    if (record.ts < startTs - radiusMs || record.ts > endTs + radiusMs) continue;
    if (lyricKeys.has(`${record.ts}\u0000${record.text}`)) continue;
    const text = normalizeText(record.text);
    if (!text) continue;
    frequencies.set(text, (frequencies.get(text) ?? 0) + 1);
    messages.push({ time: record.relativeTime, text });
  }
  const repeated = [...frequencies.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
    .slice(0, 15)
    .map(([text, count]) => ({ text, count }));
  return { repeated, messages: messages.slice(0, 80) };
}

export function clusterLyrics(payload, options = {}) {
  const gapMs = Number(options.gapSeconds ?? 150) * 1000;
  const minimumLength = Number(options.minimumLength ?? 6);
  const minimumLines = Number(options.minimumLines ?? 1);
  const contextRadiusMs = Number(options.contextSeconds ?? 45) * 1000;
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const lyrics = records
    .map(record => ({ ...record, lyric: lyricBody(record.text, minimumLength) }))
    .filter(record => record.lyric !== null)
    .sort((left, right) => left.ts - right.ts);

  const groups = [];
  for (const record of lyrics) {
    const current = groups.at(-1);
    if (!current || record.ts - current.at(-1).ts > gapMs) groups.push([record]);
    else current.push(record);
  }

  const clusters = groups
    .filter(group => group.length >= minimumLines)
    .map((group, index) => {
      const startTs = group[0].ts;
      const endTs = group.at(-1).ts;
      const context = contextFor(records, startTs, endTs, contextRadiusMs, group);
      return {
        candidateIndex: index + 1,
        startTs,
        endTs,
        startTime: formatDuration((startTs - payload.live.startDate) / 1000),
        endTime: formatDuration((endTs - payload.live.startDate) / 1000),
        lineCount: group.length,
        lines: group.map(record => ({ time: record.relativeTime, text: record.lyric })),
        context,
      };
    });

  return {
    schemaVersion: 1,
    source: 'bracketed-danmaku-lyrics',
    generatedAt: new Date().toISOString(),
    live: payload.live,
    rules: { gapSeconds: gapMs / 1000, minimumLength, minimumLines, contextSeconds: contextRadiusMs / 1000 },
    stats: { textRecords: records.length, lyricLines: lyrics.length, candidateClusters: clusters.length },
    clusters,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = resolve(requireString(args.input, '--input'));
  const payload = await readJson(input);
  const result = clusterLyrics(payload, {
    gapSeconds: args['gap-seconds'] ?? 150,
    minimumLength: args['minimum-length'] ?? 6,
    minimumLines: args['minimum-lines'] ?? 1,
    contextSeconds: args['context-seconds'] ?? 45,
  });
  const output = resolve(String(args.output ?? input.replace(/_danmaku_/, '_candidate_')));
  await writeJsonAtomic(output, result);
  console.log(JSON.stringify({ ok: true, input, output, live: result.live, stats: result.stats }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[cluster-lyrics] ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}
