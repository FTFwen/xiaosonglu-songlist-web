// 音频真实播放验证（开发用，不参与部署）：
// 直接构造 Audio 元素加载线上音频，监听 canplay / error，判定「能不能真的播放」。
// 这比 HEAD 请求更贴近用户实际体验（浏览器音频走 Range GET，不是 HEAD）。
// 用法：node scripts/tests/_verify_audio_playback.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
const PORT = Number(process.env.CDP_PORT || 9511);
const profile = path.join(os.tmpdir(), `xsl-audio-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });

let ws = null;
(async () => {
  try {
    let target = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && !target) {
      try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = l.find(t => t.type === 'page'); } catch { /* 等 */ }
      if (!target) await sleep(300);
    }
    ws = await new Promise((res, rej) => { const s = new WebSocket(target.webSocketDebuggerUrl); s.addEventListener('open', () => res(s)); s.addEventListener('error', () => rej(new Error('ws'))); });
    let id = 0; const pending = new Map();
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)); }, 60000); pending.set(i, m => { clearTimeout(t); res(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300); return r.result?.result?.value; };

    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url: 'https://viridis.love/' });
    await sleep(6000);
    console.log('页面已加载:', await ev('location.href'));

    const targets = ['小夜子（中文填词）', '又三郎', '心做し', '探窗', '珠玉', 'ラピスのお人形'];
    console.log('\n=== 真实播放测试（Audio 元素 + Range GET）===');
    const result = await ev(`(async () => {
      const res = await fetch('/data/xiaosonglu/audio_index.json', { cache: 'no-store' });
      const idx = await res.json();
      const names = ${JSON.stringify(targets)};
      const out = [];
      for (const n of names) {
        const rel = idx.audios[n];
        if (!rel) { out.push({ name: n, verdict: '索引缺失' }); continue; }
        const url = '/' + rel;
        const verdict = await new Promise(resolve => {
          const a = new Audio();
          a.preload = 'metadata';
          let done = false;
          const finish = v => { if (!done) { done = true; a.src = ''; resolve(v); } };
          const timer = setTimeout(() => finish('超时'), 12000);
          a.addEventListener('loadedmetadata', () => { clearTimeout(timer); finish('可播放 时长 ' + Math.round(a.duration) + 's'); });
          a.addEventListener('error', () => { clearTimeout(timer); const e = a.error; finish('错误 code=' + (e ? e.code : '?') + ' ' + (e && e.message ? e.message : '')); });
          a.src = url;
        });
        out.push({ name: n, url, verdict });
      }
      return JSON.stringify(out, null, 1);
    })()`);
    console.log(result);
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    child.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})().catch(e => { console.error('失败:', e.message); child.kill(); process.exitCode = 1; });
