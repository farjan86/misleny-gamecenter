// A nyers OSM-adatból (assets/maps/osm/misleny-kozpont.raw.json) játékhoz
// optimalizált pályafájlt készít (assets/maps/processed/misleny-kozpont.json).
// Használat: npm run map:process
//
// Koordináta-rendszer a kimenetben: méter, origó a pálya bal felső (ÉNy-i)
// sarka, x kelet felé, y dél felé nő. A vetítés a hivatal körüli egyszerű
// helyi (equirectangular) közelítés – játékcélra elég, de NEM geodéziai
// pontosságú.
//
// Adatforrás: © OpenStreetMap közreműködők, ODbL – https://www.openstreetmap.org/copyright

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawPath = path.join(root, 'assets', 'maps', 'osm', 'misleny-kozpont.raw.json');
const metaPath = path.join(root, 'assets', 'maps', 'osm', 'misleny-kozpont.meta.json');
const landmarksPath = path.join(root, 'assets', 'maps', 'landmarks', 'misleny-kozpont.landmarks.json');
const msPath = path.join(root, 'assets', 'maps', 'osm', 'misleny-kozpont.msbuildings.json');
const housesPath = path.join(root, 'assets', 'maps', 'landmarks', 'misleny-kozpont.houses.json');
const msMetaPath = path.join(root, 'assets', 'maps', 'osm', 'misleny-kozpont.msbuildings.meta.json');
const outDir = path.join(root, 'assets', 'maps', 'processed');
const outPath = path.join(outDir, 'misleny-kozpont.json');

const TOWNHALL_NODE_ID = 2608053959;
// A pálya kiterjedése a hivatal pontjától mérve, méterben: Kozármisleny
// beépített területe (a lakóutcák kb. −630…1170 m és −810…2500 m között vannak).
// Ha változik, az assets/maps/osm/*.overpassql téglalapját is igazítani kell.
const BOUNDS = { west: 720, east: 1280, north: 880, south: 2580 };
const WIDTH = BOUNDS.west + BOUNDS.east;
const HEIGHT = BOUNDS.north + BOUNDS.south;
const EARTH_R = 6371008.8;

// Stilizált (játékmenethez igazított) útszélességek méterben – nem mért adat.
// A közutak kétsávosak: két tank kényelmesen elfér egymás mellett.
const ROAD_WIDTH = {
  motorway: 16, trunk: 16, primary: 16, secondary: 16, tertiary: 13,
  motorway_link: 9, trunk_link: 9, primary_link: 9, secondary_link: 9, tertiary_link: 9,
  unclassified: 11, residential: 11, living_street: 9.5, pedestrian: 7, service: 6.5,
  track: 4.5, cycleway: 3, footway: 2.5, path: 2, steps: 2.5,
};
// Ha egy épület közelebb van az út tengelyéhez, az út eddig az értékig szűkülhet.
const ROAD_MIN_WIDTH = {
  motorway: 12, trunk: 12, primary: 12, secondary: 12, tertiary: 10, unclassified: 8.5, residential: 8.5,
  living_street: 7.5, service: 4.5,
};
/** Az úttest széle és az épületek között legalább ennyi hely marad (m). */
const ROAD_CLEARANCE = 0.6;
/** Főutak: nincs mellettük járda, csak padka és széles füves sáv fasorral. */
const MAIN = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
/** Lakóutcák: úttest, füves sáv, majd járda. */
const STREET = new Set(['unclassified', 'residential', 'living_street']);
const DRIVABLE = new Set([...MAIN, ...STREET]);
const SHOULDER = 0.6; // a főutak melletti padka
const VERGE = 1.8; // füves sáv a lakóutca úttestje és a járda között
const SIDEWALK = 1.2; // a járda szélessége
const SKIP_HIGHWAY = new Set(['proposed', 'construction', 'platform', 'bus_stop', 'razed', 'abandoned']);

const AREA_KIND = {
  landuse: {
    residential: 'residential', forest: 'forest', farmland: 'farmland', meadow: 'meadow',
    orchard: 'orchard', allotments: 'allotments', recreation_ground: 'recreation',
    industrial: 'industrial', commercial: 'industrial', retail: 'industrial', grass: 'grass',
    village_green: 'park', cemetery: 'cemetery', vineyard: 'orchard',
  },
  leisure: {
    park: 'park', playground: 'playground', swimming_pool: 'pool', pitch: 'pitch',
    garden: 'garden', sports_centre: 'recreation',
  },
  natural: { water: 'water', wood: 'forest', scrub: 'scrub', grassland: 'meadow' },
  amenity: { parking: 'parking' },
  place: { square: 'square' },
};
// Rajzolási sorrend: kisebb érték = lejjebb.
const AREA_ORDER = [
  'residential', 'farmland', 'meadow', 'industrial', 'forest', 'scrub', 'orchard', 'allotments',
  'cemetery', 'recreation', 'park', 'grass', 'garden', 'pitch', 'playground', 'parking',
  'square', 'water', 'pool',
];

const POI_AMENITY = new Set([
  'townhall', 'place_of_worship', 'post_office', 'police', 'pharmacy', 'doctors', 'dentist',
  'school', 'kindergarten', 'library', 'community_centre', 'bank', 'fire_station',
]);

// ---------------------------------------------------------------------------

const raw = JSON.parse(await readFile(rawPath, 'utf8'));
let fetchMeta = {};
try {
  fetchMeta = JSON.parse(await readFile(metaPath, 'utf8'));
} catch {
  /* a meta fájl nem kötelező */
}
// Kézzel felvett tereptárgy-részletek (fotók alapján) – nem OSM-adat, opcionális.
let landmarks = null;
try {
  landmarks = JSON.parse(await readFile(landmarksPath, 'utf8'));
} catch {
  /* nincs tereptárgy-fájl */
}

const warnings = [];
const warn = (msg) => {
  warnings.push(msg);
  console.warn('FIGYELEM: ' + msg);
};

const th = raw.elements.find((e) => e.type === 'node' && e.id === TOWNHALL_NODE_ID);
if (!th) {
  console.error(`A hivatal OSM-objektuma (node ${TOWNHALL_NODE_ID}) nincs a nyers adatban.`);
  process.exit(1);
}
const lat0 = th.lat;
const lon0 = th.lon;
const thX = BOUNDS.west;
const thY = BOUNDS.north;
const ky = (EARTH_R * Math.PI) / 180;
const kx = ky * Math.cos((lat0 * Math.PI) / 180);
const project = (p) => [(p.lon - lon0) * kx + thX, (lat0 - p.lat) * ky + thY];

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const flat = (pts) => pts.flatMap(([x, y]) => [r2(x), r2(y)]);

// --- geometria segédek -------------------------------------------------------

function ringArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return a / 2;
}
const flatArea = (f) => {
  let a = 0;
  for (let i = 0, n = f.length / 2, j = n - 1; i < n; j = i++) {
    a += f[j * 2] * f[i * 2 + 1] - f[i * 2] * f[j * 2 + 1];
  }
  return Math.abs(a / 2);
};
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};
const lineDist = (px, py, f) => {
  let best = Infinity;
  for (let i = 0; i + 3 < f.length; i += 2) best = Math.min(best, segDist(px, py, f[i], f[i + 1], f[i + 2], f[i + 3]));
  return best;
};
const pipFlat = (x, y, f) => {
  let inside = false;
  for (let i = 0, n = f.length / 2, j = n - 1; i < n; j = i++) {
    const xi = f[i * 2];
    const yi = f[i * 2 + 1];
    const xj = f[j * 2];
    const yj = f[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const boxOfFlat = (f) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < f.length; k += 2) {
    minX = Math.min(minX, f[k]);
    maxX = Math.max(maxX, f[k]);
    minY = Math.min(minY, f[k + 1]);
    maxY = Math.max(maxY, f[k + 1]);
  }
  return [minX, minY, maxX, maxY];
};
/** A töröttvonal pontjai egyenletes lépésközzel: [x, y, irányszög]. */
function walkLine(f, step, start = 0) {
  const out = [];
  let next = start;
  let acc = 0;
  for (let i = 0; i + 3 < f.length; i += 2) {
    const dx = f[i + 2] - f[i];
    const dy = f[i + 3] - f[i + 1];
    const len = Math.hypot(dx, dy);
    while (next <= acc + len) {
      const t = len ? (next - acc) / len : 0;
      out.push([f[i] + dx * t, f[i + 1] + dy * t, Math.atan2(dy, dx)]);
      next += step;
    }
    acc += len;
  }
  return out;
}

/** Sutherland–Hodgman: zárt gyűrű vágása a pálya téglalapjára. */
function clipRing(pts) {
  const edges = [
    [(p) => p[0] >= 0, (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= WIDTH, (a, b) => [WIDTH, a[1] + ((b[1] - a[1]) * (WIDTH - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= 0, (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0]],
    [(p) => p[1] <= HEIGHT, (a, b) => [a[0] + ((b[0] - a[0]) * (HEIGHT - a[1])) / (b[1] - a[1]), HEIGHT]],
  ];
  let out = pts;
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cut(prev, cur));
        out.push(cur);
      } else if (pi) {
        out.push(cut(prev, cur));
      }
    }
    if (out.length < 3) return [];
  }
  // egymást követő azonos pontok kiszűrése
  const dedup = [];
  for (const p of out) {
    const q = dedup[dedup.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(q[1] - p[1]) > 1e-6) dedup.push(p);
  }
  return dedup.length >= 3 ? dedup : [];
}

/** Liang–Barsky: töröttvonal vágása a pálya téglalapjára; több darabot is adhat. */
function clipLine(pts) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (const [p, q] of [[-dx, x0], [dx, WIDTH - x0], [-dy, y0], [dy, HEIGHT - y0]]) {
      if (p === 0) {
        if (q < 0) ok = false;
      } else {
        const r = q / p;
        if (p < 0) {
          if (r > t1) ok = false;
          else if (r > t0) t0 = r;
        } else {
          if (r < t0) ok = false;
          else if (r < t1) t1 = r;
        }
      }
    }
    if (!ok) {
      cur = null;
      continue;
    }
    const a = [x0 + t0 * dx, y0 + t0 * dy];
    const b = [x0 + t1 * dx, y0 + t1 * dy];
    if (cur && t0 === 0) {
      cur.push(b);
    } else {
      cur = [a, b];
      pieces.push(cur);
    }
    if (t1 < 1) cur = null;
  }
  return pieces.filter((p) => p.length >= 2);
}

/** Multipoligon-tagok (way-darabok) összefűzése zárt gyűrűkké. */
function assembleRings(members, relId) {
  const key = (p) => p.lat.toFixed(7) + ',' + p.lon.toFixed(7);
  const pool = members.filter((m) => m.geometry && m.geometry.length >= 2).map((m) => m.geometry.slice());
  const rings = [];
  let failed = 0;
  while (pool.length) {
    let ring = pool.pop();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10000) {
      const endKey = key(ring[ring.length - 1]);
      const idx = pool.findIndex((g) => key(g[0]) === endKey || key(g[g.length - 1]) === endKey);
      if (idx < 0) break;
      const seg = pool.splice(idx, 1)[0];
      if (key(seg[0]) !== endKey) seg.reverse();
      ring = ring.concat(seg.slice(1));
    }
    if (key(ring[0]) === key(ring[ring.length - 1]) && ring.length >= 4) rings.push(ring.slice(0, -1));
    else failed++;
  }
  if (failed) warn(`relation ${relId}: ${failed} gyűrű nem zárható – kihagyva`);
  return rings;
}

function wayRing(el) {
  const g = el.geometry;
  if (!g || g.length < 4) return null;
  const a = g[0];
  const b = g[g.length - 1];
  if (a.lat !== b.lat || a.lon !== b.lon) return null;
  return g.slice(0, -1);
}

/** Az elem gyűrűi (külsők + belsők együtt, even-odd kitöltéshez), vetítve és vágva. */
function elementRings(el) {
  let rings = [];
  if (el.type === 'way') {
    const r = wayRing(el);
    if (r) rings = [r];
  } else if (el.type === 'relation') {
    const outers = assembleRings(el.members.filter((m) => m.type === 'way' && m.role !== 'inner'), el.id);
    const inners = assembleRings(el.members.filter((m) => m.type === 'way' && m.role === 'inner'), el.id);
    rings = outers.concat(inners);
  }
  return rings.map((r) => clipRing(r.map(project))).filter((r) => r.length >= 3 && Math.abs(ringArea(r)) >= 1);
}

// --- feldolgozás -------------------------------------------------------------

const areas = [];
const roads = [];
const buildings = [];
const streams = [];
const barriers = [];
const trees = [];
const pois = [];
const crossingNodes = [];
const buildingRef = new Map(); // épület-azonosító → "way/123"

const inMap = (x, y) => x >= 0 && x <= WIDTH && y >= 0 && y <= HEIGHT;

function poiFrom(el, x, y) {
  const t = el.tags ?? {};
  let kind = null;
  if (t.amenity && POI_AMENITY.has(t.amenity)) kind = t.amenity;
  else if (t.historic === 'memorial') kind = 'memorial';
  if (!kind || !inMap(x, y)) return;
  // Csak közintézmény típusa és neve kerül át – elérhetőség, nyitvatartás stb. nem.
  pois.push({ osm: `${el.type}/${el.id}`, kind, name: t.name ?? null, x: r2(x), y: r2(y) });
}
const centre = (ring) => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];

for (const el of raw.elements) {
  const t = el.tags ?? {};

  if (el.type === 'node') {
    const [x, y] = project(el);
    if (t.natural === 'tree' && inMap(x, y)) trees.push({ x: r2(x), y: r2(y) });
    if (t.highway === 'crossing' && inMap(x, y)) crossingNodes.push([x, y]);
    poiFrom(el, x, y);
    continue;
  }

  // --- épületek
  if (t.building) {
    const rings = elementRings(el);
    if (rings.length) {
      const outer = rings[0];
      const area = Math.abs(ringArea(outer));
      if (area >= 4) {
        buildings.push({
          id: el.id,
          kind: t.building,
          area: r1(area),
          pts: flat(outer),
          ...(rings.length > 1 ? { holes: rings.slice(1).map(flat) } : {}),
        });
        buildingRef.set(el.id, `${el.type}/${el.id}`);
        poiFrom(el, ...centre(outer));
      }
    }
    continue;
  }

  // --- utak
  if (t.highway && el.type === 'way') {
    if (SKIP_HIGHWAY.has(t.highway)) continue;
    if (t.area === 'yes') {
      const rings = elementRings(el);
      if (rings.length) areas.push({ id: el.id, kind: 'square', rings: rings.map(flat) });
      continue;
    }
    const kind = t.highway;
    const width = ROAD_WIDTH[kind] ?? 4;
    for (const piece of clipLine(el.geometry.map(project))) {
      roads.push({
        id: el.id,
        kind,
        name: t.name ?? null,
        width,
        ...(t.bridge && t.bridge !== 'no' ? { bridge: true } : {}),
        pts: flat(piece),
      });
    }
    continue;
  }

  if (t.waterway && el.type === 'way') {
    const width = t.waterway === 'river' ? 10 : t.waterway === 'canal' ? 5 : 2.5;
    for (const piece of clipLine(el.geometry.map(project))) {
      streams.push({ id: el.id, kind: t.waterway, name: t.name ?? null, width, pts: flat(piece) });
    }
    continue;
  }

  if (t.barrier && el.type === 'way') {
    for (const piece of clipLine(el.geometry.map(project))) {
      barriers.push({ id: el.id, kind: t.barrier, pts: flat(piece) });
    }
    continue;
  }

  if (t.natural === 'tree_row' && el.type === 'way') {
    // fasor: kb. 8 méterenként egy fa a vonal mentén
    for (const [x, y] of walkLine(flat(el.geometry.map(project)), 8)) {
      if (inMap(x, y)) trees.push({ x: r2(x), y: r2(y) });
    }
    continue;
  }

  // --- területek
  let kind = null;
  for (const key of Object.keys(AREA_KIND)) {
    if (t[key] && AREA_KIND[key][t[key]]) {
      kind = AREA_KIND[key][t[key]];
      break;
    }
  }
  if (kind) {
    const rings = elementRings(el);
    if (rings.length) areas.push({ id: el.id, kind, rings: rings.map(flat) });
    if (t.amenity && rings[0]) poiFrom(el, ...centre(rings[0]));
  }
}

