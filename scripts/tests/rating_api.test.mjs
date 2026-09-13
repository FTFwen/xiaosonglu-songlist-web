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

/* ===== 前端「按评分排序」的接线检查 =====
   均分在服务端、卡片又是懒加载，所以这个排序必须先把全量评分批量取回来才准。
   接线一旦断了（漏了选项、忘了暴露 loadAll、比较函数不看 rating）排序会静默失效，故在此守住。 */

test('筛选面板提供「评分」排序选项，且走的是 rating 字段', async () => {
  const { readFile } = await import('node:fs/promises');
  const root = new URL('../../', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  const app = await readFile(new URL('js/app.js', root), 'utf8');
  const rating = await readFile(new URL('js/rating.js', root), 'utf8');

  assert.match(html, /<option value="rating">评分<\/option>/, '排序下拉里应有「评分」选项');
  assert.match(app, /field === 'rating'/, 'compareSongs 应处理 rating 字段');
  assert.match(app, /sortField === 'rating'/, 'applySongFilters 应触发全量评分加载');
  assert.match(rating, /loadAll: loadAll/, 'rating.js 应对外暴露 loadAll');
  assert.match(rating, /averageOf: averageOf/, 'rating.js 应对外暴露 averageOf');
  assert.match(rating, /countOf: countOf/, 'rating.js 应对外暴露 countOf');
});

test('按评分排序：没评分的歌始终排在最后，全部未评分时退化为热度序', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const root = new URL('../../', import.meta.url);
  const app = await readFile(new URL('js/app.js', root), 'utf8');

  const start = app.indexOf('function compareSongs');
  const end = app.indexOf('function getSongCardHtml', start);
  assert.ok(start !== -1 && end > start, '找不到 compareSongs');

  const songs = [
    { display_song_name: '高分歌', sing_count: 5 },
    { display_song_name: '低分歌', sing_count: 50 },
    { display_song_name: '没评分的歌', sing_count: 99 },
    { display_song_name: '中间分歌', sing_count: 10 },
  ];
  const ratings = {
    高分歌: { average: 9.5, count: 4 },
    低分歌: { average: 3, count: 2 },
    中间分歌: { average: 6.5, count: 7 },
  };
  const context = {
    window: {
      __XSL_RATING: {
        averageOf: key => (ratings[key] ? ratings[key].average : 0),
        countOf: key => (ratings[key] ? ratings[key].count : 0),
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${app.slice(start, end)}\nthis.compare = compareSongs;`, context);

  const order = dir => songs.slice()
    .sort((a, b) => context.compare(a, b, 'rating', dir))
    .map(song => song.display_song_name);

  assert.deepEqual(order('desc'), ['高分歌', '中间分歌', '低分歌', '没评分的歌']);
  assert.deepEqual(order('asc'), ['低分歌', '中间分歌', '高分歌', '没评分的歌'], '升序时未评分也要垫底');

  // 接口不可用时不能抛错，退回按热度
  context.window.__XSL_RATING = null;
  assert.deepEqual(order('desc'), ['没评分的歌', '低分歌', '中间分歌', '高分歌']);
});
