// 临时验证：按 HTTP 契约直接调用 /api/rating/song 的 handler，覆盖参数校验与读写主路径。
import { onRequestGet, onRequestPut } from '../../functions/api/rating/song.js';
import { createTestBucket } from './_test-r2.mjs';

const bucket = createTestBucket();
const env = { xsl_buttons: bucket, RATING_IP_SALT: 'verify-salt' };
const IP = '203.0.113.7';

function context(path, init) {
  return {
    env,
    request: new Request(`https://viridis.love${path}`, init),
  };
}

function withIp(init = {}, ip = IP) {
  const headers = new Headers(init.headers || {});
  if (ip) headers.set('CF-Connecting-IP', ip);
  return { ...init, headers };
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const SONG = '孤勇者';
const SONG_QUERY = `key=${encodeURIComponent(SONG)}`;
const put = (body, ip = IP) => onRequestPut(context(
  `/api/rating/song?${SONG_QUERY}`,
  withIp({ method: 'PUT', body: JSON.stringify(body) }, ip)
));

// GET 参数校验
let response = await onRequestGet(context('/api/rating/song', withIp()));
check('GET 缺 key 返回 400', response.status === 400, `status=${response.status}`);

const manyKeys = Array.from({ length: 70 }, (_, i) => `key=${encodeURIComponent(`歌${i}`)}`).join('&');
response = await onRequestGet(context(`/api/rating/song?${manyKeys}`, withIp()));
check('GET 超过 64 个 key 返回 400', response.status === 400, `status=${response.status}`);

response = await onRequestGet(context(`/api/rating/song?${SONG_QUERY}`, withIp()));
let payload = await response.json();
check('GET 未评分歌曲返回零值', response.status === 200 && payload.items[SONG].average.count === 0
  && payload.items[SONG].own === 0 && payload.identified === true, JSON.stringify(payload.items));

// PUT 参数校验
response = await put({ key: SONG, score: 11 });
check('PUT 超范围分被拒绝', response.status === 400, `status=${response.status}`);

response = await put({ key: SONG, score: 1.5 });
check('PUT 小数分被拒绝', response.status === 400, `status=${response.status}`);

response = await put({ key: SONG, score: 0 });
check('PUT 撤销需显式确认', response.status === 400);

response = await put({ key: '别的歌', score: 8 });
check('PUT key 不匹配被拒绝', response.status === 400, `status=${response.status}`);

response = await onRequestPut(context(`/api/rating/song?${SONG_QUERY}`, withIp({ method: 'PUT', body: JSON.stringify({ key: SONG, score: 8 }) }, '')));
check('PUT 缺少 CF-Connecting-IP 返回 400', response.status === 400, `status=${response.status}`);

// 正常打分（节流窗口 800ms，验证阶段之间留出间隔）
await new Promise(resolve => setTimeout(resolve, 850));
response = await put({ key: SONG, score: 8 });
payload = await response.json();
check('PUT 首次打分成功', response.status === 200 && payload.ok === true && payload.own === 8
  && payload.average.count === 1 && payload.average.average === 8, `status=${response.status} ${JSON.stringify(payload)}`);

// 节流
response = await put({ key: SONG, score: 4 });
check('PUT 连点触发 429', response.status === 429, `status=${response.status}`);

await new Promise(resolve => setTimeout(resolve, 850));
response = await put({ key: SONG, score: 4 });
payload = await response.json();
check('PUT 改分人数不变', payload.average.count === 1 && payload.average.total === 4 && payload.previous === 8,
  JSON.stringify(payload.average));

// 另一位访客 + 批量读
response = await put({ key: SONG, score: 10 }, '198.51.100.9');
payload = await response.json();
check('第二位访客打分', payload.average.count === 2 && payload.average.average === 7, JSON.stringify(payload.average));

response = await onRequestGet(context(`/api/rating/song?${SONG_QUERY}`, withIp()));
payload = await response.json();
check('读回平均分与自己的评分', payload.items[SONG].average.average === 7
  && payload.items[SONG].own === 4
  && JSON.stringify(payload.items[SONG].average.distribution) === JSON.stringify({ 4: 1, 10: 1 }),
  JSON.stringify(payload.items[SONG]));

// 撤销
await new Promise(resolve => setTimeout(resolve, 850));
response = await put({ key: SONG, score: 0, confirmRemove: true });
payload = await response.json();
check('撤销后只剩另一位访客', payload.average.count === 1 && payload.average.average === 10 && payload.own === 0,
  JSON.stringify(payload.average));

const failed = results.filter(item => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  failed.forEach(item => console.log(`  FAILED: ${item.name} ${item.detail}`));
  process.exit(1);
}
