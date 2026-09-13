// 「按评分排序」验证脚本（开发用，不参与部署）：
// 把 index.html 的内联样式去掉，只保留脚本，用 DOM 桩把页面跑起来，
// 然后：
//   1. 用假数据填充 __XSL_RATING.entries
//   2. 切换到 sortField='rating'，检查 state.filteredSongs 的顺序
//   3. 反向（升序）再验一次，确认没评分的歌始终排在最后
// 用法：node scripts/tests/_verify_rating_sort.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const appSource = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

// 从 app.js 里取出 compareSongs 与 applySongFilters 所需的最小片段来跑
function sourceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  if (start === -1) throw new Error(`找不到起点: ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  if (end === -1) throw new Error(`找不到终点: ${endText}`);
  return source.slice(start, end);
}

const compareSource = sourceBetween(appSource, 'function compareSongs', 'function getSongCardHtml');

const songs = [
  { song_id: 1, display_song_name: '高分歌', sing_count: 5 },
  { song_id: 2, display_song_name: '低分歌', sing_count: 50 },
  { song_id: 3, display_song_name: '没评分的歌', sing_count: 99 },
  { song_id: 4, display_song_name: '中间分歌', sing_count: 10 },
];

function makeRatingApi(map) {
  return {
    averageOf: key => (map[key] ? map[key].average : 0),
    countOf: key => (map[key] ? map[key].count : 0),
  };
}

const ratings = {
  高分歌: { average: 9.5, count: 4 },
  低分歌: { average: 3, count: 2 },
  中间分歌: { average: 6.5, count: 7 },
};

const context = {
  window: { __XSL_RATING: makeRatingApi(ratings) },
  Number,
};
vm.createContext(context);
vm.runInContext(`${compareSource}\nthis.compare = compareSongs;`, context);

function sortBy(dir) {
  return songs.slice().sort((a, b) => context.compare(a, b, 'rating', dir)).map(s => s.display_song_name);
}

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`      actual   = ${JSON.stringify(actual)}`);
    console.log(`      expected = ${JSON.stringify(expected)}`);
    failed += 1;
  }
}

console.log('=== 降序（分数高的在前，没评分的最后）===');
check('降序', sortBy('desc'), ['高分歌', '中间分歌', '低分歌', '没评分的歌']);

console.log('\n=== 升序（分数低的在前，没评分的仍然最后）===');
check('升序', sortBy('asc'), ['低分歌', '中间分歌', '高分歌', '没评分的歌']);

console.log('\n=== 全部没评分时退化为按热度降序（顺序稳定，不随机）===');
context.window.__XSL_RATING = makeRatingApi({});
check('全部未评分', sortBy('desc'), ['没评分的歌', '低分歌', '中间分歌', '高分歌']);

console.log('\n=== 评分接口不可用时不应抛错（退回按热度）===');
context.window.__XSL_RATING = null;
let threw = null;
let degraded = null;
try { degraded = sortBy('desc'); } catch (error) { threw = error.message; }
check('不抛错', threw, null);
check('退化为热度序', degraded, ['没评分的歌', '低分歌', '中间分歌', '高分歌']);

console.log(`\n结论：${failed ? failed + ' 项不符预期' : '全部符合预期'}`);
process.exitCode = failed ? 1 : 0;
