import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../../functions/api/memes.js';
import { createTestBucket } from './_test-r2.mjs';

const origin = 'https://viridis.love';
const endpoint = `${origin}/api/memes`;
const key = 'memes/v1/state.json';
const seed = { id: 19, date: '2024-12-30', tags: ['Live'], text: 'Café\nShow' };
const submit = (text, tags = ['Live']) => ({ action: 'submit', text, tags });
const copy = id => ({ action: 'copy', id });

function fixture(options = {}) {
  const bucket = createTestBucket(options);
  const getObject = bucket.get;
  bucket.get = async key => {
    const record = await getObject(key);
    return record && { ...record, size: Buffer.byteLength(record.body), etag: record.httpEtag.slice(1, -1) };
  };
  const env = { xsl_buttons: bucket, ASSETS: { async fetch(request) {
    assert.equal(new URL(request.url).pathname, '/memes/seed.json');
    assert.equal(request.method, 'GET');
    return Response.json([seed]);
  } } };
  const handle = request => onRequest({ env, request });
  const get = async () => (await handle(new Request(endpoint))).json();
  const post = (value, { target = endpoint, sent = origin, contentType = 'application/json', raw = false } = {}) => {
    const headers = {};
    if (sent) headers.Origin = sent;
    if (contentType) headers['Content-Type'] = contentType;
    return handle(new Request(target, { method: 'POST', headers, body: raw ? value : JSON.stringify(value) }));
  };
  return { env, bucket, handle, get, post };
}

async function checkError(response, status, error) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { ok: false, error });
}

async function success(response) {
  assert.ok(response.ok, `Expected successful response, got ${response.status}`);
  const body = await response.json();
  assert.equal(body.ok, true);
  return body;
}

test('includes seeds and preserves prior rows, counts and unrelated bucket objects', async () => {
  const { get, post, bucket } = fixture();
  await bucket.put('unrelated.json', '{"preserve":true}');
  assert.deepEqual(await get(), { ok: true, entries: [{ ...seed, copies: 0 }] });
  assert.equal(bucket.counters.writes, 1);
  await bucket.put(key, JSON.stringify({ version: 1,
    submissions: [{ id: 1_000_015, date: seed.date, tags: ['Song'], text: 'Existing submission' }],
    copies: { [seed.id]: 7, 1_000_015: 3 },
  }));
  const { entry } = await success(await post(submit('A new meme', [' song ', 'SONG'])));
  assert.deepEqual(entry, { id: 1_000_016, date: entry.date, tags: ['Song'], text: 'A new meme', copies: 0 });
  assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual((await get()).entries.map(row => [row.id, row.copies]), [[19, 7], [1_000_015, 3], [1_000_016, 0]]);
  assert.deepEqual(bucket.raw('unrelated.json'), { preserve: true });
});

test('CAS retries preserve successful concurrent copies across two IDs', async () => {
  const { post, get, bucket } = fixture({ writeDelay: 3 });
  const { entry } = await success(await post(submit('New entry')));
  const ids = [seed.id, entry.id, seed.id, entry.id, seed.id, entry.id];
  const results = await Promise.all(ids.map(async id => (await success(await post(copy(id)))).copies));
  for (const id of [seed.id, entry.id]) assert.deepEqual(results.filter((_, i) => ids[i] === id).sort(), [1, 2, 3]);
  assert.equal(bucket.trace.filter(event => event.expected === 'create-only' && event.result === 'ok').length, 1);
  assert.ok(bucket.counters.conditionalFailures > 0);
  assert.deepEqual((await get()).entries.map(row => row.copies), [3, 3]);
});

