import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const appSource = await readFile(new URL('js/app.js', root), 'utf8');
const htmlSource = await readFile(new URL('index.html', root), 'utf8');
const headersSource = await readFile(new URL('_headers', root), 'utf8');
const workshopSource = await readFile(new URL('workshop/js/start.js', root), 'utf8');
const workshopHtmlSource = await readFile(new URL('workshop/index.html', root), 'utf8');

function sourceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `missing source marker: ${startText}`);
  assert.notEqual(end, -1, `missing source marker: ${endText}`);
  return source.slice(start, end);
}

function fakeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name),
  };
}

function makeTarget(matches = {}) {
  return {
    closest(selector) {
      return Object.prototype.hasOwnProperty.call(matches, selector) ? matches[selector] : null;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test('delegated song-card clicks execute mobile-device, desktop, play-button, and guard branches', async () => {
  const inputHelpers = sourceBetween(appSource, 'function usesMobilePlaybackVisuals', 'function syncPlayingButton');
  const handlerSource = sourceBetween(appSource, 'async function handleSongListClick', 'function bindEvents');
  const song = { song_id: 7, song_name: '测试歌曲' };
  const card = { dataset: { songId: '7' } };
  const display = { compact: true, coarse: false };
  const calls = [];
  const context = {
    window: {
      matchMedia(query) {
        if (query === '(max-width: 768px)') return { matches: display.compact };
        if (query === '(hover: none) and (pointer: coarse)') return { matches: display.coarse };
        return { matches: display.compact || display.coarse };
      },
    },
    state: { filteredSongs: [song] },
    toggleSongPlayback: item => calls.push(['toggle', item.song_id]),
    copyOrderTextOf: async item => calls.push(['copy', item.song_id]),
    openSonglistPicker: () => calls.push(['songlist']),
    toggleFavoriteBySong: async () => calls.push(['favorite']),
    loadSongDetail: async () => calls.push(['detail']),
    setTimeout,
  };
  vm.runInNewContext(`${inputHelpers}\n${handlerSource}\nthis.handle = handleSongListClick;`, context);

  const cardTarget = makeTarget({ '.song-item': card });
  await context.handle({ target: cardTarget, pointerType: 'mouse' });
  assert.deepEqual(calls.pop(), ['toggle', 7], 'compact/mobile layout should tap-to-play');

  display.compact = false;
  await context.handle({ target: cardTarget, pointerType: 'mouse' });
  assert.deepEqual(calls.pop(), ['copy', 7], 'wide desktop mouse should preserve copy behavior');

  display.coarse = true;
  await context.handle({ target: cardTarget, pointerType: 'touch' });
  assert.deepEqual(calls.pop(), ['toggle', 7], 'wide mobile/coarse-pointer layout should keep tap-to-play');

  display.coarse = false;
  await context.handle({ target: cardTarget, pointerType: 'touch' });
  assert.deepEqual(calls.pop(), ['copy', 7], 'wide fine-pointer layout should keep the same desktop behavior and visuals');

  const playButton = { dataset: { playSong: '7' } };
  const interactiveSelector = 'button, a, input, select, textarea, [role="button"]';
  const playTarget = makeTarget({
    '[data-play-song]': playButton,
    [interactiveSelector]: playButton,
    '.song-item': card,
  });
  await context.handle({ target: playTarget, pointerType: 'mouse' });
  assert.deepEqual(calls.pop(), ['toggle', 7], 'explicit play button should always use playback toggle');

  const unknownButton = {};
  const guardedTarget = makeTarget({
    [interactiveSelector]: unknownButton,
    '.song-item': card,
  });
  await context.handle({ target: guardedTarget, pointerType: 'touch' });
  assert.equal(calls.length, 0, 'unrelated controls inside a card must not trigger playback or copy');

  assert.match(appSource, /songListWrap\.addEventListener\('click', handleSongListClick\)/);
});

test('same-song activation alternates through shared request and pause helpers, while no-audio is inert', () => {
  const addToPlaylistSource = sourceBetween(appSource, 'function addToPlaylist', 'function removeFromPlaylist');
  const song = { song_id: 7, song_name: '测试歌曲' };
  const unavailable = { song_id: 8, song_name: '暂无音频' };
  const state = { playlist: [song] };
  let hasAudio = true;
  let requestCalls = 0;
  let pauseCalls = 0;
  let playAtCalls = 0;
  const audio = { paused: false };
  const player = {
    audio,
    queue: state.playlist,
    index: 0,
    get current() { return this.queue[this.index] || null; },
  };
  const toasts = [];
  const context = {
    state,
    player,
    audioUrlOf: () => hasAudio ? '/audio/test.m4a' : '',
    snapshotOf: item => ({ ...item }),
    requestAudioPlayback() { requestCalls += 1; audio.paused = false; },
    pauseAudioPlayback() { pauseCalls += 1; audio.paused = true; },
    savePlaylist() {},
    playSongAt() { playAtCalls += 1; },
    renderPlaylist() {},
    updatePlayerUI() {},
    showToast: message => toasts.push(message),
  };
  vm.runInNewContext(`${addToPlaylistSource}\nthis.toggle = addToPlaylist;`, context);

  assert.equal(context.toggle(song), true);
  assert.equal(pauseCalls, 1);
  assert.equal(requestCalls, 0);

  assert.equal(context.toggle(song), true);
  assert.equal(pauseCalls, 1);
  assert.equal(requestCalls, 1);
  assert.equal(playAtCalls, 0);

  hasAudio = false;
  const queueBefore = player.queue;
  const playlistBefore = [...state.playlist];
  assert.equal(context.toggle(unavailable), false);
  assert.equal(player.queue, queueBefore);
  assert.deepEqual(state.playlist, playlistBefore);
  assert.equal(playAtCalls, 0);
  assert.match(toasts.at(-1), /暂时没有收录音频/);
});

test('tapping a song builds the filtered queue, jumps in place, or inserts as the next track', () => {
  const playSongAtSource = sourceBetween(appSource, 'function playSongAt', 'function startPlaybackFrom');
  const addSource = sourceBetween(appSource, 'function toggleSongPlayback', 'function removeFromPlaylist');
  const snapSource = sourceBetween(appSource, 'function snapshotOf', 'function normalizeCrossPageDestination');
  const songs = [
    { song_id: 1, song_name: 'A' },
    { song_id: 2, song_name: 'B' },
    { song_id: 3, song_name: 'C' },
  ];
  const player = {
    queue: [],
    index: -1,
    playMode: 'list',
    shuffleOrder: null,
    shufflePos: 0,
    audio: { src: '', load() {}, pause() {} },
    get current() { return this.queue[this.index] || null; },
  };
  const context = {
    window: {},
    state: { filteredSongs: songs, playlist: [] },
    player,
    audioUrlOf: song => `a${song.song_id}.m4a`,
    getPlayableSongs: () => context.state.filteredSongs,
    showToast: () => {},
    savePlaylist: () => {},
    renderPlaylist: () => {},
    updatePlayerUI: () => {},
    requestAudioPlayback: () => {},
    pauseAudioPlayback: () => {},
    buildShuffleOrder: () => {},
  };
  vm.runInNewContext(`${snapSource}\n${playSongAtSource}\n${addSource}\nthis.add = addToPlaylist;`, context);

  // 规则一：播放列表为空时，按当前筛选结果整体建表，从点击的歌开始播
  assert.equal(context.add(songs[1]), true);
  assert.deepEqual(context.state.playlist.map(item => item.song_id), [1, 2, 3], 'empty playlist should be rebuilt from the current filter');
  assert.equal(player.index, 1, 'playback should start at the tapped song');
  assert.equal(player.queue, context.state.playlist);

  // 规则二：点击列表中已有的歌 = 原位跳播，不改变顺序
  context.add(songs[2]);
  assert.deepEqual(context.state.playlist.map(item => item.song_id), [1, 2, 3], 'tapping an existing song must not reorder the playlist');
  assert.equal(player.index, 2, 'existing song should play from its own position');

  // 规则三：点击列表外的新歌 = 插到当前播放的下一首并播放
  player.index = 0;
  context.add({ song_id: 9, song_name: 'D' });
  assert.deepEqual(context.state.playlist.map(item => item.song_id), [1, 9, 2, 3], 'fresh song should be inserted right after the current track');
  assert.equal(player.index, 1, 'fresh song should play at its insertion index');
  assert.equal(context.state.playlist[2].song_id, 2, 'the original next track should follow the insertion');

  // 随机模式：插入新歌后洗牌序列同步，播完新歌接着放原本的随机下一首
  context.state.playlist = songs.map(item => ({ ...item }));
  player.queue = context.state.playlist;
  player.index = 0;
  player.playMode = 'random';
  player.shuffleOrder = [2, 0, 1]; // 随机顺序 C A B，当前停在位置 1（A）
  player.shufflePos = 1;
  context.add({ song_id: 9, song_name: 'D' });
  assert.deepEqual(context.state.playlist.map(item => item.song_id), [1, 9, 2, 3]);
  assert.deepEqual(player.shuffleOrder, [3, 0, 1, 2], 'shuffle order should keep its tail and slot the new track right after the current one');
  assert.equal(player.index, 1);
  assert.equal(player.shufflePos, 2, 'playSongAt should align shufflePos with the inserted track');
  assert.equal(player.shuffleOrder[player.shufflePos + 1], 2, 'the original next random track should still follow the insertion');
});

test('songlist playback and restored persistent queue exclude unavailable audio', () => {
  const playSonglistSource = sourceBetween(appSource, 'function playSonglist', 'function renderSonglistDetail');
  const pruneSource = sourceBetween(appSource, 'function pruneUnplayablePlaylist', 'function savePlaylist');
  const playable = { song_id: 1, song_name: '可播放' };
  const unavailable = { song_id: 2, song_name: '无音频' };
  const list = { id: 'mix' };
  let items = [{ song: playable }, { song: unavailable }];
  const state = { playlist: [{ song_id: 99 }], audioIndex: { audios: { playable: '/audio/1.m4a' } } };
  const player = {
    queue: state.playlist,
    index: -1,
    playing: false,
    audio: { paused: true },
    get current() { return this.queue[this.index] || null; },
  };
  const played = [];
  const toasts = [];
  let saved = 0;
  const context = {
    state,
    player,
    getAllSonglists: () => [list],
    getSonglistSongsWithMeta: () => items,
    audioUrlOf: song => song.song_id === 1 ? '/audio/1.m4a' : '',
    snapshotOf: song => ({ ...song }),
    savePlaylist: () => { saved += 1; },
    playSongAt: index => played.push(index),
    renderPlaylist() {},
    updatePlayerUI() {},
    pauseAudioPlayback() {},
    showToast: message => toasts.push(message),
  };
  vm.runInNewContext(`${playSonglistSource}\n${pruneSource}\nthis.playList = playSonglist; this.prune = pruneUnplayablePlaylist;`, context);

  context.playList('mix');
  assert.deepEqual(state.playlist.map(song => song.song_id), [1]);
  assert.deepEqual(played, [0]);
  assert.match(toasts.at(-1), /已跳过 1 首/);

  items = [{ song: unavailable }];
  const queueBefore = player.queue;
  context.playList('mix');
  assert.equal(player.queue, queueBefore);
  assert.deepEqual(played, [0]);
  assert.match(toasts.at(-1), /都没有收录音频/);

  state.playlist = [playable, unavailable];
  player.queue = state.playlist;
  player.index = -1;
  state.audioIndex = null;
  const savedBeforeUnavailableIndex = saved;
  assert.equal(context.prune(), 0);
  assert.deepEqual(state.playlist.map(song => song.song_id), [1, 2]);
  assert.equal(saved, savedBeforeUnavailableIndex, 'a failed audio index load must not erase persisted songs');

  state.audioIndex = { audios: {} };
  assert.equal(context.prune(), 0);
  assert.deepEqual(state.playlist.map(song => song.song_id), [1, 2]);
  assert.equal(saved, savedBeforeUnavailableIndex, 'an unexpectedly empty index must also preserve persisted songs');

  state.audioIndex = { audios: { playable: '/audio/1.m4a' } };
  assert.equal(context.prune(), 1);
  assert.deepEqual(state.playlist.map(song => song.song_id), [1]);
  assert.equal(player.queue, state.playlist);
  assert.ok(saved >= 2);

  assert.match(appSource, /if \(pruneUnplayablePlaylist\(\) > 0\) renderPlaylist\(true\)/);
  assert.match(appSource, /\[data-songlist-play\][\s\S]*toggleSongPlayback\(song\)/);
  assert.match(appSource, /if \(toggleSongPlayback\(target\)\)[\s\S]*正在播放/);
});

test('audio index failure cannot erase a successful cut-info load, and vice versa', async () => {
  const loadAudioIndexSource = sourceBetween(
    appSource,
    'async function loadAudioIndex',
    "player.audio.addEventListener('ended'",
  );
  const state = {
    currentRoom: { audioIndexDataUrl: '/audio-index', cutInfoDataUrl: '/cut-info' },
    audioIndex: null,
    cutInfo: null,
    audioIndexLoaded: false,
    allSongs: [],
  };
  let failCut = true;
  const context = {
    state,
    fetchLocalJson: async url => {
      if (url === '/audio-index') return { audios: { A: '/a.m4a' } };
      if (failCut) throw new Error('cut unavailable');
      return { cuts: { A: {} } };
    },
    updatePlayerUI() {},
    renderSongs() {},
    console: { warn() {} },
  };
  vm.runInNewContext(`${loadAudioIndexSource}\nthis.load = loadAudioIndex;`, context);

  await context.load();
  assert.deepEqual(Object.keys(state.audioIndex.audios), ['A']);
  assert.equal(state.cutInfo, null);
  assert.equal(state.audioIndexLoaded, true);

  failCut = false;
  context.fetchLocalJson = async url => {
    if (url === '/audio-index') throw new Error('audio unavailable');
    return { cuts: { A: {} } };
  };
  await context.load();
  assert.equal(state.audioIndex, null);
  assert.deepEqual(Object.keys(state.cutInfo.cuts), ['A']);
});

test('playback request generation ignores stale failures and pause invalidates pending success', async () => {
  const playbackHelpers = sourceBetween(appSource, 'function isPlayAborted', 'function versionedAudioUrl');
  const pending = [];
  const audio = {
    src: 'https://example.test/a.m4a',
    paused: true,
    ended: false,
    play() {
      this.paused = false;
      return pending.shift().promise;
    },
    pause() { this.paused = true; },
  };
  const player = {
    audio,
    playRequestId: 0,
    wantedPlaying: false,
    playing: true,
  };
  const toasts = [];
  const context = {
    player,
    updatePlayerUI() {},
    showToast: message => toasts.push(message),
    console: { warn() {} },
  };
  vm.runInNewContext(`${playbackHelpers}\nthis.request = requestAudioPlayback; this.pause = pauseAudioPlayback;`, context);

  const first = deferred();
  pending.push(first);
  context.request();
  assert.equal(player.playing, false, 'a pending play must not inherit the previous song playing state');

  const second = deferred();
  pending.push(second);
  audio.src = 'https://example.test/b.m4a';
  audio.paused = true;
  context.request();
  second.resolve();
  await flushPromises();
  assert.equal(player.playing, true);

  first.reject(new Error('late failure from A'));
  await flushPromises();
  assert.equal(player.playing, true, 'an old request failure must not clear the newer song state');
  assert.equal(toasts.length, 0);

  const third = deferred();
  pending.push(third);
  audio.src = 'https://example.test/c.m4a';
  audio.paused = true;
  context.request();
  context.pause();
  third.resolve();
  await flushPromises();
  assert.equal(player.playing, false, 'a play resolving after pause must stay visually paused');

  const fourth = deferred();
  pending.push(fourth);
  audio.src = 'https://example.test/d.m4a';
  audio.paused = true;
  context.request({ failurePrefix: '音频播放失败' });
  fourth.reject(new Error('network down'));
  await flushPromises();
  assert.equal(player.playing, false);
  assert.equal(player.wantedPlaying, false);
  assert.match(toasts.at(-1), /音频播放失败：network down/);
});

test('cross-page restore position cannot leak into a song selected before metadata arrives', () => {
  const restorePositionSource = sourceBetween(
    appSource,
    'function restoreAudioPositionIfCurrent',
    'function restoreCrossPageHandoff',
  );
  const audio = {
    src: 'https://example.test/b.m4a',
    duration: 120,
    currentTime: 4,
  };
  const player = {
    audio,
    current: { song_id: 2 },
  };
  let updates = 0;
  const context = {
    player,
    updatePlayerUI: () => { updates += 1; },
    Number,
    Math,
    String,
  };
  vm.runInNewContext(`${restorePositionSource}\nthis.restorePosition = restoreAudioPositionIfCurrent;`, context);

  assert.equal(context.restorePosition('https://example.test/a.m4a', 1, 55), false);
  assert.equal(audio.currentTime, 4, 'A restore metadata must not seek B');
  assert.equal(updates, 0);

  assert.equal(context.restorePosition('https://example.test/b.m4a', 2, 55), true);
  assert.equal(audio.currentTime, 55);
  assert.equal(updates, 1);
});

test('song switch clears old visual state before new audio resolves and invalid target stops old audio', () => {
  const playSongAtSource = sourceBetween(appSource, 'function playSongAt', 'function startPlaybackFrom');
  const playable = { song_id: 2 };
  const player = {
    queue: [playable],
    index: 0,
    playMode: 'list',
    playing: true,
    audio: { src: 'https://example.test/a.m4a', load() { calls.push('load'); } },
  };
  const calls = [];
  let hasAudio = true;
  const context = {
    player,
    audioUrlOf: () => hasAudio ? 'https://example.test/b.m4a' : '',
    pauseAudioPlayback() { calls.push('pause'); player.playing = false; },
    requestAudioPlayback() { calls.push('request'); },
    updatePlayerUI() { calls.push('update'); },
    showToast: message => calls.push(message),
    buildShuffleOrder() {},
  };
  vm.runInNewContext(`${playSongAtSource}\nthis.playAt = playSongAt;`, context);

  assert.equal(context.playAt(0), true);
  assert.equal(player.playing, false);
  assert.equal(player.audio.src, 'https://example.test/b.m4a');
  assert.deepEqual(calls.slice(0, 3), ['pause', 'load', 'request']);

  hasAudio = false;
  player.playing = true;
  calls.length = 0;
  assert.equal(context.playAt(0), false);
  assert.equal(player.index, -1);
  assert.equal(player.playing, false);
  assert.equal(calls.includes('request'), false);
  assert.match(calls.at(-1), /暂时没有收录音频/);
});

test('media events use actual playing, pause, ended, and error states', () => {
  const listenersSource = sourceBetween(appSource, "player.audio.addEventListener('ended'", 'let songRenderToken');
  const handlers = {};
  const audio = {
    paused: true,
    ended: false,
    duration: 0,
    currentTime: 0,
    addEventListener(name, handler) { handlers[name] = handler; },
  };
  const player = {
    audio,
    playRequestId: 0,
    wantedPlaying: false,
    playing: false,
  };
  const nextCalls = [];
  const toasts = [];
  const context = {
    player,
    updatePlayerUI() {},
    playNext: auto => nextCalls.push(auto),
    showToast: message => toasts.push(message),
    formatAudioTime: () => '00:00',
    dom: {
      playerTimeDur: {},
      playerSeek: {},
      playerTimeCur: {},
    },
    renderedPlayerDuration: '',
    renderedPlayerSeekMax: '',
    renderedPlayerTime: '',
    seekDragging: false,
    Number,
    Math,
    String,
  };
  vm.runInNewContext(listenersSource, context);

  audio.paused = false;
  handlers.play();
  assert.equal(player.wantedPlaying, true);
  assert.equal(player.playing, false, 'play intent alone is not yet the playing visual state');

  handlers.playing();
  assert.equal(player.playing, true);

  handlers.pause();
  assert.equal(player.playing, true, 'a stale pause event is ignored while media is not paused');

  audio.paused = true;
  handlers.pause();
  assert.equal(player.playing, false);
  assert.equal(player.wantedPlaying, false);

  player.playing = true;
  player.wantedPlaying = true;
  audio.ended = true;
  handlers.ended();
  assert.equal(player.playing, false);
  assert.deepEqual(nextCalls, [true]);

  player.playing = true;
  player.wantedPlaying = true;
  handlers.error();
  assert.equal(player.playing, false);
  assert.equal(player.wantedPlaying, false);
  assert.match(toasts.at(-1), /音频加载失败/);
});

test('bottom player toggle uses the same race-safe play and pause helpers', () => {
  const togglePlaySource = sourceBetween(appSource, 'function togglePlay', 'function playNext');
  const player = { queue: [{ song_id: 1 }], index: 0, audio: { paused: true } };
  const calls = [];
  const context = {
    player,
    playAllSongs: () => calls.push('all'),
    requestAudioPlayback: () => calls.push('request'),
    pauseAudioPlayback: () => calls.push('pause'),
  };
  vm.runInNewContext(`${togglePlaySource}\nthis.toggle = togglePlay;`, context);

  context.toggle();
  assert.deepEqual(calls, ['request']);
  player.audio.paused = false;
  context.toggle();
  assert.deepEqual(calls, ['request', 'pause']);
  player.queue = [];
  player.index = -1;
  context.toggle();
  assert.deepEqual(calls, ['request', 'pause', 'all']);

  assert.equal((appSource.match(/player\.audio\.play\(\)/g) || []).length, 4, 'the room adapter may unlock or apply a remote snapshot through the same Audio instance');
  assert.equal((appSource.match(/player\.audio\.pause\(\)/g) || []).length, 3, 'the room adapter may pause while applying an authoritative remote snapshot');
});

test('mobile playing card class follows real player state without animations', () => {
  const syncSource = sourceBetween(appSource, 'function usesMobilePlaybackVisuals', 'function updatePlayerUI');
  const cardClasses = fakeClassList();
  const playClasses = fakeClassList();
  const vinylClasses = fakeClassList();
  const playButton = { classList: playClasses, innerHTML: '', title: '' };
  const core = { textContent: '🌱' };
  const vinyl = {
    classList: vinylClasses,
    querySelector: selector => selector === '.vinyl-core' ? core : null,
  };
  let insertedWave = false;
  const nameRow = {
    querySelector: () => null,
    insertAdjacentHTML: () => { insertedWave = true; },
  };
  const card = {
    classList: cardClasses,
    querySelector(selector) {
      if (selector === '.song-play-btn') return playButton;
      if (selector === '.playing-bars') return null;
      if (selector === '.song-vinyl-wrap') return vinyl;
      if (selector === '.song-name-row') return nameRow;
      return null;
    },
  };
  const player = { current: { song_id: 7 }, playing: true };
  const context = {
    window: { matchMedia: () => ({ matches: true }) },
    document: {
      querySelectorAll(selector) {
        if (selector === '.song-item.now-playing') return cardClasses.contains('now-playing') ? [card] : [];
        if (selector === '.song-item .song-play-btn.playing') return playClasses.contains('playing') ? [playButton] : [];
        return [];
      },
    },
    dom: { songListWrap: { querySelector: () => card } },
    player,
    iconSvg: id => `<${id}>`,
  };
  vm.runInNewContext(`${syncSource}\nthis.sync = syncPlayingButton;`, context);

  context.sync();
  assert.equal(cardClasses.contains('now-playing'), true);
  assert.equal(playClasses.contains('playing'), true);
  assert.equal(playButton.innerHTML, '<pause>');
  assert.equal(playButton.title, '暂停');
  assert.equal(vinylClasses.contains('spinning'), false);
  assert.equal(insertedWave, false);

  player.playing = false;
  context.sync();
  assert.equal(cardClasses.contains('now-playing'), false);
  assert.equal(playClasses.contains('playing'), false);
  assert.equal(playButton.innerHTML, '<caret-right>');
  assert.equal(playButton.title, '播放音频');
});

test('published m4a assets force a browser-playable MIME type and corrected assets bypass stale caches', () => {
  assert.match(headersSource, /\/assets\/audio\/\*\s+Content-Type: audio\/mp4/);
  assert.match(appSource, /const AUDIO_ASSET_VERSION = '4';/);
assert.match(appSource, /\^\[0-9a-f\]\{12,64\}\$\/i\.test\(suppliedVersion\)/);
  assert.match(workshopSource, /const AUDIO_ASSET_VERSION = '4';/);
assert.match(workshopSource, /\^\[0-9a-f\]\{12,64\}\$\/i\.test\(suppliedVersion\)/);
  assert.match(workshopSource, /audio_index\.json\?v=\$\{AUDIO_ASSET_VERSION\}/);
  assert.match(workshopSource, /url\.searchParams\.set\('v', AUDIO_ASSET_VERSION\)/);
  assert.equal((workshopSource.match(/playerState\.audio\.src = audioAbs\(/g) || []).length, 4);
  assert.match(workshopHtmlSource, /js\/start\.js\?v=17/);
});

test('mobile media-query cascade gives only the playing card a glass state and clears sticky hover', () => {
  const mobilePerformanceCss = sourceBetween(
    htmlSource,
    '/* 移动端将超长页面背景简化成纯渐变',
    '/* 手机播放器：一行歌曲信息',
  );
  const coarsePointerCss = sourceBetween(
    htmlSource,
    '/* 手机横屏 / 粗指针平板只继承性能降级',
    '</style>',
  );

  for (const css of [mobilePerformanceCss, coarsePointerCss]) {
    assert.match(css, /\.song-item:not\(\.now-playing\):hover\s*\{[\s\S]*?background: var\(--surface\) !important;/);
    assert.match(css, /\.song-item\.now-playing,[\s\S]*?background: rgba\(244, 246, 232, 0\.38\) !important;[\s\S]*?backdrop-filter: blur\(10px\) saturate\(1\.18\) !important;/);
    assert.match(css, /\.playing-bars[\s\S]*?display: none !important;/);
  }
  assert.match(htmlSource, /js\/data\.js\?v=30/);
  assert.match(htmlSource, /js\/app\.js\?v=97/);
  assert.match(workshopHtmlSource, /js\/data\.js\?v=31/);
  assert.match(workshopHtmlSource, /js\/start\.js\?v=17/);
});