// területek rajzolási sorrendje: típus szerint, azon belül a nagyobb kerül alulra
areas.sort((a, b) => {
  const d = AREA_ORDER.indexOf(a.kind) - AREA_ORDER.indexOf(b.kind);
  return d !== 0 ? d : flatArea(b.rings[0]) - flatArea(a.rings[0]);
});

// utak sorrendje: gyalogutak alul, főút felül
const ROAD_ORDER = ['path', 'footway', 'steps', 'cycleway', 'track', 'service', 'pedestrian', 'living_street', 'residential',
  'unclassified', 'tertiary_link', 'secondary_link', 'primary_link', 'trunk_link', 'motorway_link', 'tertiary', 'secondary',
  'primary', 'trunk', 'motorway'];
roads.sort((a, b) => ROAD_ORDER.indexOf(a.kind) - ROAD_ORDER.indexOf(b.kind));

// --- az épületek rácsindexe ---------------------------------------------------------

const toPairsOf = (f) => {
  const out = [];
  for (let i = 0; i < f.length; i += 2) out.push([f[i], f[i + 1]]);
  return out;
};
const B_CELL = 25;
const bGrid = new Map();
buildings.forEach((b, i) => {
  const [minX, minY, maxX, maxY] = boxOfFlat(b.pts);
  for (let cy = Math.floor(minY / B_CELL); cy <= Math.floor(maxY / B_CELL); cy++) {
    for (let cx = Math.floor(minX / B_CELL); cx <= Math.floor(maxX / B_CELL); cx++) {
      const key = cx + ',' + cy;
      if (!bGrid.has(key)) bGrid.set(key, []);
      bGrid.get(key).push(i);
    }
  }
});
/** Az épület, amelyben a pont van, illetve a legközelebbi körvonal távolsága (`reach` méterig keres). */
function nearestBuilding(x, y, reach) {
  let best = Infinity;
  let hit = null;
  const seen = new Set();
  for (let cy = Math.floor((y - reach) / B_CELL); cy <= Math.floor((y + reach) / B_CELL); cy++) {
    for (let cx = Math.floor((x - reach) / B_CELL); cx <= Math.floor((x + reach) / B_CELL); cx++) {
      for (const i of bGrid.get(cx + ',' + cy) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const f = buildings[i].pts;
        if (pipFlat(x, y, f)) return { building: buildings[i], dist: 0 };
        for (let k = 0, n = f.length / 2, j = n - 1; k < n; j = k++) {
          const d = segDist(x, y, f[j * 2], f[j * 2 + 1], f[k * 2], f[k * 2 + 1]);
          if (d < best) {
            best = d;
            hit = buildings[i];
          }
        }
      }
    }
  }
  return { building: hit, dist: best };
}
const buildingDist = (x, y, reach) => nearestBuilding(x, y, reach).dist;
function indexBuilding(i) {
  const [minX, minY, maxX, maxY] = boxOfFlat(buildings[i].pts);
  for (let cy = Math.floor(minY / B_CELL); cy <= Math.floor(maxY / B_CELL); cy++) {
    for (let cx = Math.floor(minX / B_CELL); cx <= Math.floor(maxX / B_CELL); cx++) {
      const key = cx + ',' + cy;
      if (!bGrid.has(key)) bGrid.set(key, []);
      bGrid.get(key).push(i);
    }
  }
}

// --- kiegészítő épületalaprajzok ott, ahol az OSM-ben nincs épület ---------------------
// Forrás: Microsoft Global ML Building Footprints (ODbL) – műholdképről, gépi
// felismeréssel készült alaprajzok (scripts/fetch-buildings.mjs tölti le).
// Valós épületek, de pontatlanabbak az OSM-nél, és nincs típusuk; ezért csak
// azok kerülnek be, amelyek nem érnek hozzá OSM-épülethez és nem esnek útra.

const osmBuildingCount = buildings.length;
let msBuildingCount = 0;
let msMeta = null;
try {
  const msRaw = JSON.parse(await readFile(msPath, 'utf8'));
  try {
    msMeta = JSON.parse(await readFile(msMetaPath, 'utf8'));
  } catch {
    /* a meta fájl nem kötelező */
  }
  const drivableRoads = roads.filter((r) => DRIVABLE.has(r.kind));
  const drivableBoxes = drivableRoads.map((r) => boxOfFlat(r.pts));
  msRaw.forEach((feature, n) => {
    const raw = feature.ring;
    const closed = raw.length > 1 && raw[0][0] === raw[raw.length - 1][0] && raw[0][1] === raw[raw.length - 1][1];
    const ring = clipRing((closed ? raw.slice(0, -1) : raw).map(([lon, lat]) => project({ lon, lat })));
    if (ring.length < 3) return;
    const area = Math.abs(ringArea(ring));
    if (area < 25 || area > 6000) return;
    const pts = flat(ring);
    const [cx, cy] = centre(ring);
    // hozzáér-e meglévő épülethez?
    if (nearestBuilding(cx, cy, 6).dist < 2) return;
    for (const [x, y] of ring) if (nearestBuilding(x, y, 4).dist < 0.8) return;
    const [minX, minY, maxX, maxY] = boxOfFlat(pts);
    for (let gy = Math.floor(minY / B_CELL); gy <= Math.floor(maxY / B_CELL); gy++) {
      for (let gx = Math.floor(minX / B_CELL); gx <= Math.floor(maxX / B_CELL); gx++) {
        for (const i of bGrid.get(gx + ',' + gy) ?? []) {
          const f = buildings[i].pts;
          for (let k = 0; k < f.length; k += 2) if (pipFlat(f[k], f[k + 1], pts)) return;
        }
      }
    }
    // téves felismerés: az alaprajz közepe úttestre esik
    for (let i = 0; i < drivableRoads.length; i++) {
      const road = drivableRoads[i];
      const b = drivableBoxes[i];
      const reach = (ROAD_MIN_WIDTH[road.kind] ?? road.width) / 2;
      if (cx < b[0] - reach || cx > b[2] + reach || cy < b[1] - reach || cy > b[3] + reach) continue;
      if (lineDist(cx, cy, road.pts) < reach) return;
    }
    buildings.push({ id: 9_000_000_000 + n, kind: 'yes', area: r1(area), pts, src: 'ms' });
    indexBuilding(buildings.length - 1);
    msBuildingCount++;
  });
} catch {
  warn('Nincs kiegészítő épületadat (npm run map:buildings) – csak az OSM-ben szereplő épületek kerülnek a pályára.');
}

// --- kézzel felvett házak ---------------------------------------------------------------
// Ahol az OSM-ben nincs épület, a kiegészítő adatban pedig csak töredék (új
// beépítésű utcák), ott a házakat egy külön fájl adja meg: a pálya készítőjétől
// kapott vázlatrajz alapján, az utcákhoz igazítva készültek. Nem OSM-adat, a
// forrásuk 'hand'. Az OSM-épület elsőbbséget élvez (ahol van, a rajzolt kimarad);
// a kiegészítő adat töredékeit viszont a rajzolt ház váltja ki.

