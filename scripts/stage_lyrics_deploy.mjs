import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTracks, validateRepository } from './validate_lyrics.mjs';

const topFiles = ['index.json', 'coverage.json', 'review-queue.json', 'overrides.json', 'README.md', 'REPORT.md'];
const families = { tracks: /^(?:song|derivative)-[0-9]+\.json$/, sources: /^[0-9]+\.json$/, 'draft-lrc': /^(?:song|derivative)-[0-9]+\.lrc$/ };

// Check every ancestor, not just the final file: junctions in data/ or tracks/
// must not turn a nominally allowlisted path into an external read or write.
function safePath(root, relative = '') {
  const base = path.resolve(root), target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) throw Error(`Lyrics path escapes root: ${relative}`);
  let cursor = target;
  for (;;) {
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink()) throw Error(`Lyrics path must not be a link/reparse point: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return target;
}
function requiredFile(root, relative) {
  const file = safePath(root, relative);
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw Error(`Required lyrics deployment file missing: ${relative}`);
  return file;
}
function readJson(root, relative) { return JSON.parse(fs.readFileSync(requiredFile(root, relative), 'utf8')); }

export function stageLyrics(root, stage) {
  root = path.resolve(root); stage = path.resolve(stage);
  const sourceLyrics = path.join(root, 'data', 'lyrics');
  if (root === stage || root.startsWith(stage + path.sep) || stage === sourceLyrics || stage.startsWith(sourceLyrics + path.sep)) throw Error('Lyrics stage must be separate from source lyrics');
  requiredFile(root, 'data/lyrics/index.json');
  const selected = topFiles.map(name => `data/lyrics/${name}`);
  for (const [family, pattern] of Object.entries(families)) {
    const dir = safePath(root, `data/lyrics/${family}`);
    if (!fs.existsSync(dir)) throw Error(`Required lyrics directory missing: ${family}`);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Reject links even if their names would otherwise be ignored.
      const file = safePath(root, `data/lyrics/${family}/${entry.name}`);
      if (entry.isDirectory() || !pattern.test(entry.name)) throw Error(`Unexpected lyrics deployment entry: ${family}/${entry.name}`);
      if (!fs.lstatSync(file).isFile()) throw Error(`Lyrics entry is not a regular file: ${file}`);
      selected.push(`data/lyrics/${family}/${entry.name}`);
    }
  }
  const expected = currentTracks(stage), index = readJson(root, 'data/lyrics/index.json');
  const keys = new Set(expected.map(x => x.key)), seen = new Set();
  if (index.count !== expected.length || index.processed !== expected.length || !Array.isArray(index.tracks) || index.tracks.length !== expected.length) throw Error('Lyrics deployment requires a complete current index');
  const evidence = new Set();
  for (const entry of index.tracks) {
    if (!keys.has(entry.key) || seen.has(entry.key) || entry.path !== `tracks/${entry.key}.json`) throw Error(`Invalid lyrics index identity: ${entry.key}`);
    seen.add(entry.key);
    const record = readJson(root, `data/lyrics/${entry.path}`);
    if (record.match?.status !== entry.matchStatus || record.alignment?.status !== entry.alignmentStatus || record.songId !== entry.songId || record.songName !== entry.songName || record.audio?.sha256 !== entry.audioSha256 || (record.match?.sourceId ?? null) !== (entry.sourceId ?? null)) throw Error(`Lyrics index differs from track snapshot: ${entry.key}`);
    for (const relative of [record.alignment?.evidencePath, ...(record.alignment?.checks || []).map(x => x.evidencePath)].filter(Boolean)) {
      if (typeof relative !== 'string' || !/^evidence\/[A-Za-z0-9_-]+\.json$/.test(relative)) throw Error(`Unsafe lyrics evidence path: ${relative}`);
      evidence.add(`data/lyrics/${relative}`);
    }
  }
  selected.push(...evidence);
  // Preflight all reads before removing the HEAD snapshot. Evidence is transient:
  // only explicitly referenced JSON is needed for validation, never arbitrary media.
  for (const relative of selected) requiredFile(root, relative);
  const destination = safePath(stage, 'data/lyrics');
  if (fs.existsSync(destination)) {
    const inspect = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = safePath(stage, path.relative(stage, path.join(dir, entry.name))); if (entry.isDirectory()) inspect(file); } };
    inspect(destination);
    fs.rmSync(destination, { recursive: true });
  }
  for (const family of Object.keys(families)) fs.mkdirSync(safePath(stage, `data/lyrics/${family}`), { recursive: true });
  for (const relative of selected) {
    const target = safePath(stage, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(requiredFile(root, relative), target);
  }
  const stagedIndex = readJson(stage, 'data/lyrics/index.json');
  if (JSON.stringify(stagedIndex) !== JSON.stringify(index)) throw Error('Lyrics index changed while staging; retry the deployment');
  for (const entry of stagedIndex.tracks) {
    const record = readJson(stage, `data/lyrics/${entry.path}`);
    if (record.match?.status !== entry.matchStatus || record.alignment?.status !== entry.alignmentStatus || record.songId !== entry.songId || record.songName !== entry.songName || record.audio?.sha256 !== entry.audioSha256 || (record.match?.sourceId ?? null) !== (entry.sourceId ?? null)) throw Error(`Staged lyrics index differs from track snapshot: ${entry.key}`);
  }
  const report = validateRepository(stage);
  if (report.errors || report.missing.length) throw Error(`Staged lyrics validation failed: ${JSON.stringify(report)}`);
  return selected.filter(x => !x.startsWith('data/lyrics/evidence/'));
}

export function pruneLyricsEvidence(stage) {
  const target = safePath(stage, 'data/lyrics/evidence');
  if (!fs.existsSync(target)) return;
  for (const entry of fs.readdirSync(target)) requiredFile(stage, `data/lyrics/evidence/${entry}`);
  fs.rmSync(target, { recursive: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => args.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
  const stage = value('stage');
  if (!stage) throw Error('--stage=<path> is required');
  if (args.includes('--prune-evidence')) pruneLyricsEvidence(stage);
  else {
    const root = value('root');
    if (!root) throw Error('--root=<path> is required');
    console.log(JSON.stringify(stageLyrics(root, stage)));
  }
}
