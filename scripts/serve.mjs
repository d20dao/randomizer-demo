// Minimal static server for frontend/ (browser wallets do not inject into file:// pages).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORKS, rpcUrlFor } from './network.mjs';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
const port = Number(process.env.PORT || 5173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

const RPC = Object.fromEntries(Object.values(NETWORKS).map((n) => [String(n.chainId), rpcUrlFor(n)]));

createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relay = pathname.match(/^\/rpc\/(\d+)$/);
  if (relay) {
    // Same read-only relay path as worker/index.js, for browsers that block *.arc.io.
    if (req.method !== 'POST' || !RPC[relay[1]]) { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const upstream = await fetch(RPC[relay[1]], { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
    } catch { res.writeHead(502).end(); }
    return;
  }
  const file = normalize(resolve(dir, '.' + (pathname === '/' ? '/index.html' : pathname)));
  if (file !== dir && !file.startsWith(dir + sep)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Randomizer demo on http://localhost:${port}`));
