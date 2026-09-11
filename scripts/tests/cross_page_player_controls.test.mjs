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
const buttonsSource = await readFile(new URL('buttons/buttons.js', root), 'utf8');
const gameHtml = await readFile(new URL('24xsl/index.html', root), 'utf8');

function sourceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `missing source marker: ${startText}`);
  assert.notEqual(end, -1, `missing source marker: ${endText}`);
  return source.slice(start, end);
}

function symbolIcon(source, id) {
  const match = source.match(new RegExp(`<symbol id="${id}" viewBox="([^"]+)"><path d="([^"]+)"`));
  assert.ok(match, `missing icon symbol: ${id}`);
  return { viewBox: match[1], path: match[2] };
}

test('all compact-player controls reuse the exact songlist icon geometry', () => {
  const iconSource = sourceBetween(crossPageSource, 'const PLAYER_ICONS', 'function normalizeDestination');
  const context = {};
  vm.runInNewContext(`${iconSource}\nthis.icons = PLAYER_ICONS;`, context);

  for (const id of [
    'caret-right', 'pause', 'step-backward', 'step-forward',
    'redo', 'random-shuffle', 'sync', 'heart', 'heart-fill', 'sound',
  ]) {
    const expected = symbolIcon(mainHtml, `icon-${id}`);
    assert.equal(context.icons[id].viewBox, expected.viewBox, `${id} viewBox differs`);
    assert.equal(context.icons[id].path, expected.path, `${id} path differs`);
  }

  assert.match(crossPageSource, /playerIcon\('step-backward', 'xsp-mobile-only'\)/);
  assert.match(crossPageSource, /playerIcon\('step-forward', 'xsp-mobile-only'\)/);
  assert.match(crossPageSource, /setHtml\('toggleIcon', dom\.toggle, playbackIcon\(paused\)\)/);
  assert.match(crossPageSource, /playerIcon\(mode\.icon, `xsp-mobile-only\$\{modeShrink \? ' icon-sm' : ''\}`\)/);
  assert.match(crossPageSource, /playerIcon\(active \? 'heart-fill' : 'heart', 'xsp-mobile-only'\)/);
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

  const modeSource = sourceBetween(crossPageSource, 'const PLAY_MODES', 'const PLAYER_ICONS');
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

test('both destinations use the bumped assets and mobile layout matches the songlist player', () => {
  assert.match(mainHtml, /js\/app\.js\?v=97/);
  assert.match(crossPageSource, /const AUDIO_ASSET_VERSION = '4';/);
  assert.match(buttonsHtml, /buttons\.js\?v=33/);
  assert.doesNotMatch(buttonsSource, /DEFAULT_ADMINS|isKnownAdmin|登录成功（离线模式/);
  assert.match(gameHtml, /\.\.\/js\/data\.js\?v=30/);
  for (const source of [buttonsHtml, gameHtml]) {
    assert.match(source, /cross-page-player\.css\?v=5/);
    assert.match(source, /cross-page-player\.js\?v=7/);
  }

  const mobileCss = sourceBetween(crossPageCss, '@media (max-width: 768px)', '/* 24 点横屏');
  assert.match(crossPageCss, /grid-template-columns:[^;]*34px 34px minmax\(100px, 0\.7fr\)/, 'desktop keeps full controls');
  assert.match(mobileCss, /contain: none;/);
  assert.match(mobileCss, /grid-template-columns: 30px 36px 30px minmax\(56px, 1fr\) 30px 30px/);
  assert.match(mobileCss, /"info info info info info info"\s*"prev toggle next progress mode favorite"/);
  assert.match(crossPageSource, /class="xsp-desktop-glyph"/);
  assert.match(crossPageSource, /xsp-mobile-only/);
  assert.match(crossPageCss, /\.xsp-icon\.xsp-mobile-only \{\s*display: none;/);
  assert.match(mobileCss, /\.xsp-desktop-glyph \{\s*display: none;/);
  assert.match(mobileCss, /\.xsp-icon\.xsp-mobile-only \{[\s\S]*display: inline-block;/);
  assert.match(mobileCss, /\.xsp-artist,[\s\S]*\.xsp-volume \{\s*display: none !important;/);
  assert.match(mobileCss, /backdrop-filter: none !important;\s*-webkit-backdrop-filter: none !important;/);
  assert.match(mobileCss, /\.xsp-name \{[\s\S]*color: #394623;[\s\S]*font-size: 12\.5px;[\s\S]*line-height: 1\.35;/);
  assert.match(mobileCss, /\.xsp-progress \{[\s\S]*display: flex;[\s\S]*gap: 0;/);
  assert.match(mobileCss, /\.xsp-seek \{[\s\S]*appearance: none;[\s\S]*margin: revert;[\s\S]*background: #c3cd9a;/);
  assert.match(mobileCss, /\.xsp-seek::-webkit-slider-thumb \{[\s\S]*width: 13px;[\s\S]*background: #8a9a4e;/);
  assert.match(mobileCss, /\.xsp-toggle \{[\s\S]*width: 36px;[\s\S]*height: 36px;[\s\S]*background: linear-gradient\(135deg, #8a9a4e, #718239\)/);
  assert.match(mobileCss, /body\.has-cross-page-song-player \{\s*padding-bottom: 88px;/);
  assert.match(crossPageCss, /@media \(min-width: 721px\)[\s\S]*86svh - 88px/);
  assert.doesNotMatch(mobileCss, /"volume volume/);
});
