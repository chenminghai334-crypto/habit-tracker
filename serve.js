/* serve.js — 零依赖本地静态服务器
 * 用法：node serve.js   （或双击「启动.cmd」）
 * 可选环境变量 PORT（默认 8080）
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ics': 'text/calendar; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extra });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const target = resolve(join(ROOT, pathname));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      send(res, 403, '403 拒绝访问');
      return;
    }

    let info = await stat(target).catch(() => null);
    let file = target;
    if (info?.isDirectory()) {
      file = join(target, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
      send(res, 404, '404 找不到这个文件');
      return;
    }

    const body = await readFile(file);
    send(res, 200, body, MIME[extname(file).toLowerCase()] || 'application/octet-stream');
  } catch (err) {
    send(res, 500, `500 服务器错误：${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  习惯打卡 服务已启动');
  console.log(`  本机地址：   http://localhost:${PORT}/`);
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) {
        console.log(`  局域网地址： http://${item.address}:${PORT}/`);
      }
    }
  }
  console.log('');
  console.log('  提示：本机地址可以正常用提醒；局域网地址只能看界面，');
  console.log('        浏览器不允许非 https 网页发通知。手机上请用部署后的网址。');
  console.log('  按 Ctrl + C 停止服务。');
  console.log('');
});