let handBuildings = 0;
let handReplaced = 0;
/** A rajzok által lefedett területek [minX, minY, maxX, maxY] – itt nincs generált ház. */
let handCovers = [];
/** A rajzokról felvett fák (x, y, sugár), és a területek, ahol a rajz adja a fákat. */
let handTrees = [];
let handTreeCovers = [];
const inCovers = (covers, x, y) => covers.some((c) => x > c[0] && x < c[2] && y > c[1] && y < c[3]);
try {
  const hand = JSON.parse(await readFile(housesPath, 'utf8'));
  const shift = (v, i) => v + (i % 2 === 0 ? thX : thY);
  const boxes = (list) => (typeof list?.[0] === 'number' ? [list] : list ?? []).map((c) => c.map(shift));
  handCovers = boxes(hand.covers);
  handTreeCovers = boxes(hand.treeCovers);
  for (let k = 0; k + 2 < (hand.trees ?? []).length; k += 3) handTrees.push({ x: hand.trees[k] + thX, y: hand.trees[k + 1] + thY, r: hand.trees[k + 2] });
  // a kiegészítő adat azon épületei, amelyek a rajzon is szerepelnek: ezek maradnak (a középpontjuk)
  const keep = [];
  for (let k = 0; k + 1 < (hand.keep ?? []).length; k += 2) keep.push([hand.keep[k] + thX, hand.keep[k + 1] + thY]);
  const ringDistFlat = (x, y, f) => {
    if (pipFlat(x, y, f)) return 0;
    let best = Infinity;
    for (let k = 0, n = f.length / 2, j = n - 1; k < n; j = k++) best = Math.min(best, segDist(x, y, f[j * 2], f[j * 2 + 1], f[k * 2], f[k * 2 + 1]));
    return best;
  };
  const drop = new Set();
  const added = [];
  for (const h of hand.buildings) {
    const pts = h.pts.map((v, i) => r2(v + (i % 2 === 0 ? thX : thY)));
    const ring = toPairsOf(pts);
    const [cx, cy] = centre(ring);
    // OSM-épület van a helyén?
    const probes = [[cx, cy], ...ring];
    if (probes.some(([x, y]) => {
      const hit = nearestBuilding(x, y, 6);
      return hit.building && !hit.building.src && hit.dist < 2;
    })) continue;
    // a kiegészítő adat közeli töredékei kimaradnak
    buildings.forEach((b, i) => {
      if (b.src !== 'ms' || drop.has(i)) return;
      const [bx, by] = centre(toPairsOf(b.pts));
      if (Math.abs(bx - cx) > 60 || Math.abs(by - cy) > 60) return;
      if (keep.some(([kx, ky]) => Math.abs(kx - bx) < 0.6 && Math.abs(ky - by) < 0.6)) return;
      if (ringDistFlat(bx, by, pts) < hand.replaceWithin) drop.add(i);
    });
    added.push({ id: 9_700_000_000 + h.id, kind: h.kind, area: r1(Math.abs(ringArea(ring))), pts, src: 'hand' });
  }
  if (drop.size || added.length) {
    const keep = buildings.filter((_, i) => !drop.has(i));
    buildings.length = 0;
    buildings.push(...keep, ...added);
    bGrid.clear();
    buildings.forEach((_, i) => indexBuilding(i));
    handBuildings = added.length;
    handReplaced = drop.size;
    msBuildingCount -= drop.size;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

// --- a hivatal épületének azonosítása ---------------------------------------

const thNear = nearestBuilding(thX, thY, 30);
let thBuilding = thNear.building;
let thMatch = thNear.dist === 0 ? 'contains' : thBuilding ? 'nearest' : 'none';
if (thMatch === 'nearest' && thNear.dist > 25) {
  warn(`A hivatal pontjához (node ${TOWNHALL_NODE_ID}) 25 m-en belül nincs épületkontúr (legközelebbi: ${thNear.dist.toFixed(1)} m).`);
  thBuilding = null;
  thMatch = 'none';
} else if (thMatch === 'nearest') {
  warn(`A hivatal pontja nem esik épületkontúron belülre; a legközelebbi épület (${thNear.dist.toFixed(1)} m) lett hivatalként megjelölve.`);
} else if (thMatch === 'none') {
  warn(`A hivatal pontjához (node ${TOWNHALL_NODE_ID}) 30 m-en belül nincs épületkontúr.`);
}
if (thBuilding) thBuilding.townhall = true;

// --- fotók alapján felvett tereptárgyak: a hivatalhoz viszonyított koordináták → pályakoordináták ---

if (landmarks) {
  const shift = (arr) => arr.map((v, i) => r2(v + (i % 2 === 0 ? thX : thY)));
  const move = (o) => ({ ...o, x: r2(o.x + thX), y: r2(o.y + thY) });
  landmarks = {
    ...landmarks,
    units: 'méter a pálya koordináta-rendszerében (a forrásfájlban a hivatal pontjához képest)',
    buildings: landmarks.buildings.map((b) => ({
      ...b,
      ...(b.parts ? { parts: b.parts.map((p) => ({ ...p, polygon: shift(p.polygon), eaveA: shift(p.eaveA), eaveB: shift(p.eaveB) })) } : {}),
      ...(b.towers ? { towers: b.towers.map((tw) => ({ ...tw, polygon: shift(tw.polygon) })) } : {}),
      ...(b.vents ? { vents: b.vents.map(shift) } : {}),
    })),
    areas: landmarks.areas.map((a) => ({ ...a, ring: shift(a.ring) })),
    hedges: landmarks.hedges.map(shift),
    benches: landmarks.benches.map(move),
    flagpoles: landmarks.flagpoles.map(move),
    lamps: landmarks.lamps.map(shift),
    cars: landmarks.cars.map(move),
    trees: (landmarks.trees ?? []).map(move),
  };
  for (const b of landmarks.buildings) {
    if (!buildings.some((x) => x.id === b.id)) warn(`A tereptárgy-fájlban szereplő épület (${b.name}, ${b.id}) nincs az OSM-adatban.`);
  }
}

// --- útszélesség igazítása a beépítéshez ---------------------------------------

let narrowedRoads = 0;
for (const road of roads) {
  const min = ROAD_MIN_WIDTH[road.kind];
  if (!min) continue;
  const clears = [];
  for (const [x, y] of walkLine(road.pts, 2)) {
    const d = buildingDist(x, y, 12);
    // ahol az út épületen megy át (áthajtó, pontatlan adat), azt nem vesszük figyelembe
    if (d > 0.5) clears.push(d);
  }
  clears.sort((a, b) => a - b);
  // A legközelebb álló épületek (a minták legszűkebb negyede) nem szűkítik az egész
  // útdarabot: azokat az út széléhez igazítjuk (lásd „az utakra belógó épületek”).
  const clear = clears.length ? clears[Math.floor(clears.length * 0.25)] : Infinity;
  const fit = Math.max(min, Math.min(road.width, 2 * (clear - ROAD_CLEARANCE)));
  if (fit < road.width) {
    road.width = r2(fit);
    narrowedRoads++;
  }
}

/** Az út teljes sávja: főútnál úttest + padka, lakóutcánál úttest + füves sáv + járda. */
const halfBand = (road) => road.width / 2 + (MAIN.has(road.kind) ? SHOULDER : STREET.has(road.kind) ? VERGE + SIDEWALK : 0);
const roadBoxes = roads.map((road) => boxOfFlat(road.pts));
function nearRoad(x, y, reachOf) {
  for (let i = 0; i < roads.length; i++) {
    const reach = reachOf(roads[i]);
    const box = roadBoxes[i];
    if (x < box[0] - reach || x > box[2] + reach || y < box[1] - reach || y > box[3] + reach) continue;
    if (lineDist(x, y, roads[i].pts) < reach) return true;
  }
  return false;
}
/** Igaz, ha a pont valamelyik út teljes sávjába (járdával együtt) esik. */
const onRoadBand = (x, y, margin) => nearRoad(x, y, (road) => halfBand(road) + margin);
/** Igaz, ha a pont valamelyik út burkolatára esik (a füves sáv nem számít). */
const onAsphalt = (x, y, margin) => nearRoad(x, y, (road) => road.width / 2 + margin);

// --- generált házak a megadott utcák mentén ----------------------------------------
// Ahol a valóságban (új) házak állnak, de sem az OSM-ben, sem a kiegészítő
// épületadatban nincsenek benne, az utca üres maradna. Ezekre az utcákra a
// program KITALÁLT házakat tesz: telkenként egyet az út két oldalán, kerttel,
// néhol melléképülettel. Nem valós alaprajzok – a forrásuk 'gen', a számuk a
// statisztikában szerepel, és a pálya metaadata megnevezi az utcákat. Csak
// szabad helyre kerülnek: meglévő épülethez, úthoz, vízhez, erdőhöz nem érnek.
// Csak az utca burkolt (lakóutca) szakaszára, a földútra nem; és ott sem, ahol
// a házakat kézzel vettük fel (ott az üres telek is szándékos).

const GENERATED_STREETS = ['Kiskozári utca'];
const GEN_BLOCKED = new Set(['water', 'pool', 'forest', 'cemetery', 'pitch', 'playground', 'parking', 'square', 'industrial']);
let generatedHouses = 0;
let generatedSheds = 0;
{
  const rnd = mulberry32(20261120);
  const between = (min, max) => min + rnd() * (max - min);
  const blockedArea = (x, y) => areas.some((a) => GEN_BLOCKED.has(a.kind) && a.rings.some((ring) => pipFlat(x, y, ring)));
  const nearStream = (x, y) => streams.some((st) => lineDist(x, y, st.pts) < (st.width ?? 2) / 2 + 4);
  /** Szabad-e az alaprajz: a pályán belül van, és nem ér úthoz, épülethez, vízhez. */
  const free = (ring) => {
    const [cx, cy] = centre(ring);
    const probes = [[cx, cy], ...ring, ...ring.map((p, i) => [(p[0] + ring[(i + 1) % ring.length][0]) / 2, (p[1] + ring[(i + 1) % ring.length][1]) / 2])];
    for (const [x, y] of probes) {
      if (x < 10 || y < 10 || x > WIDTH - 10 || y > HEIGHT - 10) return false;
      if (nearRoad(x, y, (road) => road.width / 2 + 3.5)) return false;
      if (nearestBuilding(x, y, 10).dist < 4.5) return false;
      if (blockedArea(x, y) || nearStream(x, y)) return false;
    }
    return true;
  };
  const addBuilding = (ring, kind) => {
    buildings.push({ id: 9_500_000_000 + generatedHouses + generatedSheds, kind, area: r1(Math.abs(ringArea(ring))), pts: flat(ring), src: 'gen' });
    indexBuilding(buildings.length - 1);
  };
  for (const road of roads.filter((r) => GENERATED_STREETS.includes(r.name) && STREET.has(r.kind))) {
    const f = road.pts;
    for (const side of [1, -1]) {
      // a telkek az út mentén sorakoznak; az első kicsit beljebb kezdődik
      let lotStart = between(4, 12);
      let walked = 0;
      for (let i = 0; i + 3 < f.length; i += 2) {
        const dx = f[i + 2] - f[i];
        const dy = f[i + 3] - f[i + 1];
        const len = Math.hypot(dx, dy);
        if (len < 1) continue;
        const tx = dx / len;
        const ty = dy / len;
        // az út normálisa a választott oldal felé
        const nx = -ty * side;
        const ny = tx * side;
        while (lotStart - walked < len) {
          const lot = between(22, 29);
          const mid = lotStart + lot / 2 - walked;
          lotStart += lot;
          if (mid < 0 || mid > len) continue;
          const px = f[i] + tx * mid;
          const py = f[i + 1] + ty * mid;
          if (inCovers(handCovers, px, py)) continue;
          // a ház: széles oldalával az utcára néz, az úttesttől néhány méterre
          const w = Math.min(lot - 7, between(9.5, 14.5));
          const d = between(8, 11.5);
          const setback = road.width / 2 + between(6, 10);
          const at = (u, v) => [px + tx * u + nx * (setback + v), py + ty * u + ny * (setback + v)];
          let ring;
          if (rnd() < 0.38) {
            // L alakú ház: hátul egy szárny az egyik végén
            const ww = between(4.5, 6.5);
            const wd = between(4, 7);
            const flip = rnd() < 0.5 ? 1 : -1;
            if (flip < 0) ring = [at(-w / 2, 0), at(w / 2, 0), at(w / 2, d + wd), at(w / 2 - ww, d + wd), at(w / 2 - ww, d), at(-w / 2, d)];
            else ring = [at(-w / 2, 0), at(w / 2, 0), at(w / 2, d), at(-w / 2 + ww, d), at(-w / 2 + ww, d + wd), at(-w / 2, d + wd)];
          } else {
            ring = [at(-w / 2, 0), at(w / 2, 0), at(w / 2, d), at(-w / 2, d)];
          }
          if (!free(ring)) continue;
          // a kert: a telek az úttól a ház mögé nyúlik
          const depth = d + between(16, 24);
          const yard = [at(-lot / 2 + 1, -setback + road.width / 2 + 3.2), at(lot / 2 - 1, -setback + road.width / 2 + 3.2), at(lot / 2 - 1, depth), at(-lot / 2 + 1, depth)];
          areas.push({ id: 9_600_000_000 + generatedHouses, kind: 'garden', rings: [flat(yard)] });
          addBuilding(ring, 'house');
          generatedHouses++;
          // melléképület (garázs, fészer) a kert végében
          if (rnd() < 0.45) {
            const sw = between(4, 6.5);
            const sd = between(4.5, 7);
            const su = (rnd() < 0.5 ? -1 : 1) * (lot / 2 - sw / 2 - 2.5);
            const sv = d + between(6, 10);
            const shed = [at(su - sw / 2, sv), at(su + sw / 2, sv), at(su + sw / 2, sv + sd), at(su - sw / 2, sv + sd)];
            if (free(shed)) {
              addBuilding(shed, 'garage');
              generatedSheds++;
            }
          }
        }
        walked += len;
      }
    }
  }
}

// --- az utakra belógó épületek igazítása -----------------------------------------
// A közutak úttestje (és mellette ROAD_CLEARANCE) szabad marad: ahol egy épület
// alaprajza belelógna, ott az út szélével párhuzamosan levágjuk. Ha így túl kevés
// maradna belőle, vagy az út az épület közepén megy át, az épület kimarad.
// Ez az alaprajzok szándékos módosítása a játszhatóság kedvéért; a számát a
// statisztika és a figyelmeztetések közlik. A fotók alapján felvett épületek kimaradnak.

const protectedIds = new Set((landmarks?.buildings ?? []).map((b) => b.id));
const toPairs = (f) => {
  const out = [];
  for (let i = 0; i < f.length; i += 2) out.push([f[i], f[i + 1]]);
  return out;
};
/** Sokszög vágása félsíkra: a (px,py) ponton átmenő, (nx,ny) normálisú egyenes pozitív oldala marad. */
function clipHalfPlane(ring, px, py, nx, ny) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i];
    const prev = ring[(i + ring.length - 1) % ring.length];
    const dc = (cur[0] - px) * nx + (cur[1] - py) * ny;
    const dp = (prev[0] - px) * nx + (prev[1] - py) * ny;
    if (dc >= 0 !== dp >= 0) {
      const t = dp / (dp - dc);
      out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
    }
    if (dc >= 0) out.push(cur);
  }
  return out;
}
let trimmedBuildings = 0;
let removedBuildings = 0;
for (let bi = buildings.length - 1; bi >= 0; bi--) {
  const b = buildings[bi];
  if (b.townhall || protectedIds.has(b.id)) continue;
  let ring = toPairs(b.pts);
  let changed = false;
  let drop = false;
  const [minX, minY, maxX, maxY] = boxOfFlat(b.pts);
  for (let ri = 0; ri < roads.length && !drop; ri++) {
    const road = roads[ri];
    if (!DRIVABLE.has(road.kind)) continue;
    const reach = road.width / 2 + ROAD_CLEARANCE;
    const box = roadBoxes[ri];
    if (maxX < box[0] - reach || minX > box[2] + reach || maxY < box[1] - reach || minY > box[3] + reach) continue;
    const f = road.pts;
    for (let i = 0; i + 3 < f.length && !drop; i += 2) {
      const ax = f[i];
      const ay = f[i + 1];
      const dx = f[i + 2] - ax;
      const dy = f[i + 3] - ay;
      const len = Math.hypot(dx, dy);
      if (len < 0.05 || ring.length < 3) continue;
      // belelóg-e az alaprajz ennek a szakasznak a sávjába? (az élek mentén méterenként vizsgálva)
      let intrudes = false;
      for (let k = 0; k < ring.length && !intrudes; k++) {
        const p0 = ring[k];
        const p1 = ring[(k + 1) % ring.length];
        const steps = Math.max(1, Math.ceil(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])));
        for (let st = 0; st <= steps; st++) {
          const x = p0[0] + ((p1[0] - p0[0]) * st) / steps;
          const y = p0[1] + ((p1[1] - p0[1]) * st) / steps;
          const along = ((x - ax) * dx + (y - ay) * dy) / len;
          if (along < 0 || along > len) continue;
          if (Math.abs((x - ax) * dy - (y - ay) * dx) / len < reach - 0.05) {
            intrudes = true;
            break;
          }
        }
      }
      if (!intrudes) continue;
      // az épület azon az oldalon marad, amelyiken a közepe van
      const [cx, cy] = centre(ring);
      const side = (cx - ax) * -dy + (cy - ay) * dx; // > 0: az út bal oldalán
      if (Math.abs(side) / len < 1) {
        drop = true; // az út az épület közepén megy át
        break;
      }
      const sign = side > 0 ? 1 : -1;
      const nx = (-dy / len) * sign;
      const ny = (dx / len) * sign;
      ring = clipHalfPlane(ring, ax + nx * reach, ay + ny * reach, nx, ny);
      changed = true;
    }
  }
  if (!changed && !drop) continue;
  const area = ring.length >= 3 ? Math.abs(ringArea(ring)) : 0;
  if (drop || area < Math.max(12, b.area * 0.35)) {
    buildings.splice(bi, 1);
    removedBuildings++;
    continue;
  }
  b.pts = flat(ring);
  b.area = r1(area);
  delete b.holes;
  trimmedBuildings++;
}
// az épületek változtak: a rácsindex újraépül
bGrid.clear();
buildings.forEach((_, i) => indexBuilding(i));

