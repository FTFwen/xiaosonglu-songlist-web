// Run: node --test scripts/tests/lyrics_offset_api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { onRequest } from '../../functions/api/lyrics/offset.js';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const canonical = (key = 'song-7', overrides = {}) => ({
  key, songId: key.startsWith('derivative-') ? -Number(key.slice(11)) : Number(key.slice(5)),
  rowKey: '木偶', audio: { sha256: HASH, url: 'private/audio.m4a' },
  match: { status: 'matched', sourceId: 1323302995, queries: ['private query'] },
  ...overrides,
});
const payload = (overrides = {}) => ({
  key: 'song-7', rowKey: '木偶', audioSha256: HASH, sourceId: 1323302995, offsetSeconds: 1.23456, ...overrides,
});
const objectKey = row => `lyrics-offset/v1/${createHash('sha256').update(row).digest('hex')}.json`;
const tick = () => new Promise(resolve => setImmediate(resolve));

// A real snapshot + atomic conditional-put model. A null result means R2 CAS conflict.
function memoryR2({ conflicts = 0, failGet = false, failPut = false, alwaysConflict = false } = {}) {
  const objects = new Map();
  const writes = [];
  const conditions = [];
  let revision = 0;
  let retries = 0;
  return {
    objects, writes, conditions,
    get retries() { return retries; },
    async get(key) {
      if (failGet) throw new Error('PRIVATE R2 ERROR');
      const entry = objects.get(key);
      await tick();
      return entry ? { etag: entry.etag, async text() { return entry.body; } } : null;
    },
    async put(key, body, options = {}) {
      if (failPut) throw new Error('PRIVATE R2 ERROR');
      await tick();
      assert.ok(options.onlyIf, 'every write must be conditional');
      assert.deepEqual(options.httpMetadata, { contentType: 'application/json', cacheControl: 'no-store' });
      conditions.push(options.onlyIf);
      const previous = objects.get(key);
      const mismatch = options.onlyIf.etagMatches !== undefined
        ? previous?.etag !== options.onlyIf.etagMatches
        : options.onlyIf.etagDoesNotMatch !== '*' || !!previous;
      if (mismatch || alwaysConflict || retries < conflicts) { retries++; return null; }
      const etag = `revision-${++revision}`;
      objects.set(key, { body: String(body), etag });
      writes.push(JSON.parse(body));
      return { etag };
    },
    seed(key, record) { objects.set(key, { body: typeof record === 'string' ? record : JSON.stringify(record), etag: `revision-${++revision}` }); },
  };
}

