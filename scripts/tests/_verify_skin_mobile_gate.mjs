// 中秋皮肤「手机端屏蔽」实测（开发用，不参与部署）：
// 用无头浏览器分别在手机视口与桌面视口打开页面，检查：
//   - 手机端：首屏不应带 data-skin，不应出现皮肤元素与任何切换按钮
//   - 桌面端：仍然正常启用（data-skin 与背景元素都在，桌面按钮可见）
// 用法（先起 dev_server）：
//   node scripts/dev_server.mjs
//   node scripts/tests/_verify_skin_mobile_gate.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
if (!EDGE) throw new Error('找不到 msedge.exe');

const BASE = process.env.PREVIEW_BASE || 'http://127.0.0.1:3000';
const PORT = Number(process.env.CDP_PORT || 9444);
const profile = path.join(os.tmpdir(), `xsl-skin-gate-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

let ws = null;
let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)})`);
  if (!ok) failed += 1;
}

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
    if (!target) throw new Error('CDP 未就绪');

    ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', () => reject(new Error('WS 失败')));
    });
    let id = 0;
    const pending = new Map();
    const exceptions = [];
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
      if (msg.method === 'Runtime.exceptionThrown') {
        exceptions.push((msg.params.exceptionDetails?.exception?.description || '').slice(0, 160));
      }
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
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });

    const probe = `JSON.stringify({
      innerWidth: window.innerWidth,
      dataSkin: document.documentElement.getAttribute('data-skin'),
      midautumnFlag: document.documentElement.getAttribute('data-midautumn-skin'),
      backdrop: !!document.querySelector('.midautumn-bg-backdrop'),
      starfield: !!document.querySelector('.midautumn-starfield'),
      desktopBtn: !!document.getElementById('festivalSkinBtn'),
      mobileBtn: !!document.getElementById('mobileFestivalSkinBtn')
    })`;

    async function visit(url, label) {
      await send('Page.navigate', { url });
      await sleep(5000);
      return JSON.parse(await evaluate(probe));
    }

    console.log('=== A. 手机视口 390px：歌单页 ===');
    let s = await visit(`${BASE}/`, 'mobile');
    console.log('  ' + JSON.stringify(s));
    check('手机端首屏未带 data-skin', s.dataSkin, null);
    check('手机端未设皮肤标记', s.midautumnFlag, null);
    check('手机端无皮肤背景层', s.backdrop, false);
    check('手机端无星空层', s.starfield, false);
    check('手机端无手机入口按钮', s.mobileBtn, false);

    console.log('\n=== B. 手机视口 390px：按钮墙 ===');
    s = await visit(`${BASE}/buttons/`, 'mobile-buttons');
    console.log('  ' + JSON.stringify(s));
    check('按钮墙手机端未带 data-skin', s.dataSkin, null);
    check('按钮墙手机端无皮肤背景层', s.backdrop, false);
    check('按钮墙手机端无手机入口按钮', s.mobileBtn, false);

    console.log('\n=== C. 手动把偏好设为 midautumn 后，手机端仍不应启用 ===');
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(1500);
    await evaluate(`localStorage.setItem('xsl_festival_skin_pref', 'midautumn')`);
    s = await visit(`${BASE}/`, 'mobile-forced');
    console.log('  ' + JSON.stringify(s));
    check('强制偏好下手机端仍未带 data-skin', s.dataSkin, null);
    check('强制偏好下手机端无皮肤背景层', s.backdrop, false);
    await evaluate(`localStorage.removeItem('xsl_festival_skin_pref')`);

    console.log('\n=== D. 桌面视口 1280px：皮肤应正常启用（确认没误伤桌面端）===');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await evaluate(`localStorage.setItem('xsl_festival_skin_pref', 'midautumn')`);
    s = await visit(`${BASE}/`, 'desktop');
    console.log('  ' + JSON.stringify(s));
    check('桌面端已带 data-skin', s.dataSkin, 'midautumn');
    check('桌面端有皮肤背景层', s.backdrop, true);
    check('桌面端有桌面入口按钮', s.desktopBtn, true);
    await evaluate(`localStorage.removeItem('xsl_festival_skin_pref')`);

    console.log('\n=== 页面异常 ===');
    console.log(exceptions.length ? exceptions.slice(0, 8).join('\n') : '(无)');

    console.log(`\n结论：${failed ? failed + ' 项未通过' : '全部通过'}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    child.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})().catch(error => {
  console.error('验证失败:', error.message);
  child.kill();
  process.exitCode = 1;
});
