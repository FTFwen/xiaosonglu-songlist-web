// 「按评分排序」端到端验证（开发用，不参与部署）：
// 用无头浏览器真的打开本地预览服务器上的页面，给几首歌打分，切到「评分」排序，
// 检查卡片顺序，以及页面发出的评分 API 请求次数。
//
// 用法（先起预览服务器）：
//   node scripts/tests/_rating_preview_server.mjs
//   node scripts/tests/_e2e_rating_sort.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
if (!EDGE) throw new Error('找不到 msedge.exe');

const BASE = process.env.PREVIEW_BASE || 'http://127.0.0.1:8099';
const PORT = Number(process.env.CDP_PORT || 9355);
const profile = path.join(os.tmpdir(), `xsl-sort-probe-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

let ws = null;
const logs = [];
const requests = [];

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', () => reject(new Error('WS 连接失败')));
  });
}

(async () => {
  try {
    const deadline = Date.now() + 25000;
    let target = null;
    while (Date.now() < deadline && !target) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find(t => t.type === 'page');
      } catch { /* 还没起来 */ }
      if (!target) await sleep(300);
    }
    if (!target) throw new Error('CDP 未就绪');

    ws = await connect(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
      if (msg.method === 'Runtime.consoleAPICalled') {
        logs.push(`[${msg.params.type}] ` + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        logs.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description || ''));
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const url = msg.params.request.url;
        if (url.includes('/api/rating/')) requests.push(`${msg.params.request.method} ${url.replace(BASE, '')}`);
      }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const msgId = ++id;
      // 每个 CDP 调用都加超时：网页里某个 fetch 卡住时不能让整个脚本挂死
      const timer = setTimeout(() => {
        pending.delete(msgId);
        reject(new Error(`CDP 调用超时: ${method}`));
      }, 20000);
      pending.set(msgId, msg => { clearTimeout(timer); resolve(msg); });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
    const evaluate = async expression => {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400));
      return res.result?.result?.value;
    };

    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(6000); // 等歌单与评分脚本就绪

    const ready = await evaluate(`JSON.stringify({
      songs: document.querySelectorAll('.song-item').length,
      withKey: document.querySelectorAll('.song-item[data-rating-key]').length,
      hasApi: !!(window.__XSL_RATING && window.__XSL_RATING.loadAll),
      hasSortOption: !!document.querySelector('#sortFieldSelect option[value="rating"]'),
      firstNames: Array.from(document.querySelectorAll('.song-item .song-name-text')).slice(0,3).map(n=>n.textContent)
    })`);
    console.log('=== 页面就绪检查 ===');
    console.log(ready);

    // 给几首歌打分：先拿到几个 key
    const keys = JSON.parse(await evaluate(`JSON.stringify(
      Array.from(document.querySelectorAll('.song-item[data-rating-key]')).slice(0,3).map(el => el.dataset.ratingKey)
    )`));
    console.log('打分目标:', keys.join(' / '));
    const scores = [2, 10, 6];
    for (let i = 0; i < keys.length; i += 1) {
      const body = JSON.stringify({ key: keys[i], score: scores[i] });
      const put = await evaluate(`fetch('/api/rating/song', { method:'PUT', headers:{'Content-Type':'application/json'}, body: ${JSON.stringify(body)} }).then(r=>r.status)`);
      console.log(`  打分 ${keys[i]} = ${scores[i]} → HTTP ${put}`);
      await sleep(1400); // 避开服务端 1 秒/IP 的写入节流，否则会吃 429
    }

    // 切到「评分」排序
    requests.length = 0;
    const switched = await evaluate(`(() => {
      const sel = document.getElementById('sortFieldSelect');
      sel.value = 'rating';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);
    console.log('\n排序方式已切换为:', switched);
    await sleep(6000); // 等批量拉取 + 重排

    const result = await evaluate(`JSON.stringify({
      sortField: (document.getElementById('sortFieldSelect')||{}).value,
      order: Array.from(document.querySelectorAll('.song-item .song-name-text')).slice(0,6).map(n=>n.textContent),
      cachedRatings: Object.keys((window.__XSL_RATING && window.__XSL_RATING.entries) ? Object.fromEntries(window.__XSL_RATING.entries) : {}).length
    })`);
    const parsed = JSON.parse(result);
    console.log('\n=== 排序结果 ===');
    console.log('前 6 首:', parsed.order.join(' | '));
    console.log('评分条目数:', parsed.cachedRatings);

    console.log('\n=== 排序期间发出的评分请求 ===');
    console.log(requests.length ? requests.join('\n') : '(无)');

    console.log('\n=== console ===');
    console.log(logs.length ? logs.slice(0, 20).join('\n') : '(无输出)');

    // 断言：最高分那首歌应排第一
    const topScored = keys[scores.indexOf(Math.max(...scores))];
    const ok = parsed.order[0] === topScored;
    console.log(`\n${ok ? 'PASS' : 'FAIL'}  最高分「${topScored}」应排第一，实际第一是「${parsed.order[0]}」`);
    if (!ok) process.exitCode = 1;

    // 再切回升序确认不抛错
    const asc = await evaluate(`(() => {
      const dir = document.getElementById('sortDirSelect');
      dir.value = 'asc';
      dir.dispatchEvent(new Event('change', { bubbles: true }));
      return dir.value;
    })()`);
    await sleep(4000);
    const ascOrder = JSON.parse(await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.song-item .song-name-text')).slice(0,6).map(n=>n.textContent))`));
    console.log(`升序（${asc}）前 6 首:`, ascOrder.join(' | '));
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    child.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})().catch(error => {
  console.error('E2E 失败:', error.message);
  child.kill();
  process.exitCode = 1;
});
