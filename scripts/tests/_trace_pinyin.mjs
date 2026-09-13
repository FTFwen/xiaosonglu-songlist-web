// 拼音检索逐字追踪（开发用，不参与部署）：每敲一个字符就记录结果条数，
// 并直接打印目标歌曲的全拼/首字母，用来定位是「竞态」还是「拼音生成噪声」。
// 用法（先起预览服务器）：
//   node scripts/tests/_rating_preview_server.mjs
//   node scripts/tests/_trace_pinyin.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
const BASE = process.env.PREVIEW_BASE || 'http://127.0.0.1:8099';
const PORT = Number(process.env.CDP_PORT || 9411);
const profile = path.join(os.tmpdir(), `xsl-pytrace-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

let ws = null;

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
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', () => reject(new Error('WS 失败')));
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const msgId = ++id;
      const timer = setTimeout(() => { pending.delete(msgId); reject(new Error(`CDP 超时: ${method}`)); }, 30000);
      pending.set(msgId, msg => { clearTimeout(timer); resolve(msg); });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
    const evaluate = async expression => {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.result?.exceptionDetails) return `EXC: ${JSON.stringify(res.result.exceptionDetails).slice(0, 200)}`;
      return res.result?.result?.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(5000);

    console.log('=== 拼音库就绪 ===');
    await evaluate(`(async () => { await loadPinyinPro(); return true; })()`);
    await sleep(500);

    console.log('\n=== 目标歌曲的拼音（库已就绪，缓存清空后重算）===');
    console.log(await evaluate(`(() => {
      pinyinCache.clear();
      const names = ['勾指起誓', '少女レイ', '蝴蝶'];
      const out = names.map(n => {
        const song = state.allSongs.find(s => (s.display_song_name||s.song_name||'') === n);
        if (!song) return { name: n, missing: true };
        const pi = getSongPinyin(song);
        return { name: n, full: pi.full, initials: pi.initials };
      });
      return JSON.stringify(out, null, 1);
    })()`));

    console.log('\n=== 逐字追踪：输入 "gouzhuiqishi" ===');
    await evaluate(`(() => { pinyinCache.clear(); const i=document.getElementById('searchInput'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    await sleep(300);
    let typed = '';
    for (const ch of 'gouzhuiqishi') {
      typed += ch;
      const n = await evaluate(`(() => {
        const i=document.getElementById('searchInput');
        i.value = ${JSON.stringify(typed)}; i.dispatchEvent(new Event('input',{bubbles:true}));
        return document.querySelectorAll('.song-item').length;
      })()`);
      console.log(`  "${typed}" → ${n} 首`);
      await sleep(60);
    }

    console.log('\n=== 逐字追踪：输入 "gouzhiqishi"（正确全拼）===');
    await evaluate(`(() => { pinyinCache.clear(); const i=document.getElementById('searchInput'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    await sleep(300);
    typed = '';
    for (const ch of 'gouzhiqishi') {
      typed += ch;
      const n = await evaluate(`(() => {
        const i=document.getElementById('searchInput');
        i.value = ${JSON.stringify(typed)}; i.dispatchEvent(new Event('input',{bubbles:true}));
        return document.querySelectorAll('.song-item').length;
      })()`);
      console.log(`  "${typed}" → ${n} 首`);
      await sleep(60);
    }

    console.log('\n=== 逐字追踪：输入 "shaonvlei" ===');
    await evaluate(`(() => { pinyinCache.clear(); const i=document.getElementById('searchInput'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    await sleep(300);
    typed = '';
    for (const ch of 'shaonvlei') {
      typed += ch;
      const n = await evaluate(`(() => {
        const i=document.getElementById('searchInput');
        i.value = ${JSON.stringify(typed)}; i.dispatchEvent(new Event('input',{bubbles:true}));
        return document.querySelectorAll('.song-item').length;
      })()`);
      console.log(`  "${typed}" → ${n} 首`);
      await sleep(60);
    }

    console.log('\n=== 直接对比 includes 判定 ===');
    console.log(await evaluate(`(() => {
      pinyinCache.clear();
      const song = state.allSongs.find(s => (s.display_song_name||s.song_name||'') === '少女レイ');
      const pi = getSongPinyin(song);
      const q = 'shaonvlei';
      return JSON.stringify({
        full: pi.full,
        fullIncludes: pi.full.includes(q),
        initials: pi.initials,
        initialsIncludes: pi.initials.includes(q)
      }, null, 1);
    })()`));
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    child.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})().catch(error => {
  console.error('追踪失败:', error.message);
  child.kill();
  process.exitCode = 1;
});