function fixture({ bucket = memoryR2(), track = canonical(), assetStatus = 200, assetBody, assetThrows = false } = {}) {
  const paths = [];
  const state = { track, assetStatus, assetBody, assetThrows };
  const env = {
    xsl_buttons: bucket,
    ASSETS: { async fetch(request) {
      assert.ok(request instanceof Request);
      const url = new URL(request.url);
      paths.push(url.pathname);
      assert.equal(url.origin, 'https://example.test');
      assert.match(url.pathname, /^\/data\/lyrics\/tracks\/(song|derivative)-\d+\.json$/);
      assert.equal(url.search, '');
      if (state.assetThrows) throw new Error('PRIVATE CATALOG ERROR');
      return new Response(state.assetBody ?? JSON.stringify(state.track), { status: state.assetStatus });
    } },
  };
  async function call(method = 'GET', data, { key = 'song-7', headers = {}, raw, stream } = {}) {
    const request = new Request(`https://example.test/api/lyrics/offset?key=${encodeURIComponent(key)}`, {
      method,
      headers: { ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(method === 'PUT' ? { body: stream ?? raw ?? JSON.stringify(data ?? payload()), ...(stream ? { duplex: 'half' } : {}) } : {}),
    });
    const response = await onRequest({ request, env });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = response.status === 204 ? null : await response.json();
    if (result?.ok === false) {
      assert.deepEqual(Object.keys(result).sort(), ['error', 'ok']);
      assert.equal(typeof result.error, 'string');
      assert.doesNotMatch(result.error, /PRIVATE/);
    }
    return { response, result, status: response.status };
  }
  return { call, bucket, env, paths, state };
}

function assertRecord(record, overrides = {}) {
  assert.deepEqual(Object.keys(record).sort(), ['audioSha256', 'key', 'offsetSeconds', 'rowKey', 'sourceId', 'updatedAt']);
  assert.deepEqual({ ...record, updatedAt: undefined }, {
    key: 'song-7', rowKey: '木偶', audioSha256: HASH, sourceId: 1323302995,
    offsetSeconds: 1.235, ...overrides, updatedAt: undefined,
  });
  assert.equal(new Date(record.updatedAt).toISOString(), record.updatedAt);
}

test('GET empty returns the success contract and uses the root canonical asset path', async () => {
  const f = fixture();
  const got = await f.call();
  assert.equal(got.status, 200);
  assert.deepEqual(got.result, { ok: true, record: null });
  assert.deepEqual(f.paths, ['/data/lyrics/tracks/song-7.json']);
  assert.equal(f.bucket.objects.size, 0);
});

test('PUT round trip, millisecond rounding, server timestamp, public fields only, no IP required', async () => {
  const f = fixture();
  const before = Date.now();
  const put = await f.call('PUT', payload({ updatedAt: '1900-01-01T00:00:00.000Z', private: 'ignore' }));
  assert.equal(put.status, 200);
  assert.equal(put.result.ok, true);
  assertRecord(put.result.record);
  assert.ok(Date.parse(put.result.record.updatedAt) >= before);
  assert.ok(Date.parse(put.result.record.updatedAt) <= Date.now());
  assert.deepEqual((await f.call()).result, put.result);
  assert.deepEqual([...f.bucket.objects.keys()], [objectKey('木偶')]);
  assert.deepEqual(f.bucket.conditions[0], { etagDoesNotMatch: '*' });
});

test('second visitor upload replaces one object without accumulating history', async () => {
  const f = fixture();
  await f.call('PUT');
  const second = await f.call('PUT', payload({ offsetSeconds: -2.3456 }), { headers: { 'CF-Connecting-IP': '198.51.100.2' } });
  assert.equal(second.status, 200);
  assertRecord(second.result.record, { offsetSeconds: -2.346 });
  assert.deepEqual((await f.call()).result, second.result);
  assert.equal(f.bucket.objects.size, 1);
  assert.ok(f.bucket.conditions[1].etagMatches);
});

test('both song and derivative identifiers work with their canonical signed songId', async () => {
  const f = fixture({ track: canonical('derivative-1101') });
  const put = await f.call('PUT', payload({ key: 'derivative-1101' }));
  assert.equal(put.status, 200);
  assertRecord(put.result.record, { key: 'derivative-1101' });
  assert.deepEqual((await f.call('GET', undefined, { key: 'derivative-1101' })).result, put.result);
});

test('real repository canonical song and derivative fixtures satisfy the API', async () => {
  for (const key of ['song-7', 'derivative-1101']) {
    const track = JSON.parse(await readFile(new URL(`../../data/lyrics/tracks/${key}.json`, import.meta.url), 'utf8'));
    const f = fixture({ track });
    const put = await f.call('PUT', { key, rowKey: track.rowKey, audioSha256: track.audio.sha256, sourceId: track.match.sourceId, offsetSeconds: 0 });
    assert.equal(put.status, 200, `${key}: ${JSON.stringify(put.result)}`);
    assert.deepEqual((await f.call('GET', undefined, { key })).result, put.result);
  }
});

test('stable row survives song ID renumbering without creating another object', async () => {
  const f = fixture();
  await f.call('PUT');
  f.state.track = canonical('song-8');
  const got = await f.call('GET', undefined, { key: 'song-8' });
  assertRecord(got.result.record, { key: 'song-8' });
  assert.equal((await f.call('PUT', payload({ key: 'song-8', offsetSeconds: 4 }))).status, 200);
  assert.equal(f.bucket.objects.size, 1);
});

test('audio hash and lyric source revisions hide old records and reject stale uploads', async () => {
  for (const revision of [{ audio: { sha256: OTHER_HASH } }, { match: { status: 'matched', sourceId: 42 } }]) {
    const f = fixture();
    await f.call('PUT');
    f.state.track = canonical('song-7', revision);
    assert.deepEqual((await f.call()).result, { ok: true, record: null });
    assert.equal((await f.call('PUT')).status, 409);
    const current = f.state.track;
    const updated = await f.call('PUT', payload({ audioSha256: current.audio.sha256, sourceId: current.match.sourceId }));
    assert.equal(updated.status, 200);
    assert.deepEqual((await f.call()).result, updated.result);
    assert.equal(f.bucket.objects.size, 1);
  }
});

test('canonical row/hash/source are all fully checked before any storage access', async () => {
  for (const changed of [{ rowKey: 'another song' }, { audioSha256: OTHER_HASH }, { sourceId: 42 }]) {
    const f = fixture({ bucket: memoryR2({ failGet: true }) });
    assert.equal((await f.call('PUT', payload(changed))).status, 409);
  }
});

test('reject invalid keys and repeated GET keys without catalog access', async () => {
  for (const key of ['', 'song-0', 'song-01', 'song--7', 'song-7/../../x', 'derivative--1101', 'song-9007199254740992', 'other-7']) {
    const f = fixture();
    assert.equal((await f.call('GET', undefined, { key })).status, 400, key);
    assert.equal((await f.call('PUT', payload({ key }))).status, 400, key);
    assert.equal(f.paths.length, 0);
  }
  const f = fixture();
  const response = await onRequest({ env: f.env, request: new Request('https://example.test/api/lyrics/offset?key=song-7&key=song-8') });
  assert.equal(response.status, 400);
});

test('strict JSON types, required fields and finite bounded numeric offset', async () => {
  const invalid = [
    null, [], true, 'string', {},
    ...['key', 'rowKey', 'audioSha256', 'sourceId', 'offsetSeconds'].map(field => { const body = payload(); delete body[field]; return body; }),
    ...[null, '', '1', true, {}, [], 600.001, -600.001].map(offsetSeconds => payload({ offsetSeconds })),
    payload({ rowKey: '' }), payload({ rowKey: ' 木偶' }), payload({ rowKey: 'x\n' }),
    payload({ audioSha256: HASH.toUpperCase() }), payload({ audioSha256: 'short' }),
    payload({ sourceId: '1323302995' }), payload({ sourceId: 0 }), payload({ sourceId: 1.1 }),
  ];
  const f = fixture();
  for (const body of invalid) {
    const got = await f.call('PUT', undefined, { raw: JSON.stringify(body) });
    assert.equal(got.status, 400, JSON.stringify(body));
  }
  for (const raw of ['{"offsetSeconds":NaN}', '{"offsetSeconds":Infinity}', '{', '']) {
    assert.equal((await f.call('PUT', undefined, { raw })).status, 400);
  }
  assert.equal((await f.call('PUT', undefined, { raw: JSON.stringify(payload()).replace('1.23456', '1e999') })).status, 400);
  assert.equal(f.bucket.objects.size, 0);
});

test('inclusive offset bounds and sub-millisecond negative zero normalization', async () => {
  const f = fixture();
  for (const [offsetSeconds, expected] of [[600, 600], [-600, -600], [-0.0001, 0], [0, 0]]) {
    const got = await f.call('PUT', payload({ offsetSeconds }));
    assert.equal(got.status, 200);
    assert.equal(got.result.record.offsetSeconds, expected);
    assert.ok(!Object.is(got.result.record.offsetSeconds, -0));
  }
});

test('content type must be JSON; charset is allowed', async () => {
  const f = fixture();
  for (const value of ['', 'text/plain', 'application/jsonp', 'text/json']) {
    assert.equal((await f.call('PUT', undefined, { headers: { 'content-type': value } })).status, 415);
  }
  assert.equal((await f.call('PUT', undefined, { headers: { 'content-type': 'application/json; charset=utf-8' } })).status, 200);
});

test('4KiB body cap counts actual UTF-8 bytes, independent of absent or lying Content-Length', async () => {
  const f = fixture();
  const base = JSON.stringify(payload());
  const atLimit = base + ' '.repeat(4096 - Buffer.byteLength(base));
  assert.equal((await f.call('PUT', undefined, { raw: atLimit })).status, 200);
  assert.equal((await f.call('PUT', undefined, { raw: atLimit + ' ' })).status, 413);
  assert.equal((await f.call('PUT', undefined, { raw: atLimit + ' ', headers: { 'content-length': '1' } })).status, 413);
  const unicode = JSON.stringify(payload({ extra: '树'.repeat(1500) }));
  assert.ok(unicode.length < 4096 && Buffer.byteLength(unicode) > 4096);
  assert.equal((await f.call('PUT', undefined, { raw: unicode })).status, 413);
  assert.equal((await f.call('PUT', undefined, { headers: { 'content-length': '4097' } })).status, 413);
});

test('streamed chunks count actual bytes and cancel immediately on overflow', async () => {
  const f = fixture();
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2048)); controller.enqueue(new Uint8Array(2049)); },
    cancel() { cancelled = true; },
  });
  assert.equal((await f.call('PUT', undefined, { stream })).status, 413);
  assert.equal(cancelled, true);
  assert.equal(f.paths.length, 0);
});

