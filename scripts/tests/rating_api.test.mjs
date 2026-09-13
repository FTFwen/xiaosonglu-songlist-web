// 歌曲评分后端自检：用内存 R2 覆盖读-改-写、撤销、条件写入重试、并发计数与失败留痕。
// 运行：node --test scripts/tests/rating_api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyRating, bucketOf, hashSongKey, readRatings } from '../../functions/_rating.js';
import { createTestBucket, rateWithClientRetry } from './_test-r2.mjs';

const SALT = 'test-salt';
const AGG_PREFIX = 'rating/v1/agg-';
const USER_PREFIX = 'rating/v1/user-';

function makeContext(bucket, ip = '203.0.113.7') {
  return {
    env: { xsl_buttons: bucket, RATING_IP_SALT: SALT },
    request: new Request('https://example.test/api/rating/song?key=x', {
      headers: { 'CF-Connecting-IP': ip },
    }),
  };
}

function clientIdOf(ip) {
  return `ip:${hashSongKey(`${SALT}\u0000${ip}`)}`;
}

function aggKeyOf(songKey) {
  return `${AGG_PREFIX}${bucketOf(songKey)}.json`;
}

function detailKeyOf(songKey) {
  return `${USER_PREFIX}${bucketOf(songKey)}.json`;
}

test('首次评分写入总分为评分、人数为 1', async () => {
  const bucket = createTestBucket();
  const context = makeContext(bucket);
  const result = await applyRating(context, '勾指起誓', clientIdOf('203.0.113.7'), 8);

  assert.equal(result.ok, true);
  assert.equal(result.previous, 0);
  assert.equal(result.aggregate.count, 1);
  assert.equal(result.aggregate.total, 8);
  assert.equal(result.aggregate.average, 8);
  assert.deepEqual(result.aggregate.distribution, { 8: 1 });
});

test('奇数的半星分也能记录（1-10 都是合法分）', async () => {
  const bucket = createTestBucket();
  const context = makeContext(bucket);
  const songKey = '半星测试';
  const client = clientIdOf('203.0.113.7');

  const half = await applyRating(context, songKey, client, 3);
  assert.equal(half.ok, true);
  assert.equal(half.aggregate.count, 1);
  assert.equal(half.aggregate.average, 3);
  assert.deepEqual(half.aggregate.distribution, { 3: 1 });

  const odd = await applyRating(context, songKey, client, 1);
  assert.equal(odd.ok, true);
  assert.equal(odd.aggregate.count, 1);
  assert.equal(odd.aggregate.average, 1);
  assert.deepEqual(odd.aggregate.distribution, { 1: 1 });
});

test('同一访客改分只更新总分与分布，人数不变', async () => {
  const bucket = createTestBucket();
  const context = makeContext(bucket);
  const client = clientIdOf('203.0.113.7');

  await applyRating(context, '夜航星', client, 4);
  const second = await applyRating(context, '夜航星', client, 10);

  assert.equal(second.ok, true);
  assert.equal(second.previous, 4);
  assert.equal(second.aggregate.count, 1);
  assert.equal(second.aggregate.total, 10);
  assert.deepEqual(second.aggregate.distribution, { 10: 1 });
});

test('重复提交同一分数不改变计数', async () => {
  const bucket = createTestBucket();
  const context = makeContext(bucket);
  const client = clientIdOf('203.0.113.7');

  await applyRating(context, '海阔天空', client, 6);
  const again = await applyRating(context, '海阔天空', client, 6);

  assert.equal(again.ok, true);
  assert.equal(again.aggregate.count, 1);
  assert.equal(again.aggregate.total, 6);
});

test('撤销评分后不计入平均分，其他访客不受影响', async () => {
  const bucket = createTestBucket();
  const songKey = '起风了';
  const ctxOne = makeContext(bucket, '203.0.113.7');
  const ctxTwo = makeContext(bucket, '198.51.100.9');

  await applyRating(ctxOne, songKey, clientIdOf('203.0.113.7'), 6);
  await applyRating(ctxTwo, songKey, clientIdOf('198.51.100.9'), 10);
  const removed = await applyRating(ctxOne, songKey, clientIdOf('203.0.113.7'), 0);

  assert.equal(removed.ok, true);
  assert.equal(removed.aggregate.count, 1);
  assert.equal(removed.aggregate.total, 10);
  assert.equal(removed.aggregate.average, 10);

  const mine = await readRatings(ctxOne, [songKey], clientIdOf('203.0.113.7'));
  assert.equal(mine[songKey].own, 0);
  assert.equal(mine[songKey].average.count, 1);
});

