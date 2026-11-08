/* 仅用于本地预览：静态文件 + 把 /api 转发给 wrangler dev (127.0.0.1:8787) */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PREVIEW_PORT || 8790);
const API = 'http://127.0.0.1:8787';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (['host', 'content-length', 'connection', 'accept-encoding'].includes(k)) continue;
        headers[k] = v;
      }
      const upstream = await fetch(API + url.pathname + url.search, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
      });
      res.statusCode = upstream.status;
      upstream.headers.forEach((value, key) => {
        if (['content-encoding', 'transfer-encoding', 'connection'].includes(key)) return;
        res.setHeader(key, value);
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'proxy_unavailable' }));
    }
    return;
  }

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^([/\\])+/, '');
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) { res.statusCode = 403; res.end('forbidden'); return; }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  res.setHeader('Content-Type', TYPES[path.extname(full)] || 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('preview on http://127.0.0.1:' + PORT);
});