test('concurrent submissions deduplicate text, allocate unique IDs and reuse tag spelling', async () => {
  const { post, get, bucket } = fixture({ writeDelay: 3 });
  await checkError(await post(submit(' Cafe\u0301  Show ')), 409, 'duplicate_text');
  const raced = await Promise.all([post(submit('Same  idea', ['Tag'])), post(submit('Same idea', ['ＴＡＧ']))]);
  const winner = raced.find(response => response.ok);
  assert.ok(winner);
  await checkError(raced.find(response => !response.ok), 409, 'duplicate_text');
  const { entry } = await success(winner);
  assert.ok(bucket.counters.conditionalFailures > 0);
  const distinct = await Promise.all([post(submit('Distinct A', ['tag'])), post(submit('Distinct B', ['TAG']))]);
  const rows = await Promise.all(distinct.map(async response => (await success(response)).entry));
  assert.deepEqual(rows.map(row => row.id).sort(), [1_000_001, 1_000_002]);
  assert.deepEqual(rows.map(row => row.tags), [entry.tags, entry.tags]);
  assert.equal((await get()).entries.length, 4);
});

test('rejects malformed and cross-origin writes before reading or writing R2', async () => {
  const { post, handle, bucket } = fixture();
  const checks = [
    [post(copy(19), { sent: 'https://elsewhere.test' }), 403, 'forbidden_origin'],
    [post(copy(19), { sent: null }), 403, 'forbidden_origin'],
    [post(copy(19), { contentType: null }), 415, 'json_required'],
    [post('{', { raw: true }), 400, 'invalid_json'],
    [post(' '.repeat(33 * 1024), { raw: true }), 413, 'payload_too_large'],
    [post(copy('19')), 400, 'invalid_id'],
    [post({ action: 'other' }), 400, 'invalid_action'],
    [post(submit('x'.repeat(2001))), 400, 'invalid_text'],
    [post(submit('Example', ['x'.repeat(25)])), 400, 'invalid_tags'],
    [handle(new Request(endpoint, { method: 'DELETE' })), 405, 'method_not_allowed'],
  ];
  for (const [pending, status, error] of checks) await checkError(await pending, status, error);
  assert.equal(bucket.counters.reads, 0);
  assert.equal(bucket.counters.writes, 0);
});

test('allows the production proxy and avoids writes for unknown IDs or corrupt state', async () => {
  const { post, bucket } = fixture();
  const target = 'https://xsl-songlist.pages.dev/api/memes';
  await checkError(await post(copy(88), { target }), 404, 'not_found');
  assert.equal(bucket.counters.writes, 0);
  const corrupted = '{"version":2,"submissions":[],"copies":{}}';
  await bucket.put(key, corrupted);
  await checkError(await post(copy(seed.id), { target }), 503, 'storage_unavailable');
  assert.equal(bucket.body(key), corrupted);
  assert.equal(bucket.counters.writes, 1);
});

test('conditional-write exhaustion returns a stable retryable error', async () => {
  const { post, bucket } = fixture({ conditionalPutLimit: 0 });
  await checkError(await post(copy(seed.id)), 503, 'storage_busy');
  assert.equal(bucket.raw(key), null);
  assert.ok(bucket.counters.conditionalFailures > 0);
});

test('escapes HTML delimiters in JSON without changing the copied text', async () => {
  const { post, handle } = fixture();
  const text = '</script><b>\u2028\u2029&';
  await success(await post(submit(text)));
  const response = await handle(new Request(endpoint));
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const raw = await response.text();
  assert.doesNotMatch(raw, /[<>&\u2028\u2029]/u);
  assert.equal(JSON.parse(raw).entries[1].text, text);
});

test('rejects oversized catalog and stored state without overwriting R2', async () => {
  const catalog = fixture();
  catalog.env.ASSETS.fetch = async () => new Response(' '.repeat(1024 * 1024 + 1));
  await checkError(await catalog.post(copy(seed.id)), 503, 'catalog_invalid');
  assert.equal(catalog.bucket.counters.writes, 0);
  const stored = fixture();
  const oversized = ' '.repeat(4 * 1024 * 1024 + 1);
  await stored.bucket.put(key, oversized);
  await checkError(await stored.post(copy(seed.id)), 503, 'storage_unavailable');
  assert.equal(stored.bucket.body(key), oversized);
  assert.equal(stored.bucket.counters.writes, 1);
});
