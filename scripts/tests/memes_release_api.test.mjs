import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { onRequest } from '../../functions/api/memes.js';

const seed = JSON.parse(await readFile(new URL('../../memes/seed.json', import.meta.url), 'utf8'));
const canonical = 'https://viridis.love';
const upstream = 'https://xsl-songlist.pages.dev';

function fixture() {
  const storage = new Map();
  let revision = 0;
  const env = {
    ASSETS: { fetch: request => {
      assert.equal(new URL(request.url).pathname, '/memes/seed.json');
      return Response.json(seed);
    } },
    xsl_buttons: {
      async get(key) {
        const record = storage.get(key);
        return record ? { etag: record.etag, text: async () => record.body } : null;
      },
      async put(key, body, { onlyIf }) {
        const current = storage.get(key);
        if (current ? current.etag !== onlyIf.etagMatches : onlyIf.etagDoesNotMatch !== '*') return null;
        const record = { etag: String(++revision), body };
        storage.set(key, record);
        return record;
      },
    },
  };
  const get = (target = canonical) => onRequest({ env, request: new Request(`${target}/api/memes`) });
  const post = (body, origin = canonical, target = upstream) => onRequest({ env, request: new Request(`${target}/api/memes`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  }) });
  return { get, post };
}

test('all 85 seeds are served with shared copy counts', async () => {
  const { get, post } = fixture();
  const res = await get();
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await res.json()).entries, seed.map(row => ({ ...row, copies: 0 })));
  const updates = await Promise.all(Array.from({ length: 6 }, () => post({ action: 'copy', id: seed[0].id })));
  assert.ok(updates.every(update => update.status === 200));
  assert.equal((await (await get(upstream)).json()).entries[0].copies, 6);
});

test('submissions persist across clients and reuse canonical tags', async () => {
  const { get, post } = fixture();
  const text = '测试稿 <b>用纯文本保存</b>';
  const tag = seed.flatMap(row => row.tags).find(value => value === '打Call');
  assert.ok(tag);
  const submit = () => post({ action: 'submit', text, tags: ['打ＣＡＬＬ', '投稿测试'] });
  const results = await Promise.all([submit(), submit()]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const [{ id, tags, copies }] = (await (await get(upstream)).json()).entries.filter(row => row.text === text);
  assert.ok(id >= 1_000_000);
  assert.deepEqual(tags, [tag, '投稿测试']);
  assert.equal(copies, 0);
  assert.equal((await (await post({ action: 'copy', id })).json()).copies, 1);
});

test('untrusted origins and invalid writes leave the catalog intact', async () => {
  const { get, post } = fixture();
  const copy = { action: 'copy', id: seed[0].id };
  assert.equal((await post(copy, null)).status, 403);
  assert.equal((await post(copy, 'https://other.invalid')).status, 403);
  assert.equal((await post({ action: 'copy', id: 999999 })).status, 404);
  assert.equal((await post({ action: 'submit', text: '', tags: ['测试'] })).status, 400);
  assert.equal((await post({ action: 'submit', text: 'x'.repeat(9000), tags: ['测试'] })).status, 413);
  assert.equal((await (await get()).json()).entries[0].copies, 0);
});
