// 拼音检索回归测试：守住「冷启动时把空拼音写进缓存」这个曾经的严重 bug。
//
// 背景：pinyin-pro 是懒加载的（首页省 315KB），而搜索输入事件是「启动加载 + 立刻筛选」。
// 早期实现里 getSongPinyin() 会把结果无条件写缓存 —— 库还没到时会写入 {full:'',initials:''}，
// 于是 168 首歌的拼音索引被永久固定成空串，此后即使库加载完成，拼音检索也永远搜不出东西。
// 这个 bug 静默、无报错，只有真的在浏览器里冷启动搜一次才会发现。
//
// 这里同时守住配套的两点：
//   1. 库不可用时不得写缓存，也不得以空结果为准（要等库就绪后重算）
//   2. 匹配前要去掉非字母数字（日文假名会原样留在拼音串里，把后面的匹配全截断）
//
// 运行：node --test scripts/tests/pinyin_search.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const appSource = await readFile(new URL('js/app.js', root), 'utf8');
const workshopSource = await readFile(new URL('workshop/js/app.js', root), 'utf8');

function sourceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `找不到起点: ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `找不到终点: ${endText}`);
  return source.slice(start, end);
}

// 把拼音相关的四个函数装进一个干净的上下文里跑
function buildContext(source, { withLibrary }) {
  const segment = sourceBetween(source, 'const pinyinCache = new Map();', 'function applySongFilters()');
  const normalizeSource = sourceBetween(source, 'function normalizePinyinForMatch', 'function applySongFilters');
  const context = {
    window: withLibrary
      ? {
        pinyinPro: {
          pinyin: (text) => {
            // 只把汉字转成拼音，其余字符原样保留（与 pinyin-pro 的 nonZh:'consecutive' 行为一致）
            const map = { 少: 'shao', 女: 'nv', 勾: 'gou', 指: 'zhi', 起: 'qi', 誓: 'shi', 蝴: 'hu', 蝶: 'die' };
            return [...String(text)].map(ch => map[ch] || ch);
          },
        },
      }
      : {},
    document: { createElement: () => ({}), head: { appendChild: () => {} } },
  };
  vm.createContext(context);
  vm.runInContext(`${segment}\n${normalizeSource}\nthis.api = { getSongPinyin, pinyinCache, normalizePinyinForMatch };`, context);
  return context.api;
}

const SONG = { row_key: '少女レイ', display_song_name: '少女レイ', artist: 'みきとP' };

test('库不可用时不得写入缓存，也不得返回空结果当真', () => {
  const api = buildContext(appSource, { withLibrary: false });
  const result = api.getSongPinyin(SONG);
  // 注意：对象来自 vm 里的另一个 realm，deepEqual 会比较原型而失败，这里逐字段比
  assert.equal(result.full, '', '库不可用时 full 暂时为空');
  assert.equal(result.initials, '', '库不可用时 initials 暂时为空');
  assert.equal(api.pinyinCache.size, 0, '库不可用时绝不能写缓存（否则拼音索引会被永久固定成空串）');
});

test('库就绪后同一首歌能算出拼音并被缓存', () => {
  const api = buildContext(appSource, { withLibrary: true });
  const result = api.getSongPinyin(SONG);
  assert.ok(result.full.includes('shaonv'), `应包含 shaonv，实际: ${result.full}`);
  assert.ok(result.initials.includes('sn'), `首字母应包含 sn，实际: ${result.initials}`);
  assert.equal(api.pinyinCache.size, 1, '库就绪后应正常缓存');
});

test('日文假名不会截断后续匹配（去噪后才能命中）', () => {
  const api = buildContext(appSource, { withLibrary: true });
  const pi = api.getSongPinyin(SONG);
  // 假名原样留在 full 里，这正是需要去噪的原因
  assert.ok(/[^\x00-\x7F]/.test(pi.full), '前提：full 里确实混入了非 ASCII 字符');
  const normalized = api.normalizePinyinForMatch(pi.full);
  assert.ok(/^[a-z0-9]*$/.test(normalized), `去噪后应只剩字母数字，实际: ${normalized}`);
  assert.ok(normalized.includes('shaonv'), '去噪后仍能匹配到汉字部分');
});

test('主站与 workshop 两处实现都带上了这两个修复', () => {
  for (const [name, source] of [['js/app.js', appSource], ['workshop/js/app.js', workshopSource]]) {
    assert.match(source, /if \(!window\.pinyinPro\) return \{ full: '', initials: '' \};/, `${name} 缺少「库不可用不落缓存」的保护`);
    assert.match(source, /function normalizePinyinForMatch/, `${name} 缺少匹配去噪函数`);
    assert.match(source, /applySongFilters\(\);/, `${name} 的 loadPinyinPro 应在库就绪后补一次重算`);
  }
});
