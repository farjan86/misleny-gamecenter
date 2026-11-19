// Kiegészítő épületalaprajzok letöltése a Microsoft „Global ML Building
// Footprints" nyílt adatbázisából, a pálya területére szűrve.
// Használat: npm run map:buildings
//
// Miért kell: az OpenStreetMapben Kozármisleny déli és keleti részén alig van
// épületkontúr. Ez az adatbázis műholdképekről, gépi felismeréssel készült
// alaprajzokat tartalmaz – valós épületek, de az OSM-nél pontatlanabbak, és
// nincs hozzájuk típus vagy cím. A feldolgozó (process-map.mjs) csak ott
// használja őket, ahol az OSM-ben nincs épület.
//
// Forrás:  https://github.com/microsoft/GlobalMLBuildingFootprints
// Licenc:  Open Data Commons Open Database License (ODbL)
// Kimenet: assets/maps/osm/misleny-kozpont.msbuildings.json (+ .meta.json)

import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const osmDir = path.join(root, 'assets', 'maps', 'osm');
const queryPath = path.join(osmDir, 'misleny-kozpont.overpassql');
const outPath = path.join(osmDir, 'misleny-kozpont.msbuildings.json');
const metaPath = path.join(osmDir, 'misleny-kozpont.msbuildings.meta.json');

const INDEX_URL = 'https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv';
const REGION = 'Hungary';
const ZOOM = 9; // az adatbázis 9-es szintű csempékre (quadkey) van bontva
const HEADERS = { 'User-Agent': 'tank-game-map-fetch/0.1' };

// a terület ugyanaz, mint az OSM-lekérdezésé: [bbox:dél,nyugat,észak,kelet]
const query = await readFile(queryPath, 'utf8');
const m = query.match(/\[bbox:([\d.]+),([\d.]+),([\d.]+),([\d.]+)\]/);
if (!m) {
  console.error('Nem található [bbox:...] a lekérdezésben: ' + queryPath);
  process.exit(1);
}
const [south, west, north, east] = m.slice(1).map(Number);

function quadkey(lat, lon) {
  const n = 2 ** ZOOM;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  let key = '';
  for (let i = ZOOM - 1; i >= 0; i--) key += ((x >> i) & 1) + 2 * ((y >> i) & 1);
  return key;
}
const keys = new Set([quadkey(north, west), quadkey(north, east), quadkey(south, west), quadkey(south, east)]);
console.log(`Terület: ${south},${west} – ${north},${east}; csempék: ${[...keys].join(', ')}`);

async function download(url, what) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.warn(`  ${what}: sikertelen (${err.message}), ${attempt}. próbálkozás`);
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  throw new Error(`${what} nem tölthető le`);
}

console.log('Csempejegyzék letöltése…');
const index = (await download(INDEX_URL, 'csempejegyzék')).toString('utf8');
const tiles = index
  .split('\n')
  .map((line) => line.split(','))
  .filter(([location, key]) => location === REGION && keys.has(key))
  .map(([, key, url, size, date]) => ({ key, url, size, date }));
if (tiles.length === 0) {
  console.error('A területhez nem található csempe a jegyzékben.');
  process.exit(1);
}

const features = [];
for (const tile of tiles) {
  console.log(`Csempe ${tile.key} (${tile.size}) letöltése…`);
  const text = gunzipSync(await download(tile.url, `csempe ${tile.key}`)).toString('utf8');
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    total++;
    // gyors előszűrés: csak a terület környéki koordinátákat tartalmazó sorokat elemezzük
    let feature;
    try {
      feature = JSON.parse(line);
    } catch {
      continue;
    }
    const geom = feature.geometry;
    if (!geom || geom.type !== 'Polygon') continue;
    const ring = geom.coordinates[0];
    let cx = 0;
    let cy = 0;
    for (const [lon, lat] of ring) {
      cx += lon;
      cy += lat;
    }
    cx /= ring.length;
    cy /= ring.length;
    if (cx < west || cx > east || cy < south || cy > north) continue;
    features.push({
      ring: ring.map(([lon, lat]) => [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7]),
      confidence: feature.properties?.confidence ?? null,
    });
  }
  console.log(`  ${total} alaprajz a csempében`);
}

await writeFile(outPath, JSON.stringify(features));
await writeFile(
  metaPath,
  JSON.stringify(
    {
      source: 'Microsoft Global ML Building Footprints',
      url: 'https://github.com/microsoft/GlobalMLBuildingFootprints',
      attribution: 'Microsoft',
      license: 'ODbL 1.0 – https://opendatacommons.org/licenses/odbl/',
      note: 'Műholdképekről gépi felismeréssel készült alaprajzok; típus és cím nélkül.',
      fetchedAt: new Date().toISOString(),
      tiles: tiles.map((t) => ({ quadkey: t.key, uploadDate: t.date?.trim(), size: t.size })),
      bbox: { south, west, north, east },
      count: features.length,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Kész: ${features.length} alaprajz a területen → ${path.relative(root, outPath)}`);
