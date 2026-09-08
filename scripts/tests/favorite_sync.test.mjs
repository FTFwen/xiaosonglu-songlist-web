import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const appSource = await readFile(new URL('js/app.js', root), 'utf8');
const htmlSource = await readFile(new URL('index.html', root), 'utf8');
const apiSource = await readFile(new URL('functions/api/fav/[name].js', root), 'utf8');

function sourceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `missing source marker: ${startText}`);
  assert.notEqual(end, -1, `missing source marker: ${endText}`);
  return source.slice(start, end);
}

test('favorite auto-sync UI and persistence wiring are present', () => {
  for (const id of [
    'favAutoSyncToggle',
    'favAutoSyncStatus',
    'favAutoSyncRetry',
    'favAutoSyncSetupOverlay',
    'favAutoSyncSetupLoad',
    'favAutoSyncSetupCreate',
    'favAutoSyncConflictOverlay',
    'favAutoSyncUseRemote',
    'favAutoSyncKeepLocal',
  ]) {
    assert.match(htmlSource, new RegExp(`id=["']${id}["']`));
    assert.match(appSource, new RegExp(`['"]${id}['"]`));
  }
  assert.match(htmlSource, /js\/app\.js\?v=78/);
  assert.match(appSource, /const FAV_AUTO_SYNC_KEY = 'favorites:autoSyncEnabled'/);
  assert.match(appSource, /const FAV_LAST_ACK_KEY = 'favorites:autoSyncLastAck'/);
  assert.match(appSource, /const FAV_REQUEST_TIMEOUT_MS = 15000/);
  assert.match(appSource, /storageSet\(\{ \[FAV_AUTO_SYNC_KEY\]: true \}, \{ throwOnError: true \}\)/);
  assert.match(appSource, /storageSet\(\{ \[FAV_AUTO_SYNC_KEY\]: false \}, \{ throwOnError: true \}\)/);
  assert.match(appSource, /expectedEtag: conflict\.remoteExists \? conflict\.remoteEtag : null/);
});

test('favorite map comparison is stable across object insertion order', () => {
  const normalize = sourceBetween(appSource, 'function normalizeFavoriteMap', 'function hydrateFavoriteList');
  const signature = sourceBetween(appSource, 'function favoriteMapSignature', 'function favoriteMapCount');
  const context = {};
  vm.runInNewContext(`${normalize}\n${signature}\nthis.signature = favoriteMapSignature;`, context);
  const first = {
    'name:B': { song_name: 'B', artist: '二' },
    'name:A': { song_name: 'A', artist: '一' },
  };
  const second = {
    'name:A': { artist: '一', song_name: 'A' },
    'name:B': { artist: '二', song_name: 'B' },
  };
  assert.equal(context.signature(first), context.signature(second));
  second['name:B'].artist = '三';
  assert.notEqual(context.signature(first), context.signature(second));
});

test('all local favorite mutation paths persist through the auto-sync aware saver', () => {
  assert.match(sourceBetween(appSource, 'async function toggleFavoriteBySong', 'function getFavoriteArtistLine'), /await saveFavorites\(\)/);
  assert.match(sourceBetween(appSource, 'async function clearFavorites', 'function validateFavoriteArchiveName'), /await saveFavorites\(\)/);
  assert.match(sourceBetween(appSource, 'async function importFavoritesFromTxt', '// 语言 全选'), /await saveFavorites\(\)/);
  assert.match(appSource, /delete state\.favoritesMap\[key\];\s*await saveFavorites\(\)/);
  const saver = sourceBetween(appSource, 'async function saveFavorites', 'async function toggleFavoriteBySong');
  assert.match(saver, /favAutoSyncRevision \+= 1/);
  assert.match(saver, /void runFavoriteAutoSyncLoop\(\)/);
});

test('favorite archive ETags normalize weak edge headers to strong R2 tokens', () => {
  const helper = sourceBetween(appSource, 'function normalizeFavoriteArchiveEtag', 'async function favoriteArchiveFetch');
  const context = {};
  vm.runInNewContext(`${helper}\nthis.normalize = normalizeFavoriteArchiveEtag;`, context);
  assert.equal(context.normalize('W/"abc123"'), '"abc123"');
  assert.equal(context.normalize('"abc123"'), '"abc123"');
  assert.equal(context.normalize('abc123'), '"abc123"');
  assert.equal(context.normalize(''), '');
});

