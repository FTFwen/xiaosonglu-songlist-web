// 为缺失「歌切展示元数据」的歌曲，从 song_cut_index.json 补齐 entries 到 song_cut_info.json。
//
// 背景：buildCutInfo() 只负责「台账里没有、需要新建」的条目；本文件里已登记的会被保留。
// 09-17 这批歌曲的名字是新进入台账的，但 song_cut_info.json 是更早生成的，
// 于是校验会报 “songs without cut display metadata”。这个脚本按台账补齐即可。
//
// 幂等：已有条目的歌曲不动。
// 用法：node scripts/tests/_fill_cut_info_0917.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const DATA = path.join(ROOT, 'data/xiaosonglu');
const cutInfoPath = path.join(DATA, 'song_cut_info.json');
const doc = JSON.parse(fs.readFileSync(cutInfoPath, 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'song_catalog.json'), 'utf8'));
const cuts = JSON.parse(fs.readFileSync(path.join(DATA, 'song_cut_index.json'), 'utf8'));

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
const known = new Set(Object.keys(doc.cuts).map(normalize));

// 优先度：单切 > 合集章节 > 合集；同档取更晚日期
const KIND_RANK = { single: 0, 'collection-chapter': 1, replay: 2, collection: 3, compilation: 4 };
function score(item) {
  const rank = KIND_RANK[item.clip_kind] ?? 9;
  return -rank * 1e12 + String(item.clip_date || '').localeCompare('1970-01-01') * 0 + new Date(item.clip_date || 0).getTime();
}

const missingSongs = catalog.songs.filter(song => !known.has(normalize(song.song_name)));
console.log('catalog 歌曲数: ' + catalog.songs.length + '，缺少歌切展示元数据的: ' + missingSongs.length);

const byName = new Map();
for (const item of cuts.items) {
  if (!item.clip_url || item.duplicate_status === 'duplicate') continue;
  const key = normalize(item.song_name);
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push(item);
}

const added = [];
for (const song of missingSongs) {
  const key = normalize(song.song_name);
  const group = byName.get(key) || [];
  if (!group.length) {
    console.log('  ⚠ ' + song.song_name + '：台账里也没有可用歌切，跳过（保持警告）');
    continue;
  }
  const best = group.slice().sort((a, b) => score(b) - score(a))[0];
  doc.cuts[song.song_name] = {
    title: best.chapter_title || best.clip_title || best.song_name,
    kind: best.clip_kind || 'single',
    url: best.clip_url,
  };
  added.push({ song: song.song_name, kind: doc.cuts[song.song_name].kind, url: best.clip_url });
  known.add(key);
}

added.forEach(a => console.log('  + ' + a.song.padEnd(18) + ' [' + a.kind + ']  ' + a.url));
console.log('\n共补齐 ' + added.length + ' 条；song_cut_info 从 ' + Object.keys(doc.cuts).length + ' 条' +
  (added.length ? '（写入后 ' + (Object.keys(doc.cuts).length) + ' 条）' : ''));

if (process.argv.includes('--write')) {
  doc.count = Object.keys(doc.cuts).length;
  doc.generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const sorted = {};
  Object.keys(doc.cuts).sort((a, b) => a.localeCompare(b, 'zh-CN')).forEach(k => { sorted[k] = doc.cuts[k]; });
  doc.cuts = sorted;
  fs.writeFileSync(cutInfoPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log('已写入 ' + path.relative(ROOT, cutInfoPath));
} else {
  console.log('（预演模式，未写文件；加 --write 才会写入）');
}
