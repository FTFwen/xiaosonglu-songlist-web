import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stageLyrics, pruneLyricsEvidence } from '../stage_lyrics_deploy.mjs';

const bytes = Buffer.from('new song audio');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
function put(root, file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-deploy-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'worktree'), stage = path.join(temp, 'stage');
  for (const dir of [root, stage]) {
    put(dir, 'data/xiaosonglu/song_catalog.json', { songs: [{ song_id: 1, song_name: 'New song' }] });
    put(dir, 'data/xiaosonglu/audio_index.json', { audios: { 'New song': 'assets/audio/new.m4a' } });
    put(dir, 'js/app.js', 'const DERIVATIVE_TRACKS = [\n].map(([songName');
    put(dir, 'assets/audio/new.m4a', bytes);
  }
  const record = { schemaVersion: 1, key: 'song-1', songId: 1, songName: 'New song', rowKey: 'New song', derivative: false, audio: { url: 'assets/audio/new.m4a', sha256: sha }, match: { status: 'not_found' }, alignment: { status: 'not_started', offsetSeconds: null, humanVerified: false } };
  const index = { schemaVersion: 1, count: 1, processed: 1, tracks: [{ key: record.key, songId: 1, songName: record.songName, path: 'tracks/song-1.json', matchStatus: 'not_found', alignmentStatus: 'not_started', audioSha256: sha, sourceId: null }] };
  put(root, 'data/lyrics/tracks/song-1.json', record);
  put(root, 'data/lyrics/index.json', index);
  for (const name of ['coverage.json', 'review-queue.json', 'overrides.json']) put(root, `data/lyrics/${name}`, {});
  for (const name of ['README.md', 'REPORT.md']) put(root, `data/lyrics/${name}`, 'current worktree');
  for (const family of ['sources', 'draft-lrc']) fs.mkdirSync(path.join(root, 'data/lyrics', family), { recursive: true });
  put(stage, 'data/lyrics/tracks/song-1.json', { old: true });
  put(stage, 'data/lyrics/tracks/song-999.json', { obsolete: true });
  put(stage, 'data/lyrics/evidence/old-large.json', '{}');
  put(root, 'data/lyrics/evidence/unreferenced-large.bin', 'do not deploy');
  return { root, stage, record, index, temp };
}
test('current new-song lyrics overwrite archived HEAD and eliminate stale tracks/evidence', t => {
  const { root, stage, record } = fixture(t);
  const deployed = stageLyrics(root, stage);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, 'data/lyrics/tracks/song-1.json'))), record);
  assert.equal(fs.existsSync(path.join(stage, 'data/lyrics/tracks/song-999.json')), false);
  assert.equal(fs.existsSync(path.join(stage, 'data/lyrics/evidence')), false);
  assert.ok(deployed.includes('data/lyrics/tracks/song-1.json'));
  const cli = spawnSync(process.execPath, [path.resolve('scripts/validate_lyrics.mjs'), `--root=${stage}`], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  assert.equal(JSON.parse(cli.stdout).present, 1);
});
test('missing current track cannot fall back to archived HEAD lyrics', t => {
  const { root, stage } = fixture(t);
  fs.unlinkSync(path.join(root, 'data/lyrics/tracks/song-1.json'));
  assert.throws(() => stageLyrics(root, stage), /Required lyrics deployment file missing/);
});
test('incomplete index and mismatched index status fail closed', t => {
  const { root, stage, index } = fixture(t);
  put(root, 'data/lyrics/index.json', { ...index, processed: 0, tracks: [] });
  assert.throws(() => stageLyrics(root, stage), /complete current index/);
  index.tracks[0].matchStatus = 'matched';
  put(root, 'data/lyrics/index.json', index);
  assert.throws(() => stageLyrics(root, stage), /differs from track snapshot/);
});
test('current audio mismatch is caught against the assembled stage', t => {
  const { root, stage } = fixture(t);
  put(stage, 'assets/audio/new.m4a', 'different audio');
  assert.throws(() => stageLyrics(root, stage), /audio_sha256/);
});
test('only referenced evidence JSON is staged for validation and can be pruned', t => {
  const { root, stage, record } = fixture(t);
  record.alignment.evidencePath = 'evidence/check.json';
  put(root, 'data/lyrics/tracks/song-1.json', record);
  assert.throws(() => stageLyrics(root, stage), /Required lyrics deployment file missing/);
  put(root, 'data/lyrics/evidence/check.json', { audioSha256: sha, model: 'whisper-base', start: 0, end: 10, result: { segments: [] } });
  const deployed = stageLyrics(root, stage);
  assert.ok(!deployed.some(x => x.includes('/evidence/')));
  assert.deepEqual(fs.readdirSync(path.join(stage, 'data/lyrics/evidence')), ['check.json']);
  pruneLyricsEvidence(stage);
  assert.equal(fs.existsSync(path.join(stage, 'data/lyrics/evidence')), false);
});
test('unsafe index and evidence paths cannot read outside lyrics', t => {
  const { root, stage, index, record } = fixture(t);
  index.tracks[0].path = '../../outside.json';
  put(root, 'data/lyrics/index.json', index);
  assert.throws(() => stageLyrics(root, stage), /Invalid lyrics index identity/);
  index.tracks[0].path = 'tracks/song-1.json';
  put(root, 'data/lyrics/index.json', index);
  record.alignment.evidencePath = 'evidence/../../outside.json';
  put(root, 'data/lyrics/tracks/song-1.json', record);
  assert.throws(() => stageLyrics(root, stage), /Unsafe lyrics evidence path/);
});
test('source and destination junctions are rejected without touching external data', t => {
  const { root, stage, temp } = fixture(t);
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(outside); put(outside, 'keep.txt', 'keep');
  const sourceDir = path.join(root, 'data/lyrics/sources');
  fs.rmdirSync(sourceDir); fs.symlinkSync(outside, sourceDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => stageLyrics(root, stage), /link\/reparse/);
  fs.unlinkSync(sourceDir); fs.mkdirSync(sourceDir);
  const stageDir = path.join(stage, 'data/lyrics');
  fs.rmSync(stageDir, { recursive: true }); fs.symlinkSync(outside, stageDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => stageLyrics(root, stage), /link\/reparse/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});
test('deployment uses supported root CLI and validates before removing evidence', () => {
  const script = fs.readFileSync('xsl-web-tools/deploy_web.ps1', 'utf8');
  const stage = script.indexOf('$lyricsOverlayJson = & $nodeCommand');
  const validate = script.indexOf("'scripts\\validate_lyrics.mjs') \"--root=$stagePath\"", stage);
  const prune = script.indexOf("'--prune-evidence'", stage);
  assert.ok(stage > 0 && validate > stage && prune > validate);
});