test('favorite archive timeout covers response body and external cancellation', async () => {
  const helper = sourceBetween(appSource, 'async function favoriteArchiveFetch', 'async function fetchFavoriteArchive');
  const makeContext = timeout => ({
    AbortController,
    Error,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => ({
      text: () => new Promise((resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal.aborted) rejectAbort();
        else options.signal.addEventListener('abort', rejectAbort, { once: true });
      }),
    }),
    timeout,
  });

  let context = makeContext(10);
  vm.runInNewContext(`const FAV_REQUEST_TIMEOUT_MS = timeout;\n${helper}\nthis.callFetch = favoriteArchiveFetch;`, context);
  await assert.rejects(context.callFetch('/slow'), error => error.name === 'TimeoutError');

  context = makeContext(1000);
  vm.runInNewContext(`const FAV_REQUEST_TIMEOUT_MS = timeout;\n${helper}\nthis.callFetch = favoriteArchiveFetch;`, context);
  const controller = new AbortController();
  const request = context.callFetch('/cancel', { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, error => error.name === 'AbortError');
});

test('favorite archive API validates and round-trips R2 data', async () => {
  const api = await import(`data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}`);
  class Bucket {
    constructor() { this.rows = new Map(); this.revision = 0; }
    async get(key) {
      const row = this.rows.get(key);
      return row === undefined ? null : { body: row.body, etag: row.etag, httpEtag: `"${row.etag}"` };
    }
    async head(key) {
      const row = this.rows.get(key);
      return row === undefined ? null : { etag: row.etag, httpEtag: `"${row.etag}"` };
    }
    async put(key, body, options = {}) {
      const current = this.rows.get(key);
      const condition = options.onlyIf || {};
      if (condition.etagMatches && (!current || condition.etagMatches !== current.etag)) return null;
      if (condition.etagDoesNotMatch === '*' && current) return null;
      const etag = `v${++this.revision}`;
      this.rows.set(key, { body, etag });
      return { etag, httpEtag: `"${etag}"` };
    }
  }
  const bucket = new Bucket();
  const env = { xsl_buttons: bucket };
  const context = (name, init = {}) => ({
    params: { name },
    env,
    request: new Request(`https://test.invalid/api/fav/${encodeURIComponent(name)}`, init),
  });

  let response = await api.onRequestGet(context('missing'));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  response = await api.onRequestGet(context('../bad'));
  assert.equal(response.status, 400);

  // Pages 的路由参数是 URL pathname 片段；字面名称 "%41" 到函数时仍是 "%2541"。
  response = await api.onRequestPut(context('%2541', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ songs: {}, expectedEtag: null }),
  }));
  assert.equal(response.status, 200);
  assert.equal(bucket.rows.has('fav/%41'), true);
  assert.equal(bucket.rows.has('fav/A'), false);

  response = await api.onRequestPut(context('测试存档', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ songs: {}, expectedEtag: null }),
  }));
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.exists, false);
  assert.equal(created.etag, '"v2"');
  assert.equal(response.headers.get('etag'), '"v2"');

  response = await api.onRequestGet(context('测试存档'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), '"v2"');
  assert.deepEqual((await response.json()).songs, {});

  response = await api.onRequestPut(context('测试存档', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      songs: { 'name:偏食': { song_name: '偏食' } },
      expectedEtag: 'W/"v2"',
    }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).etag, '"v3"');

  response = await api.onRequestPut(context('测试存档', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ songs: {}, expectedEtag: '"v2"' }),
  }));
  assert.equal(response.status, 409);

  response = await api.onRequestPut(context('测试存档', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ songs: {}, expectedEtag: '' }),
  }));
  assert.equal(response.status, 409);

  response = await api.onRequestPut(context('bad-etag', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ songs: {}, expectedEtag: 'W/""' }),
  }));
  assert.equal(response.status, 400);

  response = await api.onRequestPut(context('bad-data', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ songs: [] }),
  }));
  assert.equal(response.status, 400);

  const encodedChineseName = encodeURIComponent('自动同步中文名');
  response = await api.onRequestPut(context(encodedChineseName, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ songs: {}, expectedEtag: null }),
  }));
  assert.equal(response.status, 200);
  assert.equal(bucket.rows.has('fav/自动同步中文名'), true);

  response = await api.onRequestPut(context('空标签重建', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ songs: {}, expectedEtag: '' }),
  }));
  assert.equal(response.status, 200);

  response = await api.onRequestGet(context('%2F'));
  assert.equal(response.status, 400);
});
