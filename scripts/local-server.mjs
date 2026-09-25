// Run the page on your own machine before deploying, with no AWS account needed.
// Serves frontend/ and the same /api endpoints as the Lambda, keeping data in
// local-data.json (created from seed/data.json on first run).
// Usage: node scripts/local-server.mjs [port]     then open http://localhost:8080
// Optional: PLAN_PASSCODE=secret node scripts/local-server.mjs
import http from 'node:http';
import { readFile, writeFile, access } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] || 8080);
const dbFile = join(root, 'local-data.json');
const PASS = process.env.PLAN_PASSCODE || '';
const COLS = ['config', 'projects', 'people', 'resources'];

let db;
try { await access(dbFile); db = JSON.parse(await readFile(dbFile, 'utf8')); }
catch { db = { version: 0, data: JSON.parse(await readFile(join(root, 'seed/data.json'), 'utf8')) }; }
for (const c of COLS) db.data[c] ??= {};
const save = () => writeFile(dbFile, JSON.stringify(db));

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    if (PASS && req.headers['x-plan-passcode'] !== PASS) return send(res, 401, { error: 'Passcode required' });
    if (req.method === 'GET' && url.pathname === '/api/version') return send(res, 200, { version: db.version });
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const collections = Object.fromEntries(COLS.map(c => [c, Object.entries(db.data[c]).map(([id, data]) => ({ id, data }))]));
      return send(res, 200, { version: db.version, collections });
    }
    const m = /^\/api\/docs\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (m && COLS.includes(decodeURIComponent(m[1]))) {
      const col = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]);
      if (req.method === 'PUT') {
        let body = ''; for await (const ch of req) body += ch;
        try { db.data[col][id] = JSON.parse(body); } catch { return send(res, 400, { error: 'Body must be JSON' }); }
      } else if (req.method === 'DELETE') delete db.data[col][id];
      else return send(res, 405, { error: 'Method not allowed' });
      db.version++; await save(); return send(res, 200, { version: db.version });
    }
    return send(res, 404, { error: 'Not found' });
  }
  const file = normalize(join(root, 'frontend', url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(join(root, 'frontend'))) { res.writeHead(403); return res.end(); }
  try { const buf = await readFile(file); res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); res.end(buf); }
  catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, () => console.log(`Resource plan running at http://localhost:${port}`));
