// 生成 2026-09-27 / 2026-10-02（晚场）/ 2026-10-06 三场歌回的 curated 清单。
//
// 事实源 = B 站歌切合集的分P标题（已用 tools 通过 x/web-interface/view 抓取并落盘到 .tmp/pages-*.json）。
// 每场只选一个 canonical 多P合集：segmentIndex == 分P号，cut.kind = 'collection'，
// 因为 canonicalizeBilibiliCutUrl() 会把 ?p= 重写成 segmentIndex。
//
// 用法：node scripts/tests/_build_curated_20260927_1002_1006.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const pages = bvid => JSON.parse(fs.readFileSync(path.join(ROOT, `.tmp/pages-${bvid}.json`), 'utf8').replace(/^\uFEFF/, ''));

// 「NN_歌名 - 艺术家1, 艺术家2」→ { songName, artist }
function splitPart(part) {
  const text = String(part).replace(/^\s*\d{1,3}[_\-.]\s*/u, '').trim();
  const at = text.indexOf(' - ');
  if (at === -1) return { songName: text, artist: '' };
  return { songName: text.slice(0, at).trim(), artist: text.slice(at + 3).trim() };
}

const LIVES = [
  {
    date: '2026-09-27',
    liveId: '80412b54-3b2e-45b6-b0fc-039908d74e13',
    title: '歌杂吧好像是',
    canonical: 'BV1g1ah6REpb',
    uploader: '桐人今天睡大觉',
    sourceParts: 'BV1g1ah6REpb',
    // 同场次第二份歌切合集（心灵火 BV1Xsa36qE8v，31 分P），用于同名复核的独立证据
    sameShowCut: 'https://www.bilibili.com/video/BV1Xsa36qE8v/',
    note: 'canonical = 桐人今天睡大觉 BV1g1ah6REpb（34 分P）；同场心灵火 BV1Xsa36qE8v 仅 31 分P，缺少 P3《凉凉》、P24《沸雪煮相思》、P25《我的心是不夜城》。',
    parts: {
      14: { name: '我的一个道姑朋友（第一遍）', display: '我的一个道姑朋友', version: '第一遍',
        review: '同场 P15 为同一首《我的一个道姑朋友》的第二遍，两段均为独立录制（各 287s），不能共用同一 songName（否则第二段音频会按重名丢弃）。独立证据：同场次另一份歌切合集 BV1Xsa36qE8v（P13、P14 并列标注两遍）。' },
      15: { name: '我的一个道姑朋友（第二遍）', display: '我的一个道姑朋友', version: '第二遍',
        review: '同场 P14 为同一首《我的一个道姑朋友》的第一遍。独立证据：同场次另一份歌切合集 BV1Xsa36qE8v（P13、P14 并列标注两遍）。' },
      21: { lang: '日文', types: ['日V', 'Vocaloid'] },
      27: { lang: '日文', types: ['日V'] },
      29: { lang: '日文', types: ['日V'] },
      31: { lang: '日文', types: ['游戏'] },
      32: { lang: '', types: ['流行'] },
    },
    types: {
      1: ['古风'], 2: ['中V'], 3: ['影视', '流行'], 4: ['影视', '流行'], 5: ['中V'], 6: ['中V'],
      7: ['中V'], 8: ['中V'], 9: ['流行'], 10: ['影视', '经典'], 11: ['华语经典'], 12: ['中V'],
      13: ['中V'], 14: ['古风'], 15: ['古风'], 16: ['中V'], 17: ['中V'], 18: ['翻唱'],
      19: ['国风', '流行'], 20: ['影视', '流行'], 22: ['国风'], 23: ['忘川风华录', '国风'],
      24: ['中V'], 25: ['V圈'], 26: ['V圈'], 28: ['中V'], 30: ['中V'], 33: ['中V'],
      34: ['原创（平行四界）'],
    },
  },
  {
    date: '2026-10-02',
    liveId: 'dc67a9ea-6da7-48f4-bd73-349976e92859',
    title: '久违的唱唱歌',
    canonical: 'BV1UkaS6zEk3',
    uploader: '桐人今天睡大觉',
    sourceParts: 'BV1UkaS6zEk3',
    sameShowCut: 'https://www.bilibili.com/video/BV1Pxa269EiF/',
    skipParts: [28],
    note: 'canonical = 桐人今天睡大觉 BV1UkaS6zEk3（28 分P，P28 是「番外（翻车忘记开伴奏）あの夢をなぞって」39s 假起头，未收录）。同日 13:43 另有测试场「这是一个测试2.0」，其歌切见另一份清单。',
    parts: {
      16: { name: '玛德琳娜电塔' },
      22: { name: 'Melody' },
      21: { remark: '桐人合集 P21 标注《霞光 - 曲锦楠》（157s）；另有小冬青 BV1J1aD64EYP 标注同一位置为《暗黑天国》（266s，ALI PROJECT 曲）。两份资料在同一演唱位置给出不同曲名，此处沿用所选 canonical 合集的写法并保留该分歧。' },
      23: { name: 'SOS', artist: '命依Mei', lang: '', remark: '桐人合集 P23 写作「SOS - 命依Mei（辅助轮版本）」；同场心灵火 BV1Pxa269EiF P28 写作《恋のSOS》。采用多数 UP 主的写法《SOS》，「（辅助轮版本）」为伴奏/和声说明，未计入曲名。' },
    },
    types: {
      1: ['J-Pop'], 2: ['J-Pop'], 3: ['日V', 'Vocaloid'], 4: ['忘川风华录', '国风'], 5: ['华语经典'],
      6: ['游戏（原曲Mili）'], 7: ['中V'], 8: ['忘川风华录', '中V'], 9: ['流行'], 10: ['华语经典'],
      11: ['影视', '华语经典'], 12: ['影视', '流行'], 13: ['流行'], 14: ['流行'], 15: ['J-Pop'],
      16: ['中V'], 17: ['中V'], 18: ['流行'], 19: ['流行'], 20: ['J-Pop'], 21: ['流行'],
      22: ['华语经典'], 23: ['J-Pop'], 24: ['中V'], 25: ['流行'], 26: ['J-Pop'], 27: ['中V'],
    },
    lang: { 1: '日文', 2: '日文', 3: '日文', 15: '日文', 20: '日文', 23: '日文', 26: '日文' },
  },
  {
    date: '2026-10-06',
    liveId: 'bf948f7e-c517-4594-9c1a-5c0c4cf23d6c',
    title: '随便小唱之',
    canonical: 'BV18Jpw6mE82',
    uploader: '心灵火Flame',
    sourceParts: 'BV18Jpw6mE82',
    artistParts: 'BV13JpP6xE6L',
    sameShowCut: 'https://www.bilibili.com/video/BV13JpP6xE6L/',
    note: 'canonical = 心灵火Flame BV18Jpw6mE82（17 分P，分P边界与 BV12spw6VEyq「唱唱little wish和Mystic Light Quest」7:28 精确吻合）；同场桐人今天睡大觉 BV13JpP6xE6L 提供艺术家信息，但其 P11 曲名误写为《浸春芜》。',
    parts: {
      11: { name: 'Mystic Light Quest', remark: '心灵火 P11 写作「Mystic Light Ques」、桐人 P11 误写为《浸春芜》；独立证据 BV12spw6VEyq（2026-10-06 19:32「【小松绿Viridis】唱唱little wish和Mystic Light Quest」7:28）与 P10《Little Wish》239s + P11 208s = 447s 吻合，曲名确认为《Mystic Light Quest》。' },
      15: { version: '半首', remark: '心灵火 P15 标注「小兔子乖乖(半首)」87s（桐人 P15 为 110s 完整版）。' },
      16: { version: '半首', remark: '心灵火 P16 标注「蜗牛与黄鹂鸟（半首）」97s（桐人 P16 为 105s）。' },
      17: { version: '半首', remark: '心灵火 P17 标注「小螺号（半首）」76s（桐人 P17 为 87s）。' },
    },
    types: {
      1: ['流行'], 2: ['SNH48', '偶像'], 3: ['流行'], 4: ['SNH48', '偶像'], 5: ['SNH48', '偶像'],
      6: ['SNH48', '偶像'], 7: ['SNH48', '偶像'], 8: ['SNH48', '偶像'], 9: ['SNH48', '偶像'],
      10: ['游戏'], 11: ['游戏'], 12: ['V圈'], 13: ['流行'], 14: ['V圈'], 15: ['民谣'],
      16: ['民谣'], 17: ['民谣'],
    },
  },
];

