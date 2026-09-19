// 把 2026-09-17 场次的新歌元数据写入 song_metadata_overrides.json。
//
// 覆盖文件是「同名歌曲元数据的事实源」：catalog 构建时以它为准，
// 避免同一首歌的不同演唱（分段）各自带一套歌手/标签而互相覆盖。
//
// 用法：node scripts/tests/_apply_overrides_0917.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const target = path.join(ROOT, 'data/xiaosonglu/song_metadata_overrides.json');
const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
const table = doc.bySongName;

// 键 = row_key（剧本内统一用真实曲名）
const additions = {
  // 已在库但补 display_song_name（视频用中文译名，与既有 08-11 条目一致）
  カタオモイ: { display_song_name: '单相思' },

  心做し: {
    artist: '蝶々P / GUMI',
    artist_search: '蝶々P GUMI',
    language: '日文',
    type_tags: ['Vocaloid', 'J-Pop'],
  },
  小夜子: {
    artist: 'みきとP / 初音ミク',
    artist_search: 'みきとP 初音ミク',
    language: '日文',
    type_tags: ['Vocaloid', 'J-Pop'],
    display_version: '中文填词/日文原版',
  },
  // 中文填词版在事实源里必须用独立的 songName（否则音频会被按重名丢弃），
  // 所以覆盖表也要单独给它一条，否则 artist/type 会取不到。
  // 键含全角括号，必须加引号（全角括号不是合法的标识符字符）。
  '小夜子（中文填词）': {
    display_song_name: '小夜子',
    artist: 'みきとP / 初音ミク',
    artist_search: 'みきとP 初音ミク',
    language: '中文',
    type_tags: ['中文填词', 'Vocaloid'],
    display_version: '中文填词',
  },
  天ノ弱: {
    artist: '164 / GUMI',
    artist_search: '164 GUMI',
    language: '日文',
    type_tags: ['Vocaloid', 'J-Pop'],
  },
  又三郎: {
    artist: 'ヨルシカ',
    artist_search: 'ヨルシカ',
    language: '日文',
    type_tags: ['J-Pop'],
  },
  秒针を噛む: {
    artist: 'R Sound Design / 初音ミク',
    artist_search: 'R Sound Design 初音ミク',
    language: '日文',
    type_tags: ['Vocaloid', 'J-Pop'],
  },
  ラピスのお人形: {
    artist: 'ヰ世界情緒',
    artist_search: 'ヰ世界情緒',
    language: '日文',
    type_tags: ['J-Pop'],
  },
  探窗: {
    artist: '浮生梦',
    artist_search: '浮生梦',
    language: '中文',
    type_tags: ['古风', '翻唱'],
  },
  在夜里跳舞: {
    artist: '单依纯',
    artist_search: '单依纯',
    language: '中文',
    type_tags: ['流行'],
  },
  珠玉: {
    artist: '单依纯',
    artist_search: '单依纯',
    language: '中文',
    type_tags: ['流行'],
  },
};

let added = 0;
let updated = 0;
for (const [name, patch] of Object.entries(additions)) {
  if (!table[name]) {
    table[name] = patch;
    added += 1;
    console.log('新增覆盖: ' + name + ' → ' + JSON.stringify(patch));
  } else {
    const before = JSON.stringify(table[name]);
    table[name] = { ...table[name], ...patch };
    const after = JSON.stringify(table[name]);
    if (before !== after) {
      updated += 1;
      console.log('更新覆盖: ' + name);
      console.log('  旧: ' + before);
      console.log('  新: ' + after);
    } else {
      console.log('无需变更: ' + name);
    }
  }
}

// 保持键名排序，便于 diff
const sorted = {};
Object.keys(table).sort((a, b) => a.localeCompare(b, 'zh-CN')).forEach(k => { sorted[k] = table[k]; });
doc.bySongName = sorted;
doc.updatedAt = new Date().toISOString().slice(0, 10);

if (process.argv.includes('--write')) {
  fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log('\n已写入 ' + path.relative(ROOT, target) + '（新增 ' + added + '，更新 ' + updated + '，共 ' + Object.keys(sorted).length + ' 条）');
} else {
  console.log('\n（预演模式，未写文件；加 --write 才会写入）新增 ' + added + '，更新 ' + updated);
}
