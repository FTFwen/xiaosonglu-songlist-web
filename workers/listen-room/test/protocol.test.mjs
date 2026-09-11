import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRoomCode,
  normalizePlaybackState,
  normalizeRoomCode,
  normalizeTrack,
  publicSnapshot,
} from '../src/protocol.js';

test('room codes are eight readable uppercase characters', () => {
  const code = makeRoomCode(bytes => bytes.fill(0));
  assert.equal(code, '22222222');
  assert.equal(normalizeRoomCode(' abcd-2345 '), 'ABCD2345');
  assert.equal(normalizeRoomCode('O0IL1234'), '');
  assert.equal(normalizeRoomCode('SHORT'), '');
});

test('track state accepts stable identity but never a source URL', () => {
  const track = normalizeTrack({
    songId: 12,
    rowKey: '测试歌曲',
    name: '测试歌曲',
    artist: '测试歌手',
    assetVersion: 'abcdef123456',
    src: 'https://evil.example/audio.m4a',
  });
  assert.deepEqual(track, {
    songId: 12,
    rowKey: '测试歌曲',
    name: '测试歌曲',
    artist: '测试歌手',
    assetVersion: 'abcdef123456',
  });
  assert.equal(normalizeTrack({ songId: 12, rowKey: 'x', name: 'x', assetVersion: 'v4' }), null);
  assert.equal(normalizeTrack({ songId: -1, rowKey: 'x', name: 'x', assetVersion: 'abcdef123456' }), null);
});

test('playback validation bounds position and mode', () => {
  const valid = normalizePlaybackState({
    track: { songId: 3, rowKey: '歌', name: '歌', assetVersion: '0123456789ab' },
    playing: true,
    positionSeconds: 42.5,
    playMode: 'single',
  });
  assert.equal(valid.playing, true);
  assert.equal(valid.positionSeconds, 42.5);
  assert.equal(valid.playMode, 'single');
  assert.equal(normalizePlaybackState({ ...valid, positionSeconds: -1 }), null);
});

test('public snapshots expose no host capability', () => {
  const room = {
    roomCode: 'ABCDEFGH',
    hostTokenHash: 'secret-hash',
    revision: 4,
    playback: {
      track: { songId: 1, rowKey: '歌', name: '歌', artist: '', assetVersion: '0123456789ab' },
      playing: false,
      positionSeconds: 8,
      playMode: 'list',
      changedAtServerMs: 100,
    },
  };
  const snapshot = publicSnapshot(room, 200);
  assert.equal(snapshot.revision, 4);
  assert.equal(snapshot.serverNowMs, 200);
  assert.equal('hostTokenHash' in snapshot, false);
});
