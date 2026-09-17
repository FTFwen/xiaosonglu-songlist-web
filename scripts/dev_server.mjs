import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3000;
const ROOT = path.resolve(process.cwd());

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.zip': 'application/zip'
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath.endsWith('/')) {
    reqPath += 'index.html';
  }

  let filePath = path.join(ROOT, reqPath);

  // 安全防止目录穿越
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err) {
      const tryIndex = path.join(filePath, 'index.html');
      if (fs.existsSync(tryIndex)) {
        filePath = tryIndex;
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
    } else if (stats.isDirectory()) {
      const indexPath = path.join(filePath, 'index.html');
      if (fs.existsSync(indexPath)) {
        filePath = indexPath;
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
    } else if (!stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

function listen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[提示] 端口 ${port} 被占用，正在尝试 ${port + 1}...`);
      listen(port + 1);
    } else {
      console.error('[错误] 启动失败:', err);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log('====================================================');
    console.log(`  小松绿歌单网站 · 本地开发预览服务已启动！`);
    console.log(`  服务基地址: http://localhost:${port}/`);
    console.log(`  1. 主站歌单:   http://localhost:${port}/`);
    console.log(`  2. 按钮墙:     http://localhost:${port}/buttons/`);
    console.log(`  3. 个人工作台: http://localhost:${port}/workshop/`);
    console.log(`  4. 24点小游戏: http://localhost:${port}/24xsl/`);
    console.log(`  5. 歌曲计算器: http://localhost:${port}/calc/`);
    console.log('  按 Ctrl + C 可关闭服务');
    console.log('====================================================');
  });
}

listen(PORT);
