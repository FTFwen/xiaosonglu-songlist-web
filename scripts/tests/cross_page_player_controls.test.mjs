import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const crossPageSource = await readFile(new URL('js/cross-page-player.js', root), 'utf8');
const crossPageCss = await readFile(new URL('css/cross-page-player.css', root), 'utf8');
const appSource = await readFile(new URL('js/app.js', root), 'utf8');
const mainHtml = await readFile(new URL('index.html', root), 'utf8');
const buttonsHtml = await readFile(new URL('buttons/index.html', root), 'utf8');
const gameHtml = await readFile(new URL('24xsl/index.html', root), 'utf8');

function sourceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `missing source marker: ${startText}`);
  assert.notEqual(end, -1, `missing source marker: ${endText}`);
  return source.slice(start, end);
}

function symbolPath(source, id) {
  const match = source.match(new RegExp(`<symbol id="${id}"[^>]*><path d="([^"]+)"`));
  assert.ok(match, `missing icon symbol: ${id}`);
  return match[1];
}

test('cross-page play and pause controls reuse the exact songlist icon paths', () => {
  const playPath = symbolPath(mainHtml, 'icon-caret-right');
  const pausePath = symbolPath(mainHtml, 'icon-pause');

  assert.ok(crossPageSource.includes(`path: '${playPath}'`));
  assert.ok(crossPageSource.includes(`path: '${pausePath}'`));
  assert.match(crossPageSource, /setHtml\('toggleIcon', dom\.toggle, playbackIcon\(paused\)\)/);
  assert.doesNotMatch(crossPageSource, /paused \? '▶' : 'Ⅱ'/);
});

test('volume, favorite, and playback-mode controls are present and wired into handoff state', () => {
  for (const className of ['xsp-volume-input', 'xsp-favorite', 'xsp-mode']) {
    assert.ok(crossPageSource.includes(`class="${className}`), `missing ${className} markup`);
  }

  assert.match(crossPageSource, /audio\.volume = Number\.isFinite\(saved\.volume\)/);
  assert.match(crossPageSource, /dom\.volume\.addEventListener\('input',[\s\S]*audio\.volume =/);
  assert.match(crossPageSource, /let playMode = PLAY_MODE_MAP\[saved\.playMode\]/);
  assert.match(crossPageSource, /dom\.mode\.addEventListener\('click',[\s\S]*PLAY_MODES\[\(modeIndex \+ 1\) % PLAY_MODES\.length\]/);
  assert.match(crossPageSource, /volume: audio\.volume,[\s\S]*playMode,/);
  assert.match(crossPageSource, /if \(playMode === 'single'\) loadAt\(index, true, 0\)/);
  assert.match(appSource, /player\.audio\.volume = player\.volume;\s*dom\.playerVolume\.value = String\(Math\.round\(player\.volume \* 100\)\);/);

  const modeSource = sourceBetween(crossPageSource, 'const PLAY_MODES', 'const PLAYBACK_ICONS');
  const context = {};
  vm.runInNewContext(`${modeSource}\nthis.modes = PLAY_MODES;`, context);
  assert.deepEqual(Array.from(context.modes, mode => mode.key), ['list', 'random', 'single']);
});

test('cross-page favorite snapshots use the shared songlist storage and same-page change event', () => {
  const helperSource = sourceBetween(crossPageSource, 'function favoriteKey', 'const saved = consumeHandoff()');
  const store = new Map();
  const events = [];
  class FakeCustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options && options.detail;
    }
  }
  const context = {
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, value),
    },
    window: { dispatchEvent: event => events.push(event) },
    CustomEvent: FakeCustomEvent,
    console: { warn() {} },
  };
  vm.runInNewContext(`const FAVORITES_KEY = 'favorites:shared';\n${helperSource}\nthis.favoriteKey = favoriteKey; this.favoriteSnapshot = favoriteSnapshot; this.readFavorites = readFavorites; this.writeFavorites = writeFavorites;`, context);

  const song = { song_id: 7, row_key: '测试歌曲', song_name: '测试歌曲', display_song_name: '测试歌曲', artist: '小松绿' };
  const key = context.favoriteKey(song);
  assert.equal(key, 'name:测试歌曲');
  const snapshot = context.favoriteSnapshot(song, key);
  assert.equal(snapshot.key, key);
  assert.equal(snapshot.display_song_name, '测试歌曲');
  assert.equal(snapshot.importedManual, false);

  assert.equal(context.writeFavorites({ [key]: snapshot }), true);
  assert.equal(context.readFavorites()[key].artist, '小松绿');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'favorites:shared:changed');
  assert.equal(events[0].detail[key].song_id, 7);

  assert.match(crossPageSource, /dom\.favorite\.addEventListener\('click',[\s\S]*writeFavorites\(favorites\)/);
  assert.match(crossPageSource, /window\.addEventListener\('storage',[\s\S]*FAVORITES_KEY/);
});

test('both destination pages load the bumped shared assets and reserve mobile room for every control', () => {
  assert.match(mainHtml, /js\/app\.js\?v=87/);
  for (const source of [buttonsHtml, gameHtml]) {
    assert.match(source, /cross-page-player\.css\?v=4/);
    assert.match(source, /cross-page-player\.js\?v=5/);
  }

  assert.match(crossPageCss, /grid-template-columns:[^;]*34px 34px minmax\(100px, 0\.7fr\)/);
  assert.match(crossPageCss, /"prev toggle next mode favorite progress"/);
  assert.match(crossPageCss, /"volume volume volume volume volume volume"/);
  assert.match(crossPageCss, /\.xsp-favorite\.is-active/);
  assert.match(crossPageCss, /\.xsp-volume-input/);
  assert.match(crossPageCss, /@media \(min-width: 721px\) and \(max-width: 768px\)[\s\S]*86svh - 124px/);
  assert.match(crossPageCss, /@media \(min-width: 769px\)[\s\S]*86svh - 88px/);
});