// --- a kézzel felvett tereptárgyak nem kerülhetnek az úttestre -------------------
// A lámpákat, fákat, padokat és zászlórudakat a fotók alapján, a korábbi
// (keskenyebb) úthoz mérve vettük fel; ha a kiszélesített közút rájuk érne,
// az út tengelyére merőlegesen a padka külső szélére toljuk őket.
let movedProps = 0;
function offRoad(x, y, margin) {
  for (let ri = 0; ri < roads.length; ri++) {
    const road = roads[ri];
    if (!DRIVABLE.has(road.kind)) continue;
    const reach = road.width / 2 + SHOULDER + margin;
    const box = roadBoxes[ri];
    if (x < box[0] - reach || x > box[2] + reach || y < box[1] - reach || y > box[3] + reach) continue;
    const f = road.pts;
    for (let i = 0; i + 3 < f.length; i += 2) {
      const dx = f[i + 2] - f[i];
      const dy = f[i + 3] - f[i + 1];
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - f[i]) * dx + (y - f[i + 1]) * dy) / len2)) : 0;
      const px = f[i] + dx * t;
      const py = f[i + 1] + dy * t;
      const d = Math.hypot(x - px, y - py);
      if (d >= reach || d < 0.01) continue;
      movedProps++;
      return [r2(px + ((x - px) / d) * reach), r2(py + ((y - py) / d) * reach)];
    }
  }
  return [x, y];
}
if (landmarks) {
  const moved = (o, margin) => {
    const [x, y] = offRoad(o.x, o.y, margin);
    return { ...o, x, y };
  };
  landmarks.trees = landmarks.trees.map((t) => moved(t, 1.6));
  landmarks.benches = landmarks.benches.map((b) => moved(b, 1.2));
  landmarks.flagpoles = landmarks.flagpoles.map((p) => moved(p, 0.6));
  landmarks.lamps = landmarks.lamps.map(([x, y]) => offRoad(x, y, 0.5));
}

