// 生成 2026-09-17 场次（歌切合集 BV1xger6jEYS，14 分P）的 curated 清单。
//
// 这是下载与入库的「事实源」：分P编号、歌曲名、切链接、同名复核证据都写在这里。
// 生成逻辑刻意写在脚本里而不是手搓 JSON，便于复核与复现。
//
// 用法：node scripts/tests/_build_curated_0917.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const LIVE = {
  date: '2026-09-17',
  replayId: 'live:1a3cdbe0-3ead-410e-90df-f4c8d2cfee81',
  liveId: '1a3cdbe0-3ead-410e-90df-f4c8d2cfee81',
  title: 'MIMIC PARPY来袭！',
};
const COLLECTION = 'https://www.bilibili.com/video/BV1xger6jEYS/';
// 同一场次的另一份歌切合集（锦芸_official），用作同名复核的独立证据
const SAME_SHOW_CUT = 'https://www.bilibili.com/video/BV19Eey6qEaj/';

const review = (notes, ...urls) => ({ decision: 'confirmed-repeat', notes, evidenceUrls: urls });

// segmentIndex = B 站分P 序号；kind 均为「合集章节」
const songs = [
  {
    segmentIndex: 1,
    songName: 'カタオモイ',
    displaySongName: '单相思',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
    sameNameReview: review(
      '同一首歌此前已在库（2026-08-11，单切 BV1znuz6eED5）。本次为 09-17 场次同曲再唱，独立证据：同场次另一份歌切合集 BV19Eey6qEaj。',
      SAME_SHOW_CUT,
    ),
  },
  {
    segmentIndex: 2,
    songName: '心做し',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
  },
  {
    segmentIndex: 3,
    // 注意：这条与 P4 必须用不同的 songName。
    // ingest 工具按「歌名」去重，同名的第二段会走 skipped-duplicate 分支、
    // 拿不到独立音频；而这里两版是分别录制的两份音频，需要各自入库。
    // 中文填词版与日文原版在 UI 上都显示为「小夜子」，靠 display_version 区分。
    songName: '小夜子（中文填词）',
    displaySongName: '小夜子',
    displayVersion: '中文填词',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
    sameNameReview: review(
      '与同场 P4 为同一首 みきとP《小夜子》的两个语言版本（P3 中文填词 4:09、P4 日文原版 4:11），因此不能用同一 songName 入库（否则第二段音频会被按重名丢弃）。独立证据：hanser 中文填词版翻唱 BV1eUtg6tEAe（4:13）。',
      'https://www.bilibili.com/video/BV1eUtg6tEAe/',
      SAME_SHOW_CUT,
    ),
  },
  {
    segmentIndex: 4,
    songName: '小夜子',
    displaySongName: '小夜子',
    displayVersion: '日文原版',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
    sameNameReview: review(
      '与同场 P3 同名：确认为同一首 みきとP《小夜子》的日文原版。独立证据：BV1BCeS6dEL1（4:19）、BV1pv411Y7Cx（4:50）。',
      'https://www.bilibili.com/video/BV1BCeS6dEL1/',
      'https://www.bilibili.com/video/BV1pv411Y7Cx/',
    ),
  },
  {
    segmentIndex: 5,
    songName: '天ノ弱',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
  },
  {
    segmentIndex: 6,
    songName: '又三郎',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
  },
  {
    segmentIndex: 7,
    songName: '少女レイ',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
    sameNameReview: review(
      '同一首歌此前已在库两次（2026-08-07 单切 BV1Xiu86aEwV、2026-08-20）。本次为 09-17 同曲再唱。独立证据：同场次另一份歌切合集 BV19Eey6qEaj。',
      SAME_SHOW_CUT,
    ),
  },
  {
    segmentIndex: 8,
    songName: '秒针を噛む',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
  },
  {
    segmentIndex: 9,
    songName: 'シリウスの心臓',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
    sameNameReview: review(
      '同一首歌此前已在库（2026-08-18）。本次为 09-17 同曲再唱。独立证据：同场次单切 BV1MPer6HE5Q（野翎鸢，4:52）。',
      'https://www.bilibili.com/video/BV1MPer6HE5Q/',
      SAME_SHOW_CUT,
    ),
  },
  {
    segmentIndex: 10,
    songName: 'ラピスのお人形',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
  },
  {
    segmentIndex: 11,
    songName: '白鸟过河滩',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
    sameNameReview: review(
      '同一首歌此前已在库（2026-08-11，半场）。本次为 09-17 同曲再唱。独立证据：同场次单切 BV1YRe664ENb（3:35）。',
      'https://www.bilibili.com/video/BV1YRe664ENb/',
      SAME_SHOW_CUT,
    ),
  },
  {
    segmentIndex: 12,
    songName: '探窗',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
  },
  {
    segmentIndex: 13,
    songName: '在夜里跳舞',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
  },
  {
    segmentIndex: 14,
    songName: '珠玉',
    cut: { kind: 'collection-chapter', url: COLLECTION, bvid: 'BV1xger6jEYS' },
  },
];

const manifest = { live: LIVE, songs };
const target = path.join(ROOT, 'data/xiaosonglu/_curated_2026-09-17.json');

if (process.argv.includes('--write')) {
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('已写入 ' + path.relative(ROOT, target));
} else {
  console.log('（预演模式，未写文件；加 --write 才会写入）');
}
console.log('场次: ' + LIVE.date + '  ' + LIVE.replayId);
console.log('分P: ' + songs.length);
songs.forEach(s => {
  const flag = s.sameNameReview ? ' [同名复核]' : '';
  console.log('  P' + String(s.segmentIndex).padStart(2) + '  ' + s.songName + (s.displayVersion ? '（' + s.displayVersion + '）' : '') + flag);
});
