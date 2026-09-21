#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatDuration, normalizeText, parseArgs, readJson, requireString, writeJsonAtomic } from './lib/io.mjs';

const BRACKETED_LYRIC = /^\s*([【［「『])(.+?)([】］」』])\s*$/u;

// Secondary evidence channel: viewers reacting to live singing even when nobody
// types bracketed lyric danmaku (which auto-closed a singing live as no-songs on
// 2026-09-17). A reaction window opens only when both an action pattern and
// enough distinct reaction patterns co-occur, so ordinary praise spam alone
// cannot create candidates.
const REACTION_ACTION_PATTERNS = [
  [/唱歌了/u, '唱歌了'],
  [/开口/u, '开口'],
  [/开嗓/u, '开嗓'],
  [/清唱/u, '清唱'],
  [/跟唱/u, '跟唱'],
  [/合唱/u, '合唱'],
  [/唱一[首个]/u, '唱一首'],
  [/来首/u, '来首'],
  [/点歌/u, '点歌'],
  [/安可/u, '安可'],
  [/都唱了/u, '都唱了'],
  [/什么都会唱/u, '什么都会唱'],
  [/歌回/u, '歌回'],
  [/唱吧/u, '唱吧'],
];
const REACTION_QUALITY_PATTERNS = [
  [/好听/u, '好听'],
  [/天籁/u, '天籁'],
  [/唱功/u, '唱功'],
  [/声线/u, '声线'],
  [/原唱/u, '原唱'],
  [/唱得/u, '唱得'],
  [/翻唱/u, '翻唱'],
];

export function lyricBody(text, minimumLength = 4) {
  const normalized = normalizeText(text);
  const match = normalized.match(BRACKETED_LYRIC);
  if (!match) return null;
  const body = normalizeText(match[2]);
  const meaningful = [...body.replace(/[\p{P}\p{S}\s]/gu, '')].length;
  return meaningful >= minimumLength ? body : null;
}

function matchReactionPatterns(text) {
  const actions = [];
  const qualities = [];
  for (const [pattern, label] of REACTION_ACTION_PATTERNS) {
    if (pattern.test(text)) actions.push(label);
  }
  for (const [pattern, label] of REACTION_QUALITY_PATTERNS) {
    if (pattern.test(text)) qualities.push(label);
  }
  return { actions, qualities };
}