test('only explicit trusted origins and this project preview deployments are allowed', async () => {
  const f = fixture();
  for (const origin of ['https://example.test', 'https://viridis.love', 'https://xsl-songlist.pages.dev', 'https://workshop.viridis.love', 'https://branch-123.xsl-songlist.pages.dev']) {
    const got = await f.call('PUT', undefined, { headers: { origin } });
    assert.equal(got.status, 200, origin);
    assert.equal(got.response.headers.get('access-control-allow-origin'), origin);
  }
  for (const origin of ['null', '', 'https://evil.pages.dev', 'https://xsl-songlist.pages.dev.evil.test', 'https://evilxsl-songlist.pages.dev', 'https://a.b.xsl-songlist.pages.dev', 'http://viridis.love', 'https://viridis.love/path', 'https://viridis.love:444', 'https://user@viridis.love', 'https://evil.test']) {
    for (const method of ['GET', 'PUT', 'OPTIONS']) {
      const got = await f.call(method, undefined, { headers: { origin } });
      assert.equal(got.status, 403, origin);
      assert.equal(got.response.headers.get('access-control-allow-origin'), null);
    }
  }
});

test('preflight and unsupported methods produce no-store responses', async () => {
  const f = fixture();
  const preflight = await f.call('OPTIONS', undefined, { headers: { origin: 'https://viridis.love' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.response.headers.get('access-control-allow-methods'), 'GET, PUT, OPTIONS');
  const invalid = await f.call('POST');
  assert.equal(invalid.status, 405);
  assert.equal(invalid.response.headers.get('allow'), 'GET, PUT, OPTIONS');
});

test('catalog 404 is not_found; upstream failures and broken JSON are never not_found', async () => {
  for (const [options, expected] of [
    [{ assetStatus: 404 }, 404], [{ assetStatus: 500 }, 503], [{ assetStatus: 403 }, 503],
    [{ assetThrows: true }, 503], [{ assetBody: '<html>fallback</html>' }, 503], [{ assetBody: 'null' }, 503],
  ]) {
    const f = fixture(options);
    for (const method of ['GET', 'PUT']) {
      const got = await f.call(method);
      assert.equal(got.status, expected);
      assert.equal(got.result.error === 'not_found', expected === 404);
    }
  }
});

test('invalid canonical key/id/row/hash/source fail closed; unmatched lyrics cannot be calibrated', async () => {
  for (const revision of [
    { key: 'song-8' }, { songId: -7 }, { songId: '7' }, { rowKey: '' },
    { audio: null }, { audio: { sha256: 'bad' } }, { audio: { sha256: [HASH] } }, { match: null },
    { match: { status: 'matched', sourceId: null } }, { match: { status: 'matched', sourceId: '42' } },
  ]) {
    const f = fixture({ track: canonical('song-7', revision) });
    assert.equal((await f.call()).status, 503, JSON.stringify(revision));
    assert.equal((await f.call('PUT')).status, 503, JSON.stringify(revision));
  }
  const f = fixture({ track: canonical('song-7', { match: { status: 'unmatched' } }) });
  assert.equal((await f.call()).status, 409);
  assert.equal((await f.call('PUT')).status, 409);
});

test('R2 get, put, missing bindings and exhausted CAS fail with 503, never fake success', async () => {
  for (const bucket of [memoryR2({ failGet: true }), memoryR2({ failPut: true }), memoryR2({ alwaysConflict: true })]) {
    const f = fixture({ bucket });
    const put = await f.call('PUT');
    assert.equal(put.status, 503);
    assert.equal(put.result.ok, false);
    assert.equal(bucket.objects.size, 0);
  }
  assert.equal((await fixture({ bucket: memoryR2({ failGet: true }) }).call()).status, 503);
  for (const binding of ['ASSETS', 'xsl_buttons']) {
    const f = fixture();
    delete f.env[binding];
    assert.equal((await f.call()).status, 503);
    assert.equal((await f.call('PUT')).status, 503);
  }
});

test('stored version mismatch is hidden and internal fields never escape', async () => {
  const f = fixture();
  const valid = { ...payload({ offsetSeconds: 1.235 }), updatedAt: new Date().toISOString(), secret: 'PRIVATE', audio: { url: 'PRIVATE' } };
  f.bucket.seed(objectKey('木偶'), valid);
  assertRecord((await f.call()).result.record);
  for (const changed of [{ rowKey: 'other' }, { audioSha256: OTHER_HASH }, { sourceId: 42 }, { offsetSeconds: 601 }, { offsetSeconds: 1.2345 }, { updatedAt: 'bad' }]) {
    f.bucket.seed(objectKey('木偶'), { ...valid, ...changed });
    assert.deepEqual((await f.call()).result, { ok: true, record: null });
  }
});

test('CAS conflicts retry from a new snapshot then publish exactly one successful record', async () => {
  const f = fixture({ bucket: memoryR2({ conflicts: 2 }) });
  const got = await f.call('PUT');
  assert.equal(got.status, 200);
  assert.equal(f.bucket.retries, 2);
  assert.equal(f.bucket.writes.length, 1);
  assert.deepEqual((await f.call()).result, got.result);
});

test('canonical version change during a CAS retry rejects a stale write', async () => {
  const bucket = memoryR2({ conflicts: 1 });
  const f = fixture({ bucket });
  const put = bucket.put.bind(bucket);
  bucket.put = async (...args) => {
    const result = await put(...args);
    f.state.track = canonical('song-7', { audio: { sha256: OTHER_HASH } });
    return result;
  };
  assert.equal((await f.call('PUT')).status, 409);
  assert.equal(bucket.objects.size, 0);
});

test('concurrent uploads CAS retry; the last successful R2 write is the sole latest record', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => f.call('PUT', payload({ offsetSeconds: index + 0.1 }))));
  assert.ok(results.every(result => result.status === 200), JSON.stringify(results));
  assert.ok(f.bucket.retries > 0, 'concurrency must actually exercise CAS collisions');
  assert.equal(f.bucket.writes.length, 10);
  assert.equal(f.bucket.objects.size, 1);
  const latest = f.bucket.writes.at(-1);
  assert.deepEqual((await f.call()).result, { ok: true, record: latest });
  assert.ok(results.some(result => result.result.record.offsetSeconds === latest.offsetSeconds));
});
