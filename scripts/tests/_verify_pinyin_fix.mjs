// 拼音检索修复验证（开发用，不参与部署）：
// 关键是「冷启动」——不预热 pinyin-pro，直接开始输入，看库加载完成前后结果是否都能出。
// 用法（先起预览服务器）：
//   node scripts/tests/_rating_preview_server.mjs
//   node scripts/tests/_verify_pinyin_fix.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
const BASE = process.env.PREVIEW_BASE || 'http://127.0.0.1:8099';
const PORT = Number(process.env.CDP_PORT || 9422);
const profile = path.join(os.tmpdir(), `xsl-pyfix-${Date.now()}`);
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (实际 ${actual} / 期望 ${expected})`);
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

    const count = () => evaluate(`document.querySelectorAll('.song-item').length`);
    const resetSearch = () => evaluate(`(() => {
      try { pinyinCache.clear(); } catch (e) {}
      const i = document.getElementById('searchInput');
      i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    async function typeSlowly(text, perCharMs = 60) {
      for (const ch of text) {
        await evaluate(`(() => {
          const i = document.getElementById('searchInput');
          i.value = i.value + ${JSON.stringify(ch)};
          i.dispatchEvent(new Event('input', { bubbles: true }));
          return i.value;
        })()`);
        await sleep(perCharMs);
      }
    }

    console.log('=== 场景 A：冷启动（库未加载）直接输入正确全拼 "gouzhiqishi" ===');
    console.log('  输入前 pinyinPro:', await evaluate(`typeof window.pinyinPro`));
    await resetSearch();
    await sleep(300);
    await typeSlowly('gouzhiqishi');
    await sleep(1200);
    console.log('  输入后 pinyinPro:', await evaluate(`typeof window.pinyinPro`));
    check('冷启动还能搜到「勾指起誓」', await count(), 1);

    console.log('\n=== 场景 B：清缓存后不重新预热，再搜首字母 "gzqs" ===');
    await resetSearch();
    await sleep(300);
    await typeSlowly('gzqs');
    await sleep(800);
    check('首字母检索仍可用', await count(), 1);

    console.log('\n=== 场景 C：库就绪后搜正确全拼 "hudie"（蝴蝶）===');
    await resetSearch();
    await sleep(300);
    await typeSlowly('hudie');
    await sleep(800);
    const hudie = await count();
    console.log(`  "hudie" → ${hudie} 首`);
    if (hudie < 1) { console.log('FAIL  全拼检索应至少命中 1 首'); failed += 1; } else { console.log('PASS  全拼检索命中'); }

    console.log('\n=== 场景 D：假名噪声不再干扰（"shaonv" 应命中少女レイ）===');
    await resetSearch();
    await sleep(300);
    await typeSlowly('shaonv');
    await sleep(800);
    const shaonv = await count();
    console.log(`  "shaonv" → ${shaonv} 首`);
    if (shaonv < 1) { console.log('FAIL  "shaonv" 应命中含「少女レイ」的歌曲'); failed += 1; } else { console.log('PASS  去噪后能命中'); }

    console.log('\n=== 场景 E：缓存不应再存空值 ===');
    await resetSearch();
    await sleep(200);
    await evaluate(`(() => { try { pinyinCache.clear(); } catch(e){} window.pinyinPro = undefined; delete window.pinyinPro; return true; })()`);
    await typeSlowly('gou', 60);
    await sleep(200);
    const cacheState = JSON.parse(await evaluate(`JSON.stringify({
      size: pinyinCache.size,
      empty: Array.from(pinyinCache.values()).filter(v => !v.full).length
    })`));
    console.log('  库不可用时的缓存:', JSON.stringify(cacheState));
    check('库不可用时不应写入任何缓存条目', cacheState.size, 0);

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