// --- gyalogátkelők (zebrák) ------------------------------------------------------
// Forrás: az OSM highway=crossing pontjai, valamint azok a helyek, ahol egy
// gyalogút/kerékpárút ténylegesen átmegy egy közúton (mindkét oldalon folytatódik).

const MINOR = new Set(['footway', 'path', 'cycleway', 'steps']);
const crossings = [];
const crossingGrid = new Map();
function addCrossing(x, y, road, source) {
  if (!inMap(x, y)) return;
  const cx = Math.floor(x / 16);
  const cy = Math.floor(y / 16);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      for (const c of crossingGrid.get(cx + i + ',' + (cy + j)) ?? []) if (Math.hypot(c.x - x, c.y - y) < 9) return;
    }
  }
  let best = Infinity;
  let angle = 0;
  let px = x;
  let py = y;
  const f = road.pts;
  for (let i = 0; i + 3 < f.length; i += 2) {
    const dx = f[i + 2] - f[i];
    const dy = f[i + 3] - f[i + 1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - f[i]) * dx + (y - f[i + 1]) * dy) / len2)) : 0;
    const d = Math.hypot(x - f[i] - t * dx, y - f[i + 1] - t * dy);
    if (d < best) {
      best = d;
      angle = Math.atan2(dy, dx);
      px = f[i] + t * dx;
      py = f[i + 1] + t * dy;
    }
  }
  const crossing = { x: r2(px), y: r2(py), angle: Math.round(angle * 1000) / 1000, width: road.width, source };
  crossings.push(crossing);
  const key = cx + ',' + cy;
  if (!crossingGrid.has(key)) crossingGrid.set(key, []);
  crossingGrid.get(key).push(crossing);
}
for (const [x, y] of crossingNodes) {
  let bestRoad = null;
  let best = 6;
  for (const road of roads) {
    if (!DRIVABLE.has(road.kind)) continue;
    const d = lineDist(x, y, road.pts);
    if (d < best) {
      best = d;
      bestRoad = road;
    }
  }
  if (bestRoad) addCrossing(x, y, bestRoad, 'osm-node');
}
// a gyalogutak pontjai méterenként, rácsba rendezve
const M_CELL = 16;
const minorGrid = new Map();
for (const r of roads) {
  if (!MINOR.has(r.kind)) continue;
  for (const [x, y] of walkLine(r.pts, 1)) {
    const key = Math.floor(x / M_CELL) + ',' + Math.floor(y / M_CELL);
    if (!minorGrid.has(key)) minorGrid.set(key, []);
    minorGrid.get(key).push(x, y);
  }
}
for (const road of roads) {
  if (!DRIVABLE.has(road.kind) || road.kind.startsWith('motorway')) continue;
  const hw = road.width / 2;
  for (const [x, y, angle] of walkLine(road.pts, 1)) {
    // van-e gyalogút-pont az úttengelyen, és folytatódik-e az út mindkét oldalán?
    let onAxis = false;
    let left = false;
    let right = false;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const cx = Math.floor(x / M_CELL);
    const cy = Math.floor(y / M_CELL);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cell = minorGrid.get(cx + i + ',' + (cy + j));
        if (!cell) continue;
        for (let k = 0; k < cell.length; k += 2) {
          const dx = cell[k] - x;
          const dy = cell[k + 1] - y;
          const along = dx * cos + dy * sin;
          const across = dy * cos - dx * sin;
          if (Math.abs(along) < 0.8 && Math.abs(across) < 0.8) onAxis = true;
          if (Math.abs(along) < 5) {
            if (across > hw + 0.5 && across < hw + 9) left = true;
            if (across < -hw - 0.5 && across > -hw - 9) right = true;
          }
        }
      }
    }
    if (onAxis && left && right) addCrossing(x, y, road, 'footway-crossing');
  }
}

// --- generált díszítőelemek: növényzet, villanyoszlopok --------------------------
// Ezek NEM OSM-adatok: az OSM-ben a területen alig vannak egyedi fák, bokrok,
// oszlopok. A helyük rögzített magú véletlennel készül (minden futáskor ugyanaz),
// a valós épületeket, utakat és területhasználatot figyelembe véve.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(7761);
const between = (a, b) => a + rng() * (b - a);
const TREE = { deciduous: 0, conifer: 1, fruit: 2, street: 3 };
const decorTrees = []; // x, y, sugár, típus
const decorBushes = []; // x, y, sugár
const decorPoles = []; // x, y
const decorWires = []; // oszlopsoronként egy töröttvonal

// területek befoglaló dobozzal és mérettel
const areaInfo = areas.map((a) => ({ area: a, box: boxOfFlat(a.rings.flat()), size: flatArea(a.rings[0]) }));
/** A pontot fedő legfelső terület. */
function areaAt(x, y) {
  let found = null;
  for (const info of areaInfo) {
    const b = info.box;
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    let inside = false;
    for (const ring of info.area.rings) if (pipFlat(x, y, ring)) inside = !inside;
    if (inside) found = info;
  }
  return found;
}
const NO_PLANTS = new Set(['farmland', 'industrial', 'parking', 'playground', 'pitch', 'square', 'water', 'pool']);
const GREEN = new Set(['recreation', 'grass', 'cemetery', 'park']);
/** Ekkora terület fölött a parkot zárt lombú parkerdőnek tekintjük (a hivatal mögötti központi park ilyen a fotókon). */
const WOODED_PARK_MIN = 20000;
// A fotók alapján felvett területek felülírják az OSM területhasználatát:
// a burkolt téren, gyepen, ágyásban nincs generált növény; a hivatal mögött sűrű erdő van.
const LANDMARK_CLEAR = new Set(['plaza', 'lawn', 'flowerbed', 'asphalt']);
const lmShapes = [
  ...(landmarks?.areas ?? []).map((a) => ({ kind: a.kind, ring: a.ring, box: boxOfFlat(a.ring) })),
  ...(landmarks?.hedges ?? []).map((ring) => ({ kind: 'hedge', ring, box: boxOfFlat(ring) })),
];
const landmarkKindAt = (x, y) => {
  let kind = null;
  for (const s of lmShapes) {
    if (x < s.box[0] || x > s.box[2] || y < s.box[1] || y > s.box[3]) continue;
    if (pipFlat(x, y, s.ring)) kind = s.kind;
  }
  return kind;
};
const streamBoxes = streams.map((st) => boxOfFlat(st.pts));
const nearStream = (x, y) => streams.some((st, i) => {
  const b = streamBoxes[i];
  const reach = st.width / 2 + 1.2;
  return x > b[0] - reach && x < b[2] + reach && y > b[1] - reach && y < b[3] + reach && lineDist(x, y, st.pts) < reach;
});
// sima zaj a parkerdő tisztásaihoz
const noiseHash = (x, y) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smoothNoise = (x, y) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = noiseHash(xi, yi);
  const b = noiseHash(xi + 1, yi);
  const c = noiseHash(xi, yi + 1);
  const d = noiseHash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

