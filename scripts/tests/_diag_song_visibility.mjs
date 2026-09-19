// 歌曲显示数诊断（开发用，不参与部署）：
// 打开页面，报告歌单实际渲染了多少张卡片、筛选条件是什么，并和 song_catalog 总数对比。
// 用来区分「数据丢了」和「被筛选/开关隐藏了」。
// 用法：node scripts/tests/_diag_song_visibility.mjs [url]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
const URL_ = process.argv[2] || 'https://viridis.love/';
const PORT = Number(process.env.CDP_PORT || 9477);
const profile = path.join(os.tmpdir(), `xsl-vis-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=1440,1000', 'about:blank',
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
      const t = setTimeout(() => { pending.delete(msgId); reject(new Error('CDP 超时 ' + method)); }, 40000);
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
    await send('Page.navigate', { url: URL_ });
    await sleep(7000);

    console.log('=== 页面渲染情况 ===');
    console.log(await evaluate(`JSON.stringify({
      cards: document.querySelectorAll('.song-item').length,
      metaText: (document.getElementById('songMetaText')||{}).textContent,
      searchInput: (document.getElementById('searchInput')||{}).value,
      favoritesOnly: !!(document.getElementById('favoritesOnlyBtn')||{}).classList && document.getElementById('favoritesOnlyBtn').classList.contains('active')
    }, null, 1)`));

    console.log('\n=== state 里的数量（若可读） ===');
    console.log(await evaluate(`(function(){
      try {
        if (typeof state === 'undefined') return 'state 不可读（模块作用域）';
        return JSON.stringify({
          allSongs: state.allSongs ? state.allSongs.length : null,
          filteredSongs: state.filteredSongs ? state.filteredSongs.length : null,
          derivativeSongs: state.derivativeSongs ? state.derivativeSongs.length : null,
          songFilters: state.songFilters,
          favoritesOnly: state.favoritesOnly
        }, null, 1);
      } catch (e) { return 'ERR: ' + e.message; }
    })()`));

    console.log('\n=== 歌单数据里实际有多少首（页面已加载的 data.js） ===');
    console.log(await evaluate(`(function(){
      try {
        if (window.XSL_DATA && window.XSL_DATA.songCatalog) return 'XSL_DATA.songCatalog.songs: ' + window.XSL_DATA.songCatalog.songs.length;
        return '未暴露在 window 上，改用 DOM 推断';
      } catch (e) { return 'ERR: ' + e.message; }
    })()`));

    console.log('\n=== 卡片前 8 首 vs 数据前 8 首 ===');
    console.log('页面卡片:', await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.song-item .song-name-text')).slice(0,8).map(n=>n.textContent))`));
    const cat = JSON.parse(await evaluate(`fetch('/data/xiaosonglu/song_catalog.json',{cache:'no-store'}).then(r=>r.json()).then(j=>JSON.stringify(j.songs.slice(0,8).map(s=>s.display_song_name||s.song_name)))`));
    console.log('数据前 8:', JSON.stringify(cat));

    console.log('\n=== 数据总数 ===');
    console.log(await evaluate(`fetch('/data/xiaosonglu/song_catalog.json',{cache:'no-store'}).then(r=>r.json()).then(j=>'song_catalog.json 共 ' + j.songs.length + ' 首，generatedAt=' + j.generatedAt)`));
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    child.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})().catch(e => { console.error('诊断失败:', e.message); child.kill(); process.exitCode = 1; });
