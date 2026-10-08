// 生成剩余待复核场次的 curated 清单：
//   2026-09-21 半小时电话            （电台回，仅结尾一首清唱）
//   2026-09-26 学歌来袭！            （练歌回，两条独立歌切）
//   2026-10-02 这是一个测试2.0（下午） （测试场 13:43-14:39，canonical 合集 BV1Pxa269EiF 的 P1-P7）
//
// 事实源都已用 .tmp/bili.mjs 的 view 接口核验（分P标题/时长/发布日），不猜测 URL。
// segmentIndex 是事实源里的段号；cut.kind='collection' 时 canonicalizeBilibiliCutUrl()
// 会把 ?p= 强制重写成 segmentIndex，故 P 号必须与 segmentIndex 一致。
//
// 用法：node scripts/tests/_build_curated_pending_0921_0926_1002pm.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const mmss = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const LIVES = [
  {
    file: '_curated_2026-09-21.json',
    date: '2026-09-21',
    liveId: 'a9f69644-3410-48e4-b8e3-2cde99150275',
    title: '半小时电话',
    canonical: 'BV1xqhq6hEYX',
    uploader: 'Mintolu',
    note: 'canonical = Mintolu BV1xqhq6hEYX「【小松绿Viridis】电台回超萌下播+あの夢をなぞって清唱」（P1 完整下播片段 358s、P2 小区あの夢をなぞって纯享 126s）。该场为电台/杂谈回，全程只有结尾一首清唱；结合 liveId a9f69644 的弹幕反应窗口（开播 20:10:41，反应段 00:33:43-00:38:22 = 20:44-20:47，即下播前最后几分钟）与合集描述「20260921 半小时电话」共同锁定。',
    songs: [
      {
        segmentIndex: 2,
        songName: 'あの夢をなぞって',
        artist: 'YOASOBI',
        language: '日文',
        typeTags: ['J-Pop'],
        duration: 126,
        chapterTitle: '小区あの夢をなぞって纯享',
        dateSource: 'description-date',
        remark: '电台回结尾清唱，非完整伴奏演唱；证据为同一场次的独立歌切 BV1xqhq6hEYX P2（126s），其描述含「20260921 半小时电话」。',
      },
    ],
  },
  {
    file: '_curated_2026-09-26.json',
    date: '2026-09-26',
    liveId: '7cf1f23c-88cf-4334-9c55-a434d299ec2a',
    title: '学歌来袭！',
    note: '本站该场为练歌回（开播 16:57:34、结束 19:19:35，四段弹幕反应窗口全是练歌/跟唱气氛）。没有整场合集，仅两条与场次日期一致的独立歌切；弹幕反应窗口显示当场的练歌不止这两首，因此 2 首是下限而非完整歌单。',
    songs: [
      {
        segmentIndex: 1,
        songName: '农夫渔夫',
        artist: '大乔小乔',
        language: '中文',
        typeTags: ['民谣'],
        duration: 189,
        bvid: 'BV1suhR6CEpJ',
        uploader: '不爱笑的猩',
        clipTitle: '【绿の学歌|农夫渔夫】请给我一个周末的问候【小松绿viridis】',
        dateSource: 'description-date',
        remark: '标题为「绿の学歌」，描述明示「小松绿直播学歌回」「【小松绿viridis】2026/9/26」，是当场次的专用歌切。',
      },
      {
        segmentIndex: 1,
        songName: 'ハッピーエンド',
        artist: 'back number',
        language: '日文',
        typeTags: ['J-Pop'],
        duration: 1025,
        bvid: 'BV1VahR6ZEay',
        uploader: 'Mintolu',
        clipTitle: '【小松绿Viridis/自用】学歌回三战痛亲王金曲happy end，区了但是好舒服',
        dateSource: 'description-date',
        remark: 'UP 主自用练歌记录（17:05，含多次尝试，非精剪歌切）。标题中的「痛亲王」是 back number 的中文昵称，「happy end」即《ハッピーエンド》；描述含「20260926 学歌来袭！」。',
      },
    ],
  },
  {
    file: '_curated_2026-10-02-afternoon.json',
    date: '2026-10-02',
    liveId: 'f640adb0-fc83-4e93-8088-dec72c50db14',
    title: '这是一个测试2.0',
    canonical: 'BV1Pxa269EiF',
    uploader: '心灵火Flame',
    note: 'canonical = 心灵火Flame BV1Pxa269EiF（31 分P）的 P1-P7。该合集把 13:43-14:39 的测试场「这是一个测试2.0」与 21:57 开播的晚场「久违的唱唱歌」拼在一起：P1-P7 属于下午测试场（合集创建于 17:21，晚场尚未开播），P8 起才是晚场（晚场歌切见另一份清单 _curated_2026-10-02.json）。P6「可爱小动静」31s 是杂音片段而非演唱，未收录。独立证据：dioneni BV19aaS6jEaS（2026-10-02 19:02 发布《月が綺麗ねと言われたい！》147s，描述「素材来源：2026.10.02」）与 P5/P7 的 148s 吻合。',
    songs: [
      { segmentIndex: 1, songName: '恋爱困难少女', artist: 'ChiliChill乐团', language: '中文', typeTags: ['流行'], duration: 244, chapterTitle: '恋爱困难少女' },
      { segmentIndex: 2, songName: '君色に染まる', artist: 'TOKOTOKO（西沢さんP） / GUMI', language: '日文', typeTags: ['Vocaloid', 'J-Pop'], duration: 189, chapterTitle: '君色に染まる' },
      { segmentIndex: 3, songName: '初恋日記', artist: '香椎モイミ / 音街鳗', language: '日文', typeTags: ['Vocaloid', 'J-Pop'], duration: 188, chapterTitle: '初恋日記' },
      { segmentIndex: 4, songName: '萤萤微光', artist: '泠鸢yousa', language: '中文', typeTags: ['原创', '流行'], duration: 234, chapterTitle: '萤萤微光', remark: '泠鸢yousa 为崩坏：星穹铁道「流萤」短片演唱的原创曲（BV1s6421Z7jx，暗猫の祝福 2024-06-20 发布）。' },
      {
        segmentIndex: 5,
        songName: '月が綺麗ねと言われたい!（第一遍）',
        displaySongName: '月が綺麗ねと言われたい!',
        displayVersion: '第一遍',
        artist: '柿崎ユウタ',
        language: '日文',
        typeTags: ['J-Pop'],
        duration: 148,
        chapterTitle: '月が綺麗ねと言われたい!',
        review: '同场 P7 为同一首《月が綺麗ねと言われたい!》的第二遍，两段均为独立录制（各 148s），不能共用同一 songName（否则第二段音频会按重名丢弃）。独立证据：dioneni BV19aaS6jEaS（2026-10-02 19:02 发布，147s，描述「素材来源：2026.10.02」）。',
      },
      {
        segmentIndex: 7,
        songName: '月が綺麗ねと言われたい!（第二遍）',
        displaySongName: '月が綺麗ねと言われたい!',
        displayVersion: '第二遍',
        artist: '柿崎ユウタ',
        language: '日文',
        typeTags: ['J-Pop'],
        duration: 148,
        chapterTitle: '月が綺麗ねと言われたい!2',
        review: '同场 P5 为同一首《月が綺麗ねと言われたい!》的第一遍。独立证据：dioneni BV19aaS6jEaS（2026-10-02 19:02 发布，147s，描述「素材来源：2026.10.02」）。',
      },
    ],
    sameShowCut: 'https://www.bilibili.com/video/BV19aaS6jEaS/',
  },
];