function buildLive(spec) {
  const src = pages(spec.sourceParts);
  const artistSrc = spec.artistParts ? pages(spec.artistParts) : null;
  const artistBySeq = new Map();
  if (artistSrc) {
    for (const part of artistSrc.pages) {
      const seq = Number(String(part.part).match(/^(\d{1,3})[_\-.]/u)?.[1]);
      const parsed = splitPart(part.part);
      if (Number.isSafeInteger(seq) && parsed.artist) artistBySeq.set(seq, parsed.artist);
    }
  }
  const songs = [];
  for (const part of src.pages) {
    const seq = Number(String(part.part).match(/^(\d{1,3})[_\-.]/u)?.[1]) || part.page;
    if (spec.skipParts?.includes(seq)) continue;
    const over = spec.parts?.[seq] ?? {};
    const parsed = splitPart(part.part);
    const songName = over.name ?? parsed.songName.replace(/[（(]\s*半首\s*[）)]/gu, '').trim();
    const artist = over.artist ?? parsed.artist ?? '';
    const language = over.lang ?? spec.lang?.[seq] ?? '中文';
    const typeTags = over.types ?? spec.types?.[seq] ?? [];
    const song = {
      segmentIndex: seq,
      songName,
      artist: artist || (artistBySeq.get(seq) ?? ''),
      ...(language ? { language } : {}),
      typeTags,
      statusLabels: ['歌回', '歌切合集复核'],
      songResolutionMethod: 'song-cut-collection-chapter',
      confidence: 0.9,
      cut: {
        url: `https://www.bilibili.com/video/${spec.canonical}/`,
        bvid: spec.canonical,
        kind: 'collection',
        uploader: spec.uploader,
        chapterTitle: String(part.part),
        duration: `${Math.floor(part.duration / 60)}:${String(part.duration % 60).padStart(2, '0')}`,
        dateSource: 'collection-title',
        songNameSource: 'chapter-title',
      },
    };
    if (over.display) song.displaySongName = over.display;
    if (over.version) song.displayVersion = over.version;
    if (over.remark) song.remark = over.remark;
    if (over.review) {
      song.sameNameReview = {
        decision: 'confirmed-repeat',
        notes: over.review,
        evidenceUrls: [spec.sameShowCut],
      };
    }
    songs.push(song);
  }
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

const built = LIVES.map(spec => ({ spec, manifest: buildLive(spec) }));
for (const { spec, manifest } of built) {
  const target = path.join(ROOT, `data/xiaosonglu/_curated_${spec.date}.json`);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`已写入 ${path.relative(ROOT, target)}`);
  }
  const dup = manifest.songs.map(s => s.songName);
  const dupes = dup.filter((name, index) => dup.indexOf(name) !== index);
  console.log(`\n== ${spec.date} ${spec.title} | ${manifest.songs.length} 首 | canonical ${spec.canonical} | 重复曲名 ${dupes.length ? dupes.join('、') : '无'}`);
  for (const song of manifest.songs) {
    console.log(`  P${String(song.segmentIndex).padStart(2)} ${song.songName}${song.artist ? ' - ' + song.artist : ''}${song.displayVersion ? ' [' + song.displayVersion + ']' : ''} ${song.language} ${song.typeTags.join('/')}`);
  }
}
if (!process.argv.includes('--write')) console.log('\n（预演模式，未写文件；加 --write 才会写入）');
