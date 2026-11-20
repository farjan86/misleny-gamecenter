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
//   STATS_FILE – a játéknapló: ki mikor és mennyit játszott (alapértelmezés: logs/statisztika.txt)
//   ADMINS_FILE – a szerver gazdáinak fiókneve soronként; ők nyithatnak nyitott játékot (alapértelmezés: data/admins.txt)
//   OPEN_GAMES_FILE – a nyitott játékok mentése, újraindítás után ezek újra megnyílnak (alapértelmezés: data/open-games.json)

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { WebSocketServer, type WebSocket } from 'ws';
import type { MapData } from '../src/game/maps/types';
import { Accounts } from './accounts';
import { Gate } from './gate';
import { VERSION } from '../src/game/version';
import { Lobby, type OpenGameStore } from './lobby';
import { StatsLog } from './stats';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = process.cwd();
const MAP_FILE = path.resolve(ROOT, process.env.MAP_FILE || 'assets/maps/processed/misleny-kozpont.json');
const WEB_ROOT = path.resolve(ROOT, process.env.WEB_ROOT || 'dist');
const ACCOUNTS_FILE = path.resolve(ROOT, process.env.ACCOUNTS_FILE || 'data/accounts.json');
const STATS_FILE = path.resolve(ROOT, process.env.STATS_FILE || 'logs/statisztika.txt');
const ADMINS_FILE = path.resolve(ROOT, process.env.ADMINS_FILE || 'data/admins.txt');

