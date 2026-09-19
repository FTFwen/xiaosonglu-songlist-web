// 09-17 补录线上验证（开发用，不参与部署）：
// 在真实浏览器里打开线上站点，确认 14 首歌都出现在列表、能搜到、音频能加载。
// 用法：node scripts/tests/_verify_0917_deployed.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
const BASE = process.env.PREVIEW_BASE || 'https://viridis.love';
const PORT = Number(process.env.CDP_PORT || 9488);
const profile = path.join(os.tmpdir(), `xsl-v0917-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' });

let ws = null;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
};

const EXPECT = [
  ['カタオモイ', '单相思'], ['心做し', '心做し'], ['小夜子（中文填词）', '小夜子'], ['小夜子', '小夜子'],
  ['天ノ弱', '天ノ弱'], ['又三郎', '又三郎'], ['少女レイ', '少女レイ'], ['秒针を噛む', '秒针を噛む'],
  ['シリウスの心臓', 'シリウスの心臓'], ['ラピスのお人形', 'ラピスのお人形'], ['白鸟过河滩', '白鸟过河滩'],
  ['探窗', '探窗'], ['在夜里跳舞', '在夜里跳舞'], ['珠玉', '珠玉'],
];

(async () => {
  try {
    let target = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && !target) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find(t => t.type === 'page');
      } catch { /* 等 */ }
      if (!target) await sleep(300);
    }
    ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(target.webSocketDebuggerUrl);
      s.addEventListener('open', () => resolve(s));
      s.addEventListener('error', () => reject(new Error('WS 失败')));
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const msgId = ++id;
      const t = setTimeout(() => { pending.delete(msgId); reject(new Error('CDP 超时 ' + method)); }, 45000);
      pending.set(msgId, m => { clearTimeout(t); resolve(m); });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200);
      return r.result?.result?.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(8000);

    console.log('=== 页面总量 ===');
    console.log(await evaluate(`JSON.stringify({
      meta: (document.getElementById('songMetaText')||{}).textContent,
      cards: document.querySelectorAll('.song-item').length
    })`));

    console.log('\n=== 14 首歌是否都在页面上（含显示名）===');
    const rendered = JSON.parse(await evaluate(`JSON.stringify(
      Array.from(document.querySelectorAll('.song-item')).map(el => {
        const name = el.querySelector('.song-name-text');
        return name ? name.textContent.trim() : '';
      })
    )`));
    for (const [key, display] of EXPECT) {
      const hit = rendered.includes(display);
      check('列表含「' + display + '」(' + key + ')', hit);
    }

    console.log('\n=== 音频是否能加载（HEAD 请求逐首验证）===');
    const audioStatus = JSON.parse(await evaluate(`(async () => {
      const res = await fetch('/data/xiaosonglu/audio_index.json', { cache: 'no-store' });
      const idx = await res.json();
      const names = ${JSON.stringify(EXPECT.map(e => e[0]))};
      const out = {};
      for (const n of names) {
        const rel = idx.audios[n];
        if (!rel) { out[n] = 'MISSING_INDEX'; continue; }
        try {
          const r = await fetch('/' + rel, { method: 'HEAD', cache: 'no-store' });
          out[n] = r.status;
        } catch (e) { out[n] = 'ERR'; }
      }
      return JSON.stringify(out);
    })()`));
    for (const [key] of EXPECT) {
      check('音频可访问 ' + key, audioStatus[key] === 200, 'HTTP ' + audioStatus[key]);
    }

    console.log('\n=== 拼音检索能搜到新歌（库就绪后）===');
    const searchCases = [['gouzhuiqishi', '勾指起誓'], ['hudie', '蝴蝶'], ['yousanlang', '又三郎']];
    for (const [q, expect] of searchCases) {
      await evaluate(`(async () => { await loadPinyinPro(); return true; })()`);
      await evaluate(`(() => {
        const i = document.getElementById('searchInput');
        i.value = ${JSON.stringify(q)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(700);
      const names = JSON.parse(await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.song-item .song-name-text')).map(n => n.textContent.trim()))`));
      check(`拼音 "${q}" 命中「${expect}」`, names.includes(expect), '结果 ' + names.slice(0, 5).join('/'));
      await evaluate(`(() => { const i = document.getElementById('searchInput'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
      await sleep(300);
    }

    console.log(`\n结论：${failed ? failed + ' 项未通过' : '全部通过'}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    child.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})().catch(e => { console.error('验证失败:', e.message); child.kill(); process.exitCode = 1; });
