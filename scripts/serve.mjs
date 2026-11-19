// Serves dist/ locally the way most static hosts do: a folder serves its index.html, and
// /feedback redirects to /feedback/. Used by `npm start` and the tests. Not for production.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = join(process.cwd(), 'dist');
const port = Number(process.env.PORT) || 4317;
const types = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path;
  try { path = normalize(decodeURIComponent(url.pathname)); } catch { res.writeHead(400).end(); return; }
  let file = join(root, path);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    if ((await stat(file)).isDirectory()) {
      if (!path.endsWith('/')) { res.writeHead(301, { Location: path + '/' + url.search }).end(); return; }
      file = join(file, 'index.html');
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => console.log(`http://localhost:${port}`));
