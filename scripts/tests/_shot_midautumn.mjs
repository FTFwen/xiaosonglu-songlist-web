// 中秋皮肤截图（开发用，不参与部署）：在桌面视口下打开线上站点并截图。
// 用法：node scripts/tests/_shot_midautumn.mjs [url] [outfile]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
const URL_ = process.argv[2] || 'https://viridis.love/';
const OUT = process.argv[3] || path.resolve('_shot_midautumn.png');
const PORT = 9466;
const profile = path.join(os.tmpdir(), `xsl-shot-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1',
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
      return r.result?.result?.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: URL_ });
    await sleep(2500);
    // 强制开启皮肤，保证截图能看到效果（线上的自动窗口要等农历八月十三）
    await evaluate(`localStorage.setItem('xsl_festival_skin_pref','midautumn')`);
    await send('Page.navigate', { url: URL_ });
    await sleep(6000);
    const state = await evaluate(`JSON.stringify({
      dataSkin: document.documentElement.getAttribute('data-skin'),
      backdrop: !!document.querySelector('.midautumn-bg-backdrop'),
      moon: !!document.querySelector('.midautumn-celestial-moon')
    })`);
    console.log('页面状态:', state);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
    console.log('已保存截图:', OUT, fs.statSync(OUT).size, 'bytes');
    await evaluate(`localStorage.removeItem('xsl_festival_skin_pref')`);
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    child.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})().catch(e => { console.error('截图失败:', e.message); child.kill(); process.exitCode = 1; });
