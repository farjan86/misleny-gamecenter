// Letölti a MISLENY KÖZPONT pálya nyers OSM-adatait az Overpass API-ról.
// Használat: npm run map:fetch
//
// A lekérdezés szövege: assets/maps/osm/misleny-kozpont.overpassql
// Kimenet:              assets/maps/osm/misleny-kozpont.raw.json
//                       assets/maps/osm/misleny-kozpont.meta.json
//
// Adatforrás: © OpenStreetMap közreműködők, ODbL – https://www.openstreetmap.org/copyright

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const osmDir = path.join(root, 'assets', 'maps', 'osm');
const queryPath = path.join(osmDir, 'misleny-kozpont.overpassql');
const rawPath = path.join(osmDir, 'misleny-kozpont.raw.json');
const metaPath = path.join(osmDir, 'misleny-kozpont.meta.json');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryEndpoint(endpoint, query) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'tank-game-map-fetch/0.1',
    },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  const json = JSON.parse(text);
  if (!Array.isArray(json.elements) || json.elements.length === 0) {
    throw new Error('üres válasz (0 elem)');
  }
  return json;
}

const query = await readFile(queryPath, 'utf8');

let result = null;
let usedEndpoint = null;
// A nyilvános Overpass-szerverek gyakran túlterheltek: sok próbálkozás, növekvő várakozással.
const ROUNDS = 25;
outer: for (let round = 0; round < ROUNDS; round++) {
  for (const endpoint of ENDPOINTS) {
    try {
      console.log(`Lekérdezés: ${endpoint} …`);
      result = await tryEndpoint(endpoint, query);
      usedEndpoint = endpoint;
      break outer;
    } catch (err) {
      console.warn(`  sikertelen: ${err.message}`);
    }
  }
  const wait = Math.min(60_000, 5000 * 2 ** round);
  console.log(`Várakozás ${wait / 1000} mp, majd újrapróbálás…`);
  await sleep(wait);
}

if (!result) {
  console.error('Egyik Overpass-végpont sem adott használható választ.');
  process.exit(1);
}

const counts = { node: 0, way: 0, relation: 0 };
for (const el of result.elements) counts[el.type] = (counts[el.type] ?? 0) + 1;

await writeFile(rawPath, JSON.stringify(result));
await writeFile(
  metaPath,
  JSON.stringify(
    {
      source: 'OpenStreetMap (Overpass API)',
      attribution: '© OpenStreetMap közreműködők',
      license: 'ODbL 1.0 – https://www.openstreetmap.org/copyright',
      endpoint: usedEndpoint,
      fetchedAt: new Date().toISOString(),
      osmBaseTimestamp: result.osm3s?.timestamp_osm_base ?? null,
      queryFile: 'assets/maps/osm/misleny-kozpont.overpassql',
      elementCounts: counts,
    },
    null,
    2,
  ) + '\n',
);

console.log(`Kész: ${result.elements.length} elem`, counts);
console.log(`  ${path.relative(root, rawPath)}`);
console.log(`  ${path.relative(root, metaPath)}`);
