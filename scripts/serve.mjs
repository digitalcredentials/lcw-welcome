// Serves dist/ locally the way most static hosts do: a folder serves its index.html, and
// /feedback redirects to /feedback/. Used by `npm start` and the tests. Not for production.
// BASE=/some-folder/ serves the site in a folder instead of at the root, as GitHub Pages does.
// PORT=0 picks any free port; the address printed on start says which.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = join(process.cwd(), 'dist');
const port = process.env.PORT ? Number(process.env.PORT) : 4317;
const base = ('/' + (process.env.BASE || '') + '/').replace(/\/+/g, '/');   // always /…/, however it's written
const types = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' };

createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400).end(); return; }
  if (url.pathname + '/' === base) { res.writeHead(301, { Location: base + url.search }).end(); return; }
  if (!url.pathname.startsWith(base)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
  let path;
  try { path = normalize('/' + decodeURIComponent(url.pathname.slice(base.length))); } catch { res.writeHead(400).end(); return; }
  let file = join(root, path);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    if ((await stat(file)).isDirectory()) {
      if (!path.endsWith('/')) { res.writeHead(301, { Location: base.slice(0, -1) + path + '/' + url.search }).end(); return; }
      file = join(file, 'index.html');
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, function () { console.log(`http://localhost:${this.address().port}`); });