function buildLive(spec) {
  const songs = spec.songs.map(entry => {
    const isCollection = Boolean(spec.canonical);
    const cut = {
      url: isCollection ? `https://www.bilibili.com/video/${spec.canonical}/` : `https://www.bilibili.com/video/${entry.bvid}/`,
      bvid: isCollection ? spec.canonical : entry.bvid,
      kind: isCollection ? 'collection' : 'single',
      uploader: isCollection ? spec.uploader : entry.uploader,
      chapterTitle: entry.chapterTitle ?? '',
      title: entry.clipTitle ?? entry.songName,
      duration: mmss(entry.duration),
      dateSource: entry.dateSource ?? 'collection-title',
      songNameSource: 'chapter-title',
    };
    const song = {
      segmentIndex: entry.segmentIndex,
      songName: entry.songName,
      artist: entry.artist,
      language: entry.language,
      typeTags: entry.typeTags,
      statusLabels: ['歌回', '歌切复核'],
      songResolutionMethod: isCollection ? 'song-cut-collection-chapter' : 'song-cut-title',
      confidence: 0.85,
      cut,
    };
    if (entry.displaySongName) song.displaySongName = entry.displaySongName;
    if (entry.displayVersion) song.displayVersion = entry.displayVersion;
    if (entry.remark) song.remark = entry.remark;
    if (entry.review) {
      song.sameNameReview = {
        decision: 'confirmed-repeat',
        notes: entry.review,
        evidenceUrls: [spec.sameShowCut ?? ''],
      };
    }
    return song;
  });
  return {
    schemaVersion: 1,
    notes: spec.note,
    live: {
      liveId: spec.liveId,
      date: spec.date,
      title: spec.title,
      replayId: `live:${spec.liveId}`,
      replayDateSource: 'live-api-date',
    },
    songs,
  };
}

for (const spec of LIVES) {
  const manifest = buildLive(spec);
  const target = path.join(ROOT, 'data/xiaosonglu', spec.file);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`已写入 ${path.relative(ROOT, target)}`);
  }
  const names = manifest.songs.map(s => s.songName);
  const dupes = names.filter((name, index) => names.indexOf(name) !== index);
  console.log(`\n== ${spec.date} ${spec.title} | ${manifest.songs.length} 首 | canonical ${spec.canonical ?? '(无，单曲歌切)'} | 重复曲名 ${dupes.length ? dupes.join('、') : '无'}`);
  for (const song of manifest.songs) {
    console.log(`  P${String(song.segmentIndex).padStart(2)} ${song.songName}${song.artist ? ' - ' + song.artist : ''}${song.displayVersion ? ' [' + song.displayVersion + ']' : ''} ${song.language} ${song.typeTags.join('/')} | ${song.cut.kind} ${song.cut.bvid} ${song.cut.duration}${song.cut.chapterTitle ? ' | ' + song.cut.chapterTitle : ''}`);
  }
}
if (!process.argv.includes('--write')) console.log('\n（预演模式，未写文件；加 --write 才会写入）');
