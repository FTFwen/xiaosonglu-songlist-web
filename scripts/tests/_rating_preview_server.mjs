// 本地验证服务器（开发用，不参与部署）：
//   /api/rating/song  → 用内存 R2 直接调用真实 handler，验证前后端真实联通
//   其余路径          → 映射到仓库静态文件（相当于 file:// 但带 API）
//
// 用法：node scripts/tests/_rating_preview_server.mjs  然后打开 http://127.0.0.1:8099/
// 可选：DIAG_SCRIPT=__diag_client.js 会把 scripts/tests 下的同名脚本注入 index.html 末尾。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequestGet, onRequestPut } from '../../functions/api/rating/song.js';
import { createTestBucket } from './_test-r2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 8099);
const bucket = createTestBucket();
const env = { xsl_buttons: bucket, RATING_IP_SALT: 'local-verify' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.m4a': 'audio/mp4',
};

async function handleRating(request, response, url) {
  // 本地验证时给每个请求一个稳定但可切换的访客 IP（?ip= 覆盖）。
  const ip = url.searchParams.get('ip') || '203.0.113.7';
  const headers = new Headers(request.headers);
  headers.set('CF-Connecting-IP', ip);
  const rawBody = ['GET', 'HEAD'].includes(request.method) ? '' : String(await readBody(request));
  const proxied = new Request(url.toString(), {
    method: request.method,
    headers,
    body: rawBody ? Buffer.from(rawBody) : undefined,
    duplex: 'half',
  });
  const context = { request: proxied, env, params: {} };
  const result = request.method === 'PUT' ? await onRequestPut(context) : await onRequestGet(context);
  const text = await result.text();
  if (process.env.LOG_REQUESTS && request.method === 'PUT') {
    console.log(`[put] status=${result.status} body=${rawBody.slice(0, 200)} => ${text.slice(0, 160)}`);
  }
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
    if (process.env.LOG_REQUESTS) console.log(`[req] ${request.method} ${url.pathname}`);
    if (url.pathname === '/api/rating/song') return await handleRating(request, response, url);
    if (url.pathname === '/__rating-store') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({
        keys: bucket.keys(),
        shards: bucket.keys().map(key => ({ key, body: bucket.body(key) })),
        counters: bucket.counters,
      }, null, 2));
    }
    if (url.pathname === '/__diag-log') {
      const text = request.method === 'POST' ? String(await readBody(request)) : '{}';
      console.log('==== 页面诊断结果 ====');
      console.log(text);
      response.writeHead(204);
      return response.end();
    }

    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (process.env.LOG_REQUESTS) console.log(`[rel] ${JSON.stringify(relative)}`);
    const diagName = /^_+(diag_[a-z0-9_]+\.js)$/.exec(relative);
    if (diagName) {
      const diag = path.resolve(ROOT, 'scripts', 'tests', `_${diagName[1]}`);
      const source = fs.readFileSync(diag, 'utf8').replace(/^\uFEFF/, '');
      const buffer = Buffer.from(source, 'utf8');
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': buffer.length, 'cache-control': 'no-store' });
      return response.end(buffer);
    }
    const target = path.resolve(ROOT, relative);
    if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return response.end('not found');
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    if (relative === 'index.html') {
      // 可选：在 scripts/tests/ 下放同名 diag 脚本即可自动注入，用于页内自检（日常不需要）。
      const diagFile = process.env.DIAG_SCRIPT || '';
      let html = fs.readFileSync(target, 'utf8');
      if (diagFile) {
        html = html.replace('</body>', `<script src="/${diagFile}?t=${Date.now()}"></script></body>`);
      }
      // 开发模式：把 ?v=N 全部重写成时间戳，避免验证时反复命中浏览器缓存。
      if (process.env.FRESH_ASSETS) {
        const stamp = Date.now();
        html = html.replace(/\?v=[0-9]+/g, `?v=${stamp}`);
      }
      const buffer = Buffer.from(html, 'utf8');
      response.writeHead(200, {
        'content-type': type,
        'content-length': buffer.length,
        'cache-control': 'no-store, no-cache, must-revalidate',
        pragma: 'no-cache',
        expires: '0',
      });
      return response.end(buffer);
    }
    const stat = fs.statSync(target);
    const headers = { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' };
    if (request.method === 'HEAD') { response.writeHead(200, headers); return response.end(); }
    response.writeHead(200, headers);
    fs.createReadStream(target).pipe(response);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(String(error && error.stack || error));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`rating verify server: http://127.0.0.1:${PORT}/ (root=${ROOT})`);
});