test('读取只回本人的评分，别人的评分不下发', async () => {
  const bucket = createTestBucket();
  const songKey = '恋爱循环';
  const ctxOne = makeContext(bucket, '203.0.113.7');
  const ctxTwo = makeContext(bucket, '198.51.100.9');

  await applyRating(ctxOne, songKey, clientIdOf('203.0.113.7'), 2);
  await applyRating(ctxTwo, songKey, clientIdOf('198.51.100.9'), 10);

  const mine = await readRatings(ctxOne, [songKey], clientIdOf('203.0.113.7'));
  const anonymous = await readRatings(ctxOne, [songKey], '');

  assert.equal(mine[songKey].own, 2);
  assert.equal(mine[songKey].average.count, 2);
  assert.equal(mine[songKey].average.average, 6);
  assert.deepEqual(mine[songKey].average.distribution, { 2: 1, 10: 1 });
  assert.equal(anonymous[songKey].own, 0);
});

test('批量读取同一分片的多首歌只读一对文件', async () => {
  const bucket = createTestBucket();
  const songKey = '批量测试';
  const ctx = makeContext(bucket);
  await applyRating(ctx, songKey, clientIdOf('203.0.113.7'), 4);

  // 找出落在同一分片里的另一首歌，确认批量读仍然只回各自的评分。
  let sibling = '';
  for (let i = 0; i < 5000 && !sibling; i++) {
    const candidate = `候选曲目${i}`;
    if (bucketOf(candidate) === bucketOf(songKey) && candidate !== songKey) sibling = candidate;
  }
  assert.ok(sibling, '应该能找到同分片的另一首歌');

  const before = bucket.counters.reads;
  const result = await readRatings(ctx, [songKey, sibling], clientIdOf('203.0.113.7'));
  const reads = bucket.counters.reads - before;

  assert.equal(result[songKey].own, 4);
  assert.equal(result[sibling].own, 0);
  assert.equal(result[sibling].average.count, 0);
  assert.equal(reads, 2, `一次批量读应该只读聚合与明细各一次，实际 ${reads}`);
});

test('分片稳定：同一歌名始终落到同一 bucket，不同歌名分散', async () => {
  const songKey = '勾指起誓';
  const bucket = bucketOf(songKey);
  assert.equal(bucketOf(songKey), bucket);
  assert.ok(bucket >= 0 && bucket < 16);
  const spread = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(key => bucketOf(key)));
  assert.ok(spread.size > 1, '不同歌名应该分散到多个分片');
});

test('多人同时给同一首歌打分：计数与总分都不丢', async () => {
  const bucket = createTestBucket({ writeDelay: 1 });
  const songKey = '孤勇者';
  const guests = Array.from({ length: 8 }, (_, index) => `203.0.113.${index + 1}`);
  const scores = [4, 10, 6, 2, 8, 10, 4, 6];

  const results = await Promise.all(guests.map((ip, index) => rateWithClientRetry(
    applyRating, makeContext(bucket, ip), songKey, clientIdOf(ip), scores[index]
  )));
  assert.equal(results.filter(result => result.ok).length, guests.length, '并发评分都应最终成功');

  const ratings = await readRatings(makeContext(bucket), [songKey], '');
  assert.equal(ratings[songKey].average.count, guests.length);
  assert.equal(ratings[songKey].average.total, scores.reduce((sum, value) => sum + value, 0));
  assert.equal(bucket.raw(detailKeyOf(songKey)).details
    ? Object.keys(bucket.raw(detailKeyOf(songKey)).details).length : guests.length, guests.length);
  assert.equal(Object.keys(bucket.raw(aggKeyOf(songKey)).songs).length, 1, '聚合里不应留下多余条目');
});

test('冲突始终无法解决时明确失败，不留半截计数', async () => {
  // conditionalPutLimit: 0 等价于「所有条件写入都失败」，用来验证重试耗尽后的行为。
  const bucket = createTestBucket({ writeDelay: 1, conditionalPutLimit: 0 });
  const result = await applyRating(makeContext(bucket), '测试歌曲', clientIdOf('203.0.113.7'), 8);

  assert.equal(result.ok, false);
  assert.match(result.error, /conflict|busy/);

  const ratings = await readRatings(makeContext(bucket), ['测试歌曲'], '');
  assert.equal(ratings['测试歌曲'].average.count, 0, '失败的评分不应计入平均分');
});