/** A szerver gazdái: soronként egy fióknév (a # utáni rész megjegyzés). Ha nincs ilyen fájl, nincs gazda. */
function readAdmins(file: string): string[] {
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
const ADMINS = readAdmins(ADMINS_FILE);
const OPEN_GAMES_FILE = path.resolve(ROOT, process.env.OPEN_GAMES_FILE || 'data/open-games.json');

/** A nyitott játékok tárolója: JSON-fájl; előbb ideiglenes fájlba ír, aztán átnevezi (megszakadt írás nem rontja el). */
const openGameStore: OpenGameStore = {
  load: () => (existsSync(OPEN_GAMES_FILE) ? JSON.parse(readFileSync(OPEN_GAMES_FILE, 'utf8')) : []),
  save: (games) => {
    mkdirSync(path.dirname(OPEN_GAMES_FILE), { recursive: true });
    const tmp = `${OPEN_GAMES_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(games, null, 1));
    renameSync(tmp, OPEN_GAMES_FILE);
  },
};

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
const lobby = new Lobby(mapData, undefined, ADMINS, openGameStore);
const accounts = new Accounts(ACCOUNTS_FILE);
const gate = new Gate(lobby, accounts, new StatsLog(STATS_FILE));

/** Biztonsági fejlécek minden válaszhoz: idegen oldal nem ágyazhatja be a játékot, és a böngésző nem találgat fájltípust. */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'no-referrer',
  // csak a saját oldal szkriptjei futhatnak, és csak a saját szerverhez kapcsolódhat (ha mégis bekerülne idegen kód, ne tudjon adatot kivinni)
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; media-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'",
  'permissions-policy': 'camera=(), geolocation=(), payment=(), usb=()',
} as const;

/** A kérés küldőjének címe: a Cloudflare-alagúton át a valódi címet a cf-connecting-ip fejléc adja, helyi hálózatról a kapcsolat címe. */
function clientAddress(req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }): string {
  const remote = req.socket.remoteAddress ?? '?';
  // a fejlécet csak a saját gépen futó alagúttól fogadjuk el: a helyi hálózatról jövő kérés nem hamisíthatja
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const header = req.headers['cf-connecting-ip'];
  const value = Array.isArray(header) ? header[0] : header;
  return local && value && value.length < 64 ? value : remote;
}

const http = createServer((req, res) => {
  // egyetlen hibás kérés se állíthassa le a szervert
  try {
    serve(req, res);
  } catch (error) {
    console.error('Hiba egy kérés kiszolgálásakor:', error);
    if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
    res.end();
  }
});

function serve(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  let url: URL;
  let pathname: string;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // hibás kódolású cím (pl. egy magában álló %)
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Hibás cím.');
    return;
  }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ version: VERSION, ...lobby.stats, accounts: accounts.count }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  // csak a kiszolgált mappán belüli fájl adható ki (a mappanév elején egyező szomszéd mappa – pl. dist-server – sem)
  const wanted = path.normalize(path.join(WEB_ROOT, pathname));
  let file = wanted === WEB_ROOT || wanted.startsWith(WEB_ROOT + path.sep) ? wanted : WEB_ROOT;
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
}

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024 });
/** Egy címről legfeljebb ennyi kapcsolat lehet egyszerre (bőkezű: egy LAN-parti vagy iskola is egy címről jön). */
const MAX_PER_ADDRESS = 60;
/** Egy kapcsolat másodpercenként legfeljebb ennyi üzenetet küldhet (a játék kb. 60-at küld); fölötte bontjuk. */
const MAX_MESSAGES_PER_SECOND = 240;
const perAddress = new Map<string, number>();

wss.on('connection', (socket: WebSocket, req) => {
  // idegen weboldal nem kapcsolódhat a játékos böngészőjéből (az Origin a böngésző által küldött, nem hamisítható)
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      host = '';
    }
    if (host !== req.headers.host) {
      socket.close(1008, 'Idegen oldal.');
      return;
    }
  }
  const address = clientAddress(req);
  const open = (perAddress.get(address) ?? 0) + 1;
  if (open > MAX_PER_ADDRESS) {
    socket.close(1008, 'Túl sok kapcsolat erről a címről.');
    return;
  }
  perAddress.set(address, open);
  socket.once('close', () => {
    const left = (perAddress.get(address) ?? 1) - 1;
    if (left > 0) perAddress.set(address, left);
    else perAddress.delete(address);
  });
  const session = gate.connect(
    {
      send: (text) => {
        if (socket.readyState === socket.OPEN) socket.send(text);
      },
      close: () => socket.close(),
    },
    address,
  );
  // elárasztás ellen: aki másodpercenként túl sok üzenetet küld, annak a kapcsolata megszakad
  let second = 0;
  let count = 0;
  socket.on('message', (data) => {
    const now = Math.floor(performance.now() / 1000);
    if (now !== second) {
      second = now;
      count = 0;
    }
    if (++count > MAX_MESSAGES_PER_SECOND) {
      socket.terminate();
      return;
    }
    try {
      session.message(String(data));
    } catch (error) {
      console.error('Hiba egy üzenet feldolgozásakor:', error);
    }
  });
  socket.on('close', () => session.close());
  socket.on('error', () => socket.close());
});

// A meccsek léptetése. Az időzítő pontossága (Windows alatt kb. 15 ms) nem számít:
// a szimuláció a ténylegesen eltelt idő szerint, rögzített lépésekben halad.
setInterval(() => lobby.tick(performance.now()), 4);

// Játéknapló: néhány másodpercenként megnézi, ki van éppen meccsen (ebből lesz a játékidő);
// egy sor akkor kerül a fájlba, amikor valaki elmegy. Leálláskor (Ctrl+C, az ablak bezárása)
// a még bent lévők sora is kiíródik.
let sampledAt = performance.now();
setInterval(() => {
  const now = performance.now();
  gate.sample(Math.min(60, (now - sampledAt) / 1000));
  sampledAt = now;
}, 5000);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    gate.flush();
    process.exit(0);
  });
}

http.listen(PORT, HOST, () => {
  console.log(`TANK MISLENY ${VERSION} – a szerver fut: http://localhost:${PORT}/`);
  console.log(`  pálya: ${path.relative(ROOT, MAP_FILE)} (${mapData.meta.width} × ${mapData.meta.height} m)`);
  console.log(`  oldal: ${path.relative(ROOT, WEB_ROOT) || '.'}   állapot: http://localhost:${PORT}/status`);
  console.log(`  fiókok: ${path.relative(ROOT, ACCOUNTS_FILE)} (${accounts.count} regisztrált játékos)`);
  console.log(`  játéknapló: ${path.relative(ROOT, STATS_FILE)} (ki mikor és mennyit játszott)`);
  const open = lobby.openGames;
  console.log(`  nyitott játékok: ${open.length ? open.join(', ') : 'nincs'} (${path.relative(ROOT, OPEN_GAMES_FILE)})`);
  console.log(`  nyitott játékot nyithat: ${ADMINS.length ? ADMINS.join(', ') : `senki (a fiókneveket a ${path.relative(ROOT, ADMINS_FILE)} fájlba kell írni)`}`);
});