export function detectReactionWindows(records, options = {}) {
  const windowMs = Number(options.reactionWindowSeconds ?? 420) * 1000;
  const minPatterns = Number(options.reactionMinPatterns ?? 3);
  const requireAction = options.reactionRequireAction !== false;
  const lyricKey = record => `${record.ts}\u0000${normalizeText(record.text)}`;
  const lyricKeys = new Set(
    records.filter(record => lyricBody(record.text, Number(options.minimumLength ?? 4)) !== null).map(lyricKey),
  );
  const matched = [];
  for (const record of records) {
    const text = normalizeText(record.text);
    if (!text || lyricKeys.has(lyricKey(record))) continue;
    const { actions, qualities } = matchReactionPatterns(text);
    if (actions.length || qualities.length) matched.push({ record, text, actions, qualities });
  }

  // For every matched record, look back across the window and keep the widest
  // qualifying span; spans are merged afterwards. O(n·k) with tiny k.
  const spans = [];
  for (let i = 0; i < matched.length; i++) {
    const actionLabels = new Set();
    const qualityLabels = new Set();
    const members = [];
    for (let j = i; j >= 0 && matched[i].record.ts - matched[j].record.ts <= windowMs; j--) {
      for (const label of matched[j].actions) actionLabels.add(label);
      for (const label of matched[j].qualities) qualityLabels.add(label);
      members.push(matched[j]);
    }
    const totalPatterns = actionLabels.size + qualityLabels.size;
    if (totalPatterns < minPatterns) continue;
    if (requireAction && actionLabels.size < 1) continue;
    spans.push({ startTs: members.at(-1).record.ts, endTs: members[0].record.ts, members });
  }

  const merged = [];
  for (const span of spans.sort((left, right) => left.startTs - right.startTs || left.endTs - right.endTs)) {
    const current = merged.at(-1);
    if (current && span.startTs <= current.endTs) {
      current.endTs = Math.max(current.endTs, span.endTs);
      current.members.push(...span.members);
    } else {
      merged.push({ startTs: span.startTs, endTs: span.endTs, members: [...span.members] });
    }
  }
  for (const span of merged) {
    const seen = new Set();
    span.members = span.members.filter(member => {
      const key = `${member.record.ts}\u0000${member.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    span.actionLabels = [...new Set(span.members.flatMap(member => member.actions))];
    span.qualityLabels = [...new Set(span.members.flatMap(member => member.qualities))];
  }
  return merged;
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
  const minimumLength = Number(options.minimumLength ?? 4);
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

  const lyricClusters = groups
    .filter(group => group.length >= minimumLines)
    .map(group => {
      const startTs = group[0].ts;
      const endTs = group.at(-1).ts;
      const context = contextFor(records, startTs, endTs, contextRadiusMs, group);
      return {
        kind: 'lyric',
        startTs,
        endTs,
        startTime: formatDuration((startTs - payload.live.startDate) / 1000),
        endTime: formatDuration((endTs - payload.live.startDate) / 1000),
        lineCount: group.length,
        lines: group.map(record => ({ time: record.relativeTime, text: record.lyric })),
        context,
      };
    });

  const reactionEnabled = options.reaction !== false;
  const reactionSpans = reactionEnabled
    ? detectReactionWindows(records, {
      reactionWindowSeconds: options.reactionWindowSeconds,
      reactionMinPatterns: options.reactionMinPatterns,
      reactionRequireAction: options.reactionRequireAction,
      minimumLength,
    })
    : [];
  const reactionClusters = reactionSpans.map(span => {
    const context = contextFor(records, span.startTs, span.endTs, contextRadiusMs, span.members.map(member => member.record));
    return {
      kind: 'reaction',
      startTs: span.startTs,
      endTs: span.endTs,
      startTime: formatDuration((span.startTs - payload.live.startDate) / 1000),
      endTime: formatDuration((span.endTs - payload.live.startDate) / 1000),
      lineCount: span.members.length,
      patterns: { action: span.actionLabels, quality: span.qualityLabels },
      lines: span.members.slice(0, 40).map(member => ({
        time: member.record.relativeTime,
        text: member.text,
        evidence: [...member.actions, ...member.qualities],
      })),
      context,
    };
  });

  const clusters = [...lyricClusters, ...reactionClusters]
    .sort((left, right) => left.startTs - right.startTs || left.endTs - right.endTs)
    .map((cluster, index) => ({ candidateIndex: index + 1, ...cluster }));

  return {
    schemaVersion: 1,
    source: 'bracketed-danmaku-lyrics+reaction-windows',
    generatedAt: new Date().toISOString(),
    live: payload.live,
    rules: {
      gapSeconds: gapMs / 1000,
      minimumLength,
      minimumLines,
      contextSeconds: contextRadiusMs / 1000,
      reaction: reactionEnabled
        ? {
          windowSeconds: Number(options.reactionWindowSeconds ?? 420),
          minPatterns: Number(options.reactionMinPatterns ?? 3),
          requireAction: options.reactionRequireAction !== false,
        }
        : false,
    },
    stats: {
      textRecords: records.length,
      lyricLines: lyrics.length,
      lyricClusters: lyricClusters.length,
      reactionClusters: reactionClusters.length,
      candidateClusters: clusters.length,
    },
    clusters,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = resolve(requireString(args.input, '--input'));
  const payload = await readJson(input);
  const result = clusterLyrics(payload, {
    gapSeconds: args['gap-seconds'] ?? 150,
    minimumLength: args['minimum-length'] ?? 4,
    minimumLines: args['minimum-lines'] ?? 1,
    contextSeconds: args['context-seconds'] ?? 45,
    reaction: args['no-reaction'] === true ? false : undefined,
    reactionWindowSeconds: args['reaction-window-seconds'],
    reactionMinPatterns: args['reaction-min-patterns'],
    reactionRequireAction: args['reaction-require-action'] === false ? false : undefined,
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