const T_CELL = 4;
const treeGrid = new Map();
const markTree = (x, y) => {
  const key = Math.floor(x / T_CELL) + ',' + Math.floor(y / T_CELL);
  if (!treeGrid.has(key)) treeGrid.set(key, []);
  treeGrid.get(key).push(x, y);
};
function treeFree(x, y, gap) {
  const cx = Math.floor(x / T_CELL);
  const cy = Math.floor(y / T_CELL);
  const span = Math.ceil(gap / T_CELL);
  for (let j = -span; j <= span; j++) {
    for (let i = -span; i <= span; i++) {
      const cell = treeGrid.get(cx + i + ',' + (cy + j));
      if (!cell) continue;
      for (let k = 0; k < cell.length; k += 2) if (Math.hypot(cell[k] - x, cell[k + 1] - y) < gap) return false;
    }
  }
  return true;
}
function addTree(x, y, r, kind) {
  decorTrees.push(r1(x), r1(y), r1(r), kind);
  markTree(x, y);
}
for (const t of trees) markTree(t.x, t.y);
// a fotókon látható, kézzel felvett fák
for (const t of landmarks?.trees ?? []) addTree(t.x, t.y, t.r, t.kind);
// a vázlatrajzokról felvett fák; a rajzok területén nincs generált fa (a rajz mutatja, hol van)
let sketchTrees = 0;
for (const t of handTrees) {
  if (!inMap(t.x, t.y) || buildingDist(t.x, t.y, 6) < 1 || onRoadBand(t.x, t.y, 0.3) || nearStream(t.x, t.y) || !treeFree(t.x, t.y, 1.8)) continue;
  addTree(t.x, t.y, t.r, t.r < 1.9 ? TREE.fruit : TREE.deciduous);
  sketchTrees++;
}
const sketchArea = (x, y) => inCovers(handTreeCovers, x, y);

// fasorok és villanyoszlopok a közutak mentén
for (const road of roads) {
  if (!DRIVABLE.has(road.kind) || road.kind.startsWith('motorway')) continue;
  const main = MAIN.has(road.kind);
  const half = road.width / 2;

  if (main) {
    // főút: széles füves sáv, mindkét oldalon sűrű fasor (lásd a Pécsi utcáról készült fotót)
    for (const side of [1, -1]) {
      for (const [x, y, angle] of walkLine(road.pts, 10, side === 1 ? 5 : 10)) {
        if (rng() > 0.82) continue;
        const off = half + SHOULDER + between(2.1, 2.8);
        const tx = x - Math.sin(angle) * off * side;
        const ty = y + Math.cos(angle) * off * side;
        if (!inMap(tx, ty) || sketchArea(tx, ty) || buildingDist(tx, ty, 6) < 2 || onAsphalt(tx, ty, 1) || nearStream(tx, ty)) continue;
        if (NO_PLANTS.has(areaAt(tx, ty)?.area.kind) || landmarkKindAt(tx, ty) || !treeFree(tx, ty, 5)) continue;
        addTree(tx, ty, between(2.6, 3.4), TREE.street);
      }
    }
  } else {
    // lakóutca: ritkább fasor a füves sávban, hol az egyik, hol a másik oldalon
    let side = rng() < 0.5 ? 1 : -1;
    for (const [x, y, angle] of walkLine(road.pts, 17, 8)) {
      side = -side;
      if (rng() > 0.5) continue;
      const off = half + VERGE / 2;
      const tx = x - Math.sin(angle) * off * side;
      const ty = y + Math.cos(angle) * off * side;
      if (!inMap(tx, ty) || sketchArea(tx, ty) || buildingDist(tx, ty, 6) < 1.8 || onAsphalt(tx, ty, 0.4) || nearStream(tx, ty)) continue;
      if (NO_PLANTS.has(areaAt(tx, ty)?.area.kind) || landmarkKindAt(tx, ty) || !treeFree(tx, ty, 4)) continue;
      addTree(tx, ty, between(2.0, 2.8), TREE.street);
    }
  }

  // villanyoszlopok az út egyik oldalán, vezetékkel összekötve
  let wire = [];
  const flush = () => {
    if (wire.length >= 4) decorWires.push(wire);
    wire = [];
  };
  const poleOff = main ? half + SHOULDER + 1.0 : half + VERGE / 2;
  for (const [x, y, angle] of walkLine(road.pts, 36, 6)) {
    const px = x + Math.sin(angle) * poleOff;
    const py = y - Math.cos(angle) * poleOff;
    const ok = inMap(px, py) && buildingDist(px, py, 5) >= 1 && !onAsphalt(px, py, 0.3) && treeFree(px, py, 1.5) && !landmarkKindAt(px, py);
    if (!ok) {
      flush();
      continue;
    }
    decorPoles.push(r1(px), r1(py));
    wire.push(r1(px), r1(py));
  }
  flush();
}

// kertek, parkok, erdő: 5 méteres rácson, véletlen eltolással
const GRID = 5;
for (let gy = 0; gy < HEIGHT / GRID; gy++) {
  for (let gx = 0; gx < WIDTH / GRID; gx++) {
    const x = (gx + 0.5) * GRID + between(-2, 2);
    const y = (gy + 0.5) * GRID + between(-2, 2);
    const roll = rng();
    const pick = rng();
    const size = rng();
    const info = areaAt(x, y);
    let kind = info?.area.kind ?? null;
    const lm = landmarkKindAt(x, y);
    if (LANDMARK_CLEAR.has(lm) || lm === 'hedge') continue;
    if (lm === 'woodland') kind = 'forest';
    if (NO_PLANTS.has(kind) || kind === 'orchard') continue;
    let treeP = 0.015;
    let bushP = 0.03;
    if (kind === 'residential' || kind === 'garden') [treeP, bushP] = [0.07, 0.085];
    else if (kind === 'park' && info.size >= WOODED_PARK_MIN) {
      // zárt lombú parkerdő, néhány tisztással
      const glade = smoothNoise(x / 45, y / 45) < 0.27;
      [treeP, bushP] = glade ? [0.05, 0.05] : [0.7, 0.06];
      if (!glade) kind = 'forest';
    } else if (GREEN.has(kind)) [treeP, bushP] = [0.12, 0.06];
    else if (kind === 'forest') [treeP, bushP] = [0.75, 0.08];
    else if (kind === 'scrub') [treeP, bushP] = [0.05, 0.55];
    else if (kind === 'allotments') [treeP, bushP] = [0.06, 0.1];
    if (roll >= treeP + bushP) continue;
    const isTree = roll < treeP;
    if (isTree && sketchArea(x, y)) continue;
    if (buildingDist(x, y, 6) < (isTree ? 1.6 : 0.8) || onRoadBand(x, y, isTree ? 0.6 : 0.3) || nearStream(x, y)) continue;
    if (!isTree) {
      decorBushes.push(r1(x), r1(y), r1(0.6 + size * 0.8));
      continue;
    }
    if (!treeFree(x, y, kind === 'forest' ? 3.2 : 4)) continue;
    if (kind === 'forest') addTree(x, y, 2.8 + size * 1.6, pick < 0.85 ? TREE.deciduous : TREE.conifer);
    else if (kind === 'allotments') addTree(x, y, 1.6 + size * 0.7, TREE.fruit);
    else if (GREEN.has(kind)) {
      if (pick < 0.75) addTree(x, y, 2.8 + size * 1.5, TREE.deciduous);
      else addTree(x, y, 1.6 + size * 0.8, TREE.conifer);
    } else if (pick < 0.5) addTree(x, y, 2.1 + size * 1.4, TREE.deciduous);
    else if (pick < 0.72) addTree(x, y, 1.4 + size * 0.8, TREE.conifer);
    else addTree(x, y, 1.6 + size * 0.8, TREE.fruit);
  }
}

