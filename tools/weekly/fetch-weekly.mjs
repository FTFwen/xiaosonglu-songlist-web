// 小松绿周表抓取：置顶动态图片 -> workshop/assets/weekly/ + manifest.json
// 用法: node tools/weekly/fetch-weekly.mjs [--force]
// 无第三方依赖（Node >= 18）。退出码：0=成功（无论是否有更新），2=接口失败。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const UID = '1891335475';            // 小松绿 space UID（直播间 1727071052）
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ASSET_DIR = path.join(ROOT, 'workshop', 'assets', 'weekly');
const DATA_DIR = path.join(ROOT, 'workshop', 'data', 'weekly');
const MANIFEST = path.join(DATA_DIR, 'manifest.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const force = process.argv.includes('--force');

let cookieJar = '';
const readJson = p => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

async function getJson(url, referer) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: referer || 'https://www.bilibili.com/', ...(cookieJar ? { Cookie: cookieJar } : {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function ensureCookie() {
  if (cookieJar) return;
  const spi = await getJson('https://api.bilibili.com/x/frontend/finger/spi');
  if (spi.code !== 0 || !spi.data?.b_3) throw new Error(`spi ${spi.code}`);
  cookieJar = `buvid3=${spi.data.b_3}; buvid4=${spi.data.b_4}`;
}

const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

async function wbiKeys() {
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav');
  const w = nav?.data?.wbi_img;
  if (!w) throw new Error('nav 无 wbi_img');
  const pick = u => (String(u).match(/(\w{32})\.\w+$/) || [])[1] || '';
  return { img: pick(w.img_url), sub: pick(w.sub_url) };
}

function signedQuery(params, img, sub) {
  const key = MIXIN_TAB.map(i => (img + sub)[i]).join('').slice(0, 32);
  const merged = { ...params, wts: Math.floor(Date.now() / 1000) };
  const q = Object.keys(merged).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(merged[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${q}&w_rid=${crypto.createHash('md5').update(q + key).digest('hex')}`;
}

// 带重试拉置顶动态（接口对裸指纹有抖动，重试 + 间隔可稳定拿到）
async function fetchTopDynamic() {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const { img, sub } = await wbiKeys();
      const q = signedQuery({ host_mid: UID, offset: '', timezone_offset: -480, platform: 'web', features: 'itemOpusStyle' }, img, sub);
      const data = await getJson(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?${q}`, `https://space.bilibili.com/${UID}/dynamic`);
      if (data.code !== 0) throw new Error(`feed/space ${data.code} ${data.message}`);
      const items = data.data.items || [];
      const top = items.find(i => i?.modules?.module_tag?.text === '置顶')
        || items.find(i => i?.modules?.module_dynamic?.major?.opus?.pics?.length);
      if (!top) throw new Error(`items=${items.length} 无置顶/带图动态`);
      const opus = top.modules.module_dynamic.major.opus;
      return {
        title: String(opus.title || '').trim(),
        text: String(opus?.summary?.text || '').trim(),
        pubTime: String(top?.modules?.module_author?.pub_time || ''),
        jumpUrl: String(top?.basic?.jump_url || ''),
        id: String(top?.id_str || top?.id || ''),
        pics: (opus.pics || []).map(p => ({ url: String(p.url || '').replace(/@.+$/, ''), width: p.width || 0, height: p.height || 0 })),
      };
    } catch (e) {
      console.error(`  尝试 ${attempt}/4 失败: ${e.message}`);
      if (attempt === 4) throw e;
      await sleep(4000 * attempt);
    }
  }
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://space.bilibili.com/' } });
  if (!res.ok) throw new Error(`下载 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

const main = async () => {
  await ensureCookie();
  const top = await fetchTopDynamic();
  // 周表是竖版长图（宽 < 高）；横版多为横幅/海报
  const weekly = top.pics.filter(p => p.width && p.height && p.height > p.width);
  if (!weekly.length) { console.error('置顶动态中没有竖版图片，周表缺失'); process.exit(2); }
  const fingerprint = crypto.createHash('sha256').update(weekly.map(p => p.url).join('|')).digest('hex').slice(0, 16);

  const prev = readJson(MANIFEST);
  if (!force && prev && prev.fingerprint === fingerprint) {
    console.log('UNCHANGED 周表未更新');
    console.log(`JSON ${JSON.stringify({ unchanged: true, fingerprint, title: prev.title })}`);
    return;
  }

  fs.mkdirSync(ASSET_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 归档旧文件（按旧指纹命名，保留最近 8 份）
  if (prev?.fingerprint) {
    for (const f of prev.images || []) {
      const from = path.join(ASSET_DIR, f.file);
      if (fs.existsSync(from)) {
        const archiveDir = path.join(ASSET_DIR, 'archive');
        fs.mkdirSync(archiveDir, { recursive: true });
        const to = path.join(archiveDir, `${prev.fingerprint}-${f.file}`);
        if (!fs.existsSync(to)) fs.renameSync(from, to);
      }
    }
    const archives = fs.readdirSync(path.join(ASSET_DIR, 'archive')).filter(n => n.endsWith('.jpg') || n.endsWith('.png')).sort();
    while (archives.length > 24) fs.unlinkSync(path.join(ASSET_DIR, 'archive', archives.shift()));
  }

  const images = [];
  for (const [i, p] of weekly.entries()) {
    const file = `current-${i}.jpg`;
    const bytes = await download(p.url, path.join(ASSET_DIR, file));
    images.push({ file, width: p.width, height: p.height, bytes, sourceUrl: p.url });
    console.log(`  下载 ${file} ${p.width}x${p.height} ${bytes}B`);
    await sleep(300);
  }
  const manifest = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    fingerprint,
    title: top.title,
    pubTime: top.pubTime,
    dynamicId: top.id,
    dynamicUrl: top.jumpUrl || `https://space.bilibili.com/${UID}/dynamic`,
    images,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('UPDATED 周表已更新');
  console.log(`JSON ${JSON.stringify({ changed: true, fingerprint, title: top.title, images: images.length })}`);
};

main().catch(e => { console.error('FATAL', e.message); process.exit(2); });
