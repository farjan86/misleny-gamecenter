// TANK MISLENY játékszerver: kiszolgálja a játék oldalát (a dist/ mappát), és
// WebSocketen (/ws) futtatja a szobalistát meg a meccseket.
//
// Indítás a projekt gyökeréből:  npm run server
// Beállítások (környezeti változók):
//   PORT      – a figyelt port (alapértelmezés: 8787)
//   HOST      – a figyelt cím (alapértelmezés: 0.0.0.0, azaz minden hálózati csatoló)
//   MAP_FILE  – a pályafájl (alapértelmezés: assets/maps/processed/misleny-kozpont.json)
//   WEB_ROOT  – a kiszolgált oldal mappája (alapértelmezés: dist)
//   ACCOUNTS_FILE – a játékosfiókok fájlja (alapértelmezés: data/accounts.json)

import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { WebSocketServer, type WebSocket } from 'ws';
import type { MapData } from '../src/game/maps/types';
import { Accounts } from './accounts';
import { Gate } from './gate';
import { Lobby } from './lobby';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = process.cwd();
const MAP_FILE = path.resolve(ROOT, process.env.MAP_FILE || 'assets/maps/processed/misleny-kozpont.json');
const WEB_ROOT = path.resolve(ROOT, process.env.WEB_ROOT || 'dist');
const ACCOUNTS_FILE = path.resolve(ROOT, process.env.ACCOUNTS_FILE || 'data/accounts.json');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const mapData = JSON.parse(readFileSync(MAP_FILE, 'utf8')) as MapData;
const lobby = new Lobby(mapData);
const accounts = new Accounts(ACCOUNTS_FILE);
const gate = new Gate(lobby, accounts);

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ...lobby.stats, accounts: accounts.count }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  // csak a kiszolgált mappán belüli fájl adható ki
  const wanted = path.normalize(path.join(WEB_ROOT, decodeURIComponent(url.pathname)));
  let file = wanted.startsWith(WEB_ROOT) ? wanted : WEB_ROOT;
  try {
    if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const body = readFileSync(file);
    const hashed = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      // a Vite a fájlnévbe írja a tartalom ujjlenyomatát: ezek sokáig tárolhatók, az index.html nem
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Nincs ilyen fájl. (Ha a játék oldala hiányzik, futtasd előbb: npm run build)');
  }
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (socket: WebSocket) => {
  const session = gate.connect({
    send: (text) => {
      if (socket.readyState === socket.OPEN) socket.send(text);
    },
    close: () => socket.close(),
  });
  socket.on('message', (data) => session.message(String(data)));
  socket.on('close', () => session.close());
  socket.on('error', () => socket.close());
});

// A meccsek léptetése. Az időzítő pontossága (Windows alatt kb. 15 ms) nem számít:
// a szimuláció a ténylegesen eltelt idő szerint, rögzített lépésekben halad.
setInterval(() => lobby.tick(performance.now()), 4);

http.listen(PORT, HOST, () => {
  console.log(`TANK MISLENY szerver fut: http://localhost:${PORT}/`);
  console.log(`  pálya: ${path.relative(ROOT, MAP_FILE)} (${mapData.meta.width} × ${mapData.meta.height} m)`);
  console.log(`  oldal: ${path.relative(ROOT, WEB_ROOT) || '.'}   állapot: http://localhost:${PORT}/status`);
  console.log(`  fiókok: ${path.relative(ROOT, ACCOUNTS_FILE)} (${accounts.count} regisztrált játékos)`);
});