// a fotókon látható nyírt sövények: sűrűn ültetett bokrok
for (const ring of landmarks?.hedges ?? []) {
  const [minX, minY, maxX, maxY] = boxOfFlat(ring);
  for (let y = minY; y <= maxY; y += 1.05) {
    for (let x = minX; x <= maxX; x += 1.05) {
      const hx = x + between(-0.25, 0.25);
      const hy = y + between(-0.25, 0.25);
      if (pipFlat(hx, hy, ring) && buildingDist(hx, hy, 3) > 0.3) decorBushes.push(r1(hx), r1(hy), r1(between(0.75, 1.05)));
    }
  }
}

// gyümölcsösök: szabályos sorok
for (const info of areaInfo) {
  if (info.area.kind !== 'orchard') continue;
  const [minX, minY, maxX, maxY] = info.box;
  for (let y = Math.ceil(minY / 6) * 6 + 3; y < maxY; y += 6) {
    for (let x = Math.ceil(minX / 5.5) * 5.5 + 3; x < maxX; x += 5.5) {
      let inside = false;
      for (const ring of info.area.rings) if (pipFlat(x, y, ring)) inside = !inside;
      if (!inside || rng() > 0.93) continue;
      if (buildingDist(x, y, 5) < 1.6 || onRoadBand(x, y, 0.6) || !treeFree(x, y, 3)) continue;
      addTree(x + between(-0.3, 0.3), y + between(-0.3, 0.3), between(1.7, 2.2), TREE.fruit);
    }
  }
}

// --- adatminőségi jelzések ---------------------------------------------------

const unnamedDrivable = roads.filter((r) => DRIVABLE.has(r.kind) && !r.kind.endsWith('_link') && !r.name).length;
if (unnamedDrivable) warn(`${unnamedDrivable} közút-darabnak nincs neve az OSM-ben.`);
if (narrowedRoads) warn(`${narrowedRoads} útdarab a közeli épületek miatt keskenyebb a típusára jellemző szélességnél.`);
if (trimmedBuildings || removedBuildings) warn(`${trimmedBuildings} épület alaprajzát az út széléhez igazítottuk, ${removedBuildings} épület kimaradt, mert az útra esett.`);
const genericBuildings = buildings.filter((b) => b.kind === 'yes' && !b.src).length;

const countBy = (arr) => arr.reduce((m, o) => ((m[o.kind] = (m[o.kind] ?? 0) + 1), m), {});
const stats = {
  buildings: buildings.length,
  buildingsFromOsm: osmBuildingCount,
  buildingsFromMicrosoft: msBuildingCount,
  buildingsWithoutType: genericBuildings,
  buildingKinds: countBy(buildings),
  roads: roads.length,
  roadKinds: countBy(roads),
  streetNames: [...new Set(roads.filter((r) => r.name).map((r) => r.name))].sort((a, b) => a.localeCompare(b, 'hu')),
  areas: areas.length,
  areaKinds: countBy(areas),
  streams: streams.length,
  barriers: barriers.length,
  trees: trees.length,
  pois: pois.length,
  crossings: crossings.length,
  narrowedRoads,
  trimmedBuildings,
  removedBuildings,
  handBuildings,
  handReplaced,
  generatedHouses,
  generatedSheds,
  generatedTrees: decorTrees.length / 4,
  generatedBushes: decorBushes.length / 3,
  generatedPoles: decorPoles.length / 2,
};

const out = {
  meta: {
    name: 'KOZÁRMISLENY',
    attribution: '© OpenStreetMap közreműködők',
    // a kiegészítő épületalaprajzok forrása (null, ha nincs ilyen adat a pályán)
    extraAttribution: msBuildingCount ? 'Épületek egy része: Microsoft Building Footprints (ODbL)' : null,
    extraSource: msMeta ? { name: msMeta.source, url: msMeta.url, license: msMeta.license, fetchedAt: msMeta.fetchedAt } : null,
    // kézzel (vázlatrajz alapján) felvett házak: nem OSM-adat, néhány méter pontosságúak
    handBuildings: handBuildings ? { buildings: handBuildings, replacedFootprints: handReplaced } : null,
    // kitalált (generált) házak: ezekben az utcákban a házak nem valós alaprajzok
    generatedHouses: generatedHouses ? { streets: GENERATED_STREETS, houses: generatedHouses, outbuildings: generatedSheds } : null,
    license: 'ODbL 1.0',
    licenseUrl: 'https://www.openstreetmap.org/copyright',
    osmBaseTimestamp: fetchMeta.osmBaseTimestamp ?? raw.osm3s?.timestamp_osm_base ?? null,
    fetchedAt: fetchMeta.fetchedAt ?? null,
    processedAt: new Date().toISOString(),
    center: { lat: lat0, lon: lon0, osm: `node/${TOWNHALL_NODE_ID}` },
    width: WIDTH,
    height: HEIGHT,
    bounds: BOUNDS,
    units: 'm',
    projection: 'helyi equirectangular közelítés a hivatal pontja körül; nem geodéziai pontosságú',
    note: 'Az útszélességek és az utcakeresztmetszet stilizáltak (játékmenethez igazítva), nem mért adatok. A decor réteg (fák, bokrok, villanyoszlopok) generált, a landmarks réteg fotók alapján kézzel felvett – egyik sem OSM-adat.',
    streetscape: { shoulder: SHOULDER, verge: VERGE, sidewalk: SIDEWALK },
    stats,
    warnings,
  },
  townhall: {
    osm: `node/${TOWNHALL_NODE_ID}`,
    name: th.tags?.name ?? null,
    street: th.tags?.['addr:street'] ?? null,
    x: thX,
    y: thY,
    building: thBuilding ? buildingRef.get(thBuilding.id) : null,
    buildingId: thBuilding ? thBuilding.id : null,
    buildingMatch: thMatch,
    buildingDistance: r2(thNear.dist === Infinity ? -1 : thNear.dist),
  },
  areas,
  streams,
  roads,
  barriers,
  buildings,
  trees,
  pois,
  crossings,
  landmarks,
  decor: {
    generated: true,
    note: 'Generált díszítőelemek (nem OSM-adat).',
    trees: decorTrees,
    bushes: decorBushes,
    poles: decorPoles,
    wires: decorWires,
  },
};

await mkdir(outDir, { recursive: true });
await writeFile(outPath, JSON.stringify(out));

console.log(`Kész: ${path.relative(root, outPath)}  (${WIDTH} × ${HEIGHT} m)`);
console.log(`  épület: ${stats.buildings} = ${osmBuildingCount} OSM (ebből típus nélküli: ${genericBuildings}) + ${msBuildingCount} kiegészítő (Microsoft)`);
console.log(`  útdarab: ${stats.roads}`, stats.roadKinds);
console.log(`  terület: ${stats.areas}`, stats.areaKinds);
console.log(`  patak: ${stats.streams}, kerítés: ${stats.barriers}, fa (OSM): ${stats.trees}, POI: ${stats.pois}`);
console.log(`  hivatal épülete: ${out.townhall.building ?? 'NINCS'} (${thMatch}, ${thNear.dist.toFixed(1)} m)`);
console.log(`  zebra: ${crossings.length}, szűkített útdarab: ${narrowedRoads}, útszélhez igazított épület: ${trimmedBuildings}, kihagyott: ${removedBuildings}, útról letolt tereptárgy: ${movedProps}`);
console.log(`  kézzel felvett ház: ${handBuildings} (kiváltott töredék: ${handReplaced}), generált ház: ${generatedHouses} + ${generatedSheds} melléképület, rajzról felvett fa: ${sketchTrees}`);
console.log(`  generált: ${decorTrees.length / 4} fa, ${decorBushes.length / 3} bokor, ${decorPoles.length / 2} villanyoszlop`);
console.log(`  utcanevek: ${stats.streetNames.length}`);
console.log(`  figyelmeztetések: ${warnings.length}`);
