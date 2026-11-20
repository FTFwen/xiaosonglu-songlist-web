import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../../functions/api/memes.js';

const seed = { id: 5, date: '2026-01-01', text: 'seed', tags: ['live'] };
const submission = { ...seed, id: 1_000_001, text: 'submitted' };
const state = { version: 1, submissions: [submission], copies: { 5: 9 } };
const record = value => ({ etag: 'e1', text: async () => JSON.stringify(value) });

function fixture({ catalog = () => Response.json([seed]), read = () => record(state) } = {}) {
  const calls = { seed: 0, reads: 0, writes: 0 };
  const env = {
    ASSETS: { fetch() { calls.seed++; return catalog(); } },
    xsl_buttons: {
      get(key) { calls.reads++; assert.equal(key, 'memes/v1/state.json'); return read(); },
      put() { calls.writes++; throw Error('unexpected write'); },
    },
  };
  const get = (query = '') => onRequest({ env, request: new Request(`https://example.test/api/memes${query}`) });
  return { calls, get };
}

// Hold both reads open to check overlap without relying on elapsed milliseconds.
test('full GET starts both reads and merges validated rows and counts', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { calls, get } = fixture({ catalog: () => gate.then(() => Response.json([seed])), read: () => gate.then(() => record(state)) });
  const pending = get();
  await new Promise(resolve => setImmediate(resolve));
  try { assert.deepEqual(calls, { seed: 1, reads: 1, writes: 0 }); }
  finally { release(); }
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, entries: [{ ...seed, copies: 9 }, { ...submission, copies: 0 }] });
});

for (const [name, catalog] of [
  ['stalled', () => new Promise(() => {})],
  ['failing', () => { throw Error('seed offline'); }],
]) {
  test(`counts skips a ${name} catalog and reads R2 once`, async () => {
    const { calls, get } = fixture({ catalog });
    const pending = get('?view=counts');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, { seed: 0, reads: 1, writes: 0 });
    const res = await pending;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, copies: state.copies });
  });
}

test('missing R2 object yields empty counts without creating it', async () => {
  const { calls, get } = fixture({ read: () => null });
  const res = await get('?view=counts');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, copies: {} });
  assert.deepEqual(calls, { seed: 0, reads: 1, writes: 0 });
});

for (const query of ['', '?view=counts']) {
  for (const [name, read, error] of [
    ['R2 failure', () => { throw Error('offline'); }, 'service_unavailable'],
    ['invalid state', () => record({ ...state, copies: { 5: -1 } }), 'storage_unavailable'],
  ]) {
    test(`${query || 'full GET'} returns 503 on ${name}`, async () => {
      const { calls, get } = fixture({ read });
      const res = await get(query);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false, error });
      assert.deepEqual(calls, { seed: query ? 0 : 1, reads: 1, writes: 0 });
    });
  }
}
