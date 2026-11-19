// Térképrajzoló: a vektoros pályaadatot közvetlenül pixelekre raszterizálja,
// világkoordinátához kötött mintákkal, így a darabonként (chunkonként) rajzolt
// részek varrat nélkül illeszkednek, és bármilyen felbontásban (pixel/méter)
// kirajzolható. Nincs Phaser-függés: egy Uint32Array pufferbe dolgozik.
//
// Két réteg készül:
//   renderMap    – talaj, utak, épületek (a tank alatt)
//   renderCanopy – lombkoronák és vezetékek (a tank fölött, átlátszó háttérrel)

import { boxesOverlap, MAIN_ROADS, pointInPolygon, STREETS, type GameMap, type Tree } from './GameMap';
import { drawLandmarkAreas, drawLandmarkOverlay, drawLandmarkProps, drawLandmarkRoof, markLandmarkShadows } from './landmarkRaster';
import { c, coverBuf, cssColor, faceBuf, fillRings, forDisc, hash, maskBuf, mottled, scratch, shade, strokeLine, strokeRing, vnoise, type Mat, type Put, type RasterTarget } from './rasterCore';
import type { BuildingFeature, Crossing, LandmarkBuilding } from './types';

export type { RasterTarget } from './rasterCore';

// --- anyagok (felbontásfüggő minták) -------------------------------------------

interface Mats {
  grass: Mat;
  asphalt: Mat;
  asphaltMain: Mat;
  asphaltService: Mat;
  dirt: Mat;
  sidewalk: Mat;
  footway: Mat;
  cycleway: Mat;
  /** zúzottköves padka a főutak mellett */
  shoulder: Mat;
  water: Mat;
  areas: Record<string, Mat>;
}

function buildMats(s: number): Mats {
  const grass = mottled(s, 3.5, 0x57963a, 0x5e9e3f, 0x66a745, 0x76b452, 8);
  const yard = mottled(s, 3, 0x5f9f42, 0x67a747, 0x70b04e, 0x84c05e, 8);
  const meadow = mottled(s, 4, 0x7ba648, 0x86b04e, 0x92ba56, 0xb4ce6a, 14);
  const forestFloor = mottled(s, 2.5, 0x35562c, 0x3c6032, 0x456a38, 0x5c5a34, 24);
  const sand = mottled(s, 2, 0xcbb26c, 0xd6bf78, 0xe0ca86, 0xb8a05c, 20);
  const asphalt = mottled(s, 2.5, 0x4c4c55, 0x52525b, 0x585862, 0x686871, 22);
  const asphaltMain = mottled(s, 2.5, 0x44444d, 0x4a4a53, 0x50505a, 0x60606a, 22);
  const asphaltService = mottled(s, 2.5, 0x66666c, 0x6c6c72, 0x737379, 0x828288, 22);
  const dirt = mottled(s, 2, 0x9a7c50, 0xa6885a, 0xb29464, 0xc2a676, 22);
  const gravel = mottled(s, 2, 0x9c8e70, 0xa89878, 0xb4a484, 0x8a7c60, 40);
  const soilA = c(0x8a6a44);
  const soilB = c(0x9c7a50);
  const veg = c(0x4e8c3a);

  const slab = Math.max(2, Math.round(0.55 * s));
  const slabA = c(0xb9b5a9);
  const slabB = c(0xb1ada1);
  const slabJoint = c(0x9d998e);
  const sidewalk: Mat = (wx, wy) => {
    if (wx % slab === 0 || wy % slab === 0) return slabJoint;
    return hash(Math.floor(wx / slab), Math.floor(wy / slab)) & 1 ? slabA : slabB;
  };

  const frac = (v: number) => v - Math.floor(v);
  const waterDark = c(0x2f6cb8);
  const waterMid = c(0x3a7ac8);
  const waterLight = c(0x6aa6e6);

  const park = mottled(s, 3.5, 0x4f9c40, 0x56a546, 0x5eae4c, 0x7ac25c, 8);
  const flowerA = c(0xf4e060);
  const flowerB = c(0xf08aa0);

  const areas: Record<string, Mat> = {
    residential: yard,
    garden: yard,
    cemetery: yard,
    orchard: yard,
    grass,
    meadow,
    scrub: meadow,
    forest: forestFloor,
    industrial: gravel,
    playground: sand,
    farmland: (wx, wy) => {
      const field = vnoise(wx / (s * 30), wy / (s * 30)) > 0.5;
      const furrow = frac((wx + wy * 2) / (s * 1.3)) < 0.38;
      if ((hash(wx, wy) & 63) === 0) return c(0xd8bc70);
      if (field) return furrow ? c(0xb08c46) : c(0xc6a558);
      return furrow ? c(0xa88a4c) : c(0xbc9e5e);
    },
    allotments: (wx, wy) => {
      const pw = 11 * s;
      const ph = 8 * s;
      const lx = wx - Math.floor(wx / pw) * pw;
      const ly = wy - Math.floor(wy / ph) * ph;
      if (lx < 0.4 * s || ly < 0.4 * s) return dirt(wx, wy);
      const kind = hash(Math.floor(wx / pw), Math.floor(wy / ph)) % 5;
      if (kind === 0) return frac(wy / s) < 0.5 ? soilA : soilB; // felásott ágyás
      if (kind === 1) return frac(wx / (s * 0.8)) < 0.35 ? veg : soilA; // veteménysorok
      if (kind === 2) return meadow(wx, wy);
      return yard(wx, wy);
    },
    recreation: (wx, wy) => {
      const base = park(wx, wy);
      return Math.floor((wx + wy) / (4 * s)) & 1 ? shade(base, 1.06) : base;
    },
    park: (wx, wy) => {
      const h = hash(wx * 5 + 3, wy * 3 + 11) & 4095;
      if (h < 3) return flowerA;
      if (h < 5) return flowerB;
      return park(wx, wy);
    },
    pitch: (wx, wy) => {
      const base = park(wx, wy);
      return Math.floor(wx / (5 * s)) & 1 ? shade(base, 1.07) : base;
    },
    parking: (wx, wy) => {
      const bay = Math.round(2.6 * s);
      const row = Math.round(11 * s);
      if (wx % bay < Math.max(1, Math.round(0.12 * s)) && wy % row < 5 * s) return c(0xd0d0d4);
      return asphaltService(wx, wy);
    },
    square: (wx, wy) => {
      const q = Math.max(2, Math.round(0.5 * s));
      if (wx % q === 0 || wy % q === 0) return c(0xa89c82);
      return (Math.floor(wx / q) + Math.floor(wy / q)) & 1 ? c(0xc8bca0) : c(0xbcae90);
    },
    water: (wx, wy) => {
      const v = vnoise(wx / (s * 1.6), wy / (s * 0.5));
      if (v > 0.74) return waterLight;
      return v < 0.3 ? waterDark : waterMid;
    },
    pool: (wx, wy) => (vnoise(wx / (s * 0.7), wy / (s * 0.7)) > 0.66 ? c(0xb0ecfc) : c(0x58c8e8)),
  };

  return {
    grass,
    asphalt,
    asphaltMain,
    asphaltService,
    dirt,
    sidewalk,
    footway: mottled(s, 1.5, 0xc4b890, 0xcec29a, 0xd8cca4, 0xb0a47c, 30),
    // a kerékpárút a fotók szerint szürke aszfalt
    cycleway: mottled(s, 2, 0x5c5c64, 0x62626a, 0x696971, 0x77777f, 20),
    shoulder: mottled(s, 1.5, 0x98927f, 0xa39d8b, 0xaea897, 0x86806c, 40),
    water: areas.water,
    areas,
  };
}

const matsCache = new Map<number, Mats>();
function matsFor(s: number): Mats {
  let m = matsCache.get(s);
  if (!m) {
    m = buildMats(s);
    matsCache.set(s, m);
  }
  return m;
}

const AREA_FLAT: Record<string, number> = {
  residential: c(0x68a646), farmland: c(0xc9a85a), meadow: c(0x86b04e), industrial: c(0xa89878),
  forest: c(0x2f6e36), scrub: c(0x538e40), orchard: c(0x4e9c40), allotments: c(0x7a9448),
  cemetery: c(0x5a9244), recreation: c(0x62b24e), park: c(0x56a648), grass: c(0x5c9c3e),
  garden: c(0x68a646), pitch: c(0x52ac48), playground: c(0xd8c078), parking: c(0x74747c),
  square: c(0xc8bca0), water: c(0x3c7ccc), pool: c(0x58c8e8),
};

// --- utak --------------------------------------------------------------------

/** Lakóutcák, amelyek mellé járda kerül (a külterületi összekötő utak mellé nem). */
const SIDEWALK_KINDS = new Set(['residential', 'living_street']);
const MINOR_KINDS = new Set(['path', 'footway', 'steps', 'cycleway', 'track']);
/** Felezővonalas utak. */
const MARKED_KINDS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);

function asphaltFor(m: Mats, kind: string): Mat {
  if (kind === 'service' || kind === 'pedestrian') return m.asphaltService;
  return MAIN_ROADS.has(kind) ? m.asphaltMain : m.asphalt;
}

// --- tetők -------------------------------------------------------------------

interface RoofStyle {
  flat: boolean;
  base: number;
  /** világos szegély (0 = nincs) – a hivatal kiemeléséhez */
  rim: number;
}

const tile = (hex: number): RoofStyle => ({ flat: false, base: c(hex), rim: 0 });
const flatRoof = (hex: number): RoofStyle => ({ flat: true, base: c(hex), rim: 0 });

// A hazai tetőkre jellemző színek: égetett cserép vörös-barna árnyalatai, kevés antracit és szürke.
const TILE_ROOFS: RoofStyle[] = [
  tile(0xb9583a), tile(0xb9583a), tile(0xa94e36), tile(0xa94e36), tile(0xc0634a), tile(0xb24a3c),
  tile(0x9a4a34), tile(0x8a4a38), tile(0xc27444), tile(0x7c4a3a), tile(0x565a60), tile(0x84868a),
];
const FLAT_ROOFS: RoofStyle[] = [flatRoof(0xa4a4a8), flatRoof(0x9c9688), flatRoof(0x8e9096)];
const SHED_ROOFS: RoofStyle[] = [flatRoof(0x8a8a90), flatRoof(0x7e7870), tile(0x8a5a44), flatRoof(0x9a9a9e)];
const CHURCH_ROOF = tile(0xb24a34);
const TOWNHALL_MINI = c(0xffd84a);

const FLAT_KINDS = new Set(['retail', 'industrial', 'commercial', 'warehouse', 'roof', 'carport', 'shelter']);
const SHED_KINDS = new Set(['garage', 'garages', 'shed', 'hut']);

function roofStyle(b: BuildingFeature, spec?: LandmarkBuilding): RoofStyle {
  // fotó alapján megadott tetőszín
  if (spec) return { flat: false, base: cssColor(spec.roofColor), rim: 0 };
  if (b.kind === 'church' || b.kind === 'chapel') return CHURCH_ROOF;
  const h = hash(b.id & 0xffff, (b.id / 65536) | 0);
  if (SHED_KINDS.has(b.kind) || b.area < 28) return SHED_ROOFS[h % SHED_ROOFS.length];
  if (FLAT_KINDS.has(b.kind) || b.area > 900) return FLAT_ROOFS[h % FLAT_ROOFS.length];
  return TILE_ROOFS[h % TILE_ROOFS.length];
}

/** Az épület vetett árnyékának hossza méterben (a magasság becslése a típusból). */
function shadowLength(b: BuildingFeature, spec?: LandmarkBuilding): number {
  if (spec?.shadow) return spec.shadow;
  if (b.kind === 'church' || b.townhall) return 2.6;
  if (b.kind === 'apartments' || b.area > 350) return 2.2;
  if (SHED_KINDS.has(b.kind) || b.area < 28) return 0.8;
  return 1.4;
}

// --- épületek ------------------------------------------------------------------

interface Edge {
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  len: number;
  /** megvilágítás: 1 = a fény felé néző tetősík, −1 = árnyékos */
  light: number;
  prev: number;
  next: number;
  /** homorú (befelé törő) sarok van-e az él kezdőpontjánál */
  reflexStart: boolean;
}

function buildEdges(rings: ArrayLike<number>[], s: number): Edge[] {
  const edges: Edge[] = [];
  rings.forEach((r, ringIndex) => {
    // egymást követő azonos pontok kiszűrése
    const pts: number[] = [];
    for (let i = 0; i + 1 < r.length; i += 2) {
      const x = r[i] * s;
      const y = r[i + 1] * s;
      const n = pts.length;
      if (n >= 2 && Math.hypot(pts[n - 2] - x, pts[n - 1] - y) < 0.01) continue;
      pts.push(x, y);
    }
    // zárt gyűrű megismételt záró pontja nem kell
    if (pts.length >= 4 && Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]) < 0.01) pts.length -= 2;
    const n = pts.length / 2;
    if (n < 3) return;
    let area = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
    // a kifelé mutató normális előjele; a lyukaknál fordított
    const sign = (area > 0 ? 1 : -1) * (ringIndex > 0 ? -1 : 1);
    const first = edges.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = pts[j * 2] - pts[i * 2];
      const dy = pts[j * 2 + 1] - pts[i * 2 + 1];
      const len = Math.hypot(dx, dy) || 1e-6;
      const nx = (sign * dy) / len;
      const ny = (-sign * dx) / len;
      edges.push({
        ax: pts[i * 2],
        ay: pts[i * 2 + 1],
        dx,
        dy,
        len,
        light: -(nx + ny) * 0.7071, // a fény ÉNy-ról jön
        prev: first + ((i + n - 1) % n),
        next: first + j,
        reflexStart: false,
      });
    }
    for (let i = first; i < first + n; i++) {
      const p = edges[edges[i].prev];
      const e = edges[i];
      e.reflexStart = (p.dx * e.dy - p.dy * e.dx) * sign < 0;
    }
  });
  return edges;
}

// roofAt() eredménye (objektumfoglalás nélkül)
let roofH = 0;
let roofFace = 0;
let roofAlong = 0;

/**
 * A tető „magassága" (az eresztől mért távolság pixelben) és a tetősík egy
 * pontban. Kontyolt tetőnél a sokszög egyenes váza szerinti síkokat közelíti
 * (homorú saroknál vápával); nyeregtetőnél csak a két hosszanti eresz számít.
 */
function roofAt(edges: Edge[], gable: [number, number] | null, px: number, py: number): void {
  if (gable) {
    let best = Infinity;
    for (const i of gable) {
      const e = edges[i];
      const d = Math.abs((px - e.ax) * e.dy - (py - e.ay) * e.dx) / e.len;
      if (d < best) {
        best = d;
        roofFace = i;
      }
    }
    roofH = best;
  } else {
    let best = Infinity;
    let bi = 0;
    let corner = 0; // 0: az él belseje, 1: a kezdőpontja, 2: a végpontja a legközelebbi
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const ex = px - e.ax;
      const ey = py - e.ay;
      const u = (ex * e.dx + ey * e.dy) / (e.len * e.len);
      let d: number;
      let where = 0;
      if (u < 0) {
        d = Math.sqrt(ex * ex + ey * ey);
        where = 1;
      } else if (u > 1) {
        d = Math.hypot(ex - e.dx, ey - e.dy);
        where = 2;
      } else {
        d = Math.abs(ex * e.dy - ey * e.dx) / e.len;
      }
      if (d < best) {
        best = d;
        bi = i;
        corner = where;
      }
    }
    if (corner) {
      // homorú saroknál a két szomszédos eresz síkja közül a távolabbi érvényes (vápa)
      const e = edges[bi];
      const otherIndex = corner === 1 ? e.prev : e.next;
      const reflex = corner === 1 ? e.reflexStart : edges[e.next].reflexStart;
      if (reflex) {
        const o = edges[otherIndex];
        const d1 = Math.abs((px - e.ax) * e.dy - (py - e.ay) * e.dx) / e.len;
        const d2 = Math.abs((px - o.ax) * o.dy - (py - o.ay) * o.dx) / o.len;
        if (d2 > d1) {
          bi = otherIndex;
          best = d2;
        } else {
          best = d1;
        }
      }
    }
    roofH = best;
    roofFace = bi;
  }
  const f = edges[roofFace];
  roofAlong = ((px - f.ax) * f.dx + (py - f.ay) * f.dy) / f.len;
}

function drawBuilding(t: RasterTarget, b: BuildingFeature, seq: number, spec?: LandmarkBuilding): void {
  const style = roofStyle(b, spec);
  const { buf } = t;
  const s = t.scale;
  const rings = b.holes ? [b.pts, ...b.holes] : [b.pts];

  if (!t.detail) {
    const color = b.townhall ? TOWNHALL_MINI : style.flat ? c(0x9a9aa0) : style.base;
    fillRings(t, rings, 0, 0, (idx) => {
      buf[idx] = color;
    });
    return;
  }

  // a fotók alapján felvett épületek saját tetőformát kapnak
  if (spec?.parts) {
    drawLandmarkRoof(t, b, spec, seq);
    return;
  }

  const edges = buildEdges(rings, s);
  if (edges.length < 3) return;
  const seed = hash(b.id & 0xffff, 77);
  const outlinePx = Math.max(1, 0.12 * s);
  const outline = shade(style.base, 0.42);

  if (style.flat) {
    // lapostető: világos attika, szemcsés burkolat
    const parapet = shade(style.base, 1.22);
    const parapetPx = 0.38 * s;
    const inner = shade(style.base, 0.9);
    fillRings(t, rings, 0, 0, (idx, wx, wy) => {
      roofAt(edges, null, wx + 0.5, wy + 0.5);
      if (roofH < outlinePx) buf[idx] = outline;
      else if (roofH < parapetPx) buf[idx] = parapet;
      else if (roofH < parapetPx + outlinePx) buf[idx] = inner;
      else {
        const g = hash(wx, wy) & 15;
        buf[idx] = g === 0 ? shade(style.base, 1.1) : g < 4 ? shade(style.base, 0.94) : style.base;
      }
    });
    return;
  }

  // nyeregtető az egyszerű, négyszög alaprajzú házak nagyobb részén; különben kontyolt tető
  let gable: [number, number] | null = null;
  const wantGable = spec?.roofType ? spec.roofType === 'gable' : seed % 100 < 65;
  if (edges.length === 4 && rings.length === 1 && wantGable) {
    gable = edges[0].len + edges[2].len >= edges[1].len + edges[3].len ? [0, 2] : [1, 3];
  }

  // tetősíkonként négy árnyalat: alap, sötétebb és világosabb cserép, cserépsor árnyéka
  const faceColors = new Uint32Array(edges.length * 4);
  edges.forEach((e, i) => {
    const lit = shade(style.base, 0.8 + 0.3 * e.light);
    faceColors[i * 4] = lit;
    faceColors[i * 4 + 1] = shade(lit, 0.91);
    faceColors[i * 4 + 2] = shade(lit, 1.07);
    faceColors[i * 4 + 3] = shade(lit, 0.8);
  });
  const ridge = shade(style.base, 0.6);
  const coursePx = Math.max(2, Math.round(0.33 * s));
  const tilePx = Math.max(2, Math.round(0.25 * s));
  const rimPx = style.rim ? 0.45 * s : 0;
  const w = t.w;

  fillRings(t, rings, 0, 0, (idx, wx, wy) => {
    roofAt(edges, gable, wx + 0.5, wy + 0.5);
    const id = seq * 64 + (roofFace & 63) + 1;
    faceBuf[idx] = id;
    if (roofH < outlinePx) {
      buf[idx] = outline;
      return;
    }
    if (roofH < rimPx) {
      buf[idx] = style.rim;
      return;
    }
    // gerinc, élgerinc és vápa: ahol két tetősík találkozik
    const left = idx % w > 0 ? faceBuf[idx - 1] : 0;
    const up = idx >= w ? faceBuf[idx - w] : 0;
    if ((left && left !== id && (left - 1) >> 6 === seq) || (up && up !== id && (up - 1) >> 6 === seq)) {
      buf[idx] = ridge;
      return;
    }
    // cserépsorok az eresszel párhuzamosan, soronként fél cseréppel eltolva
    const course = Math.floor(roofH / coursePx);
    const base = roofFace * 4;
    if (roofH - course * coursePx < 1) {
      buf[idx] = faceColors[base + 3];
      return;
    }
    const col = Math.floor((roofAlong + (course & 1) * tilePx * 0.5) / tilePx);
    const v = hash(col + roofFace * 131, course + seed) & 7;
    buf[idx] = faceColors[base + (v === 0 ? 1 : v === 1 ? 2 : 0)];
  });

  // kémény a lakóházakon, a gerinc közelében
  if (b.area > 45 && !spec && b.kind !== 'church') {
    let longest = edges[0];
    for (const e of edges) if (e.len > longest.len) longest = e;
    let cx = 0;
    let cy = 0;
    for (const e of edges) {
      cx += e.ax;
      cy += e.ay;
    }
    cx /= edges.length;
    cy /= edges.length;
    const side = seed & 1 ? 1 : -1;
    for (const k of [0.2, -0.2, 0.33, -0.33, 0]) {
      const px = cx + (longest.dx / longest.len) * longest.len * k * side;
      const py = cy + (longest.dy / longest.len) * longest.len * k * side;
      if (!pointInPolygon(px / s, py / s, b.pts)) continue;
      roofAt(edges, gable, px, py);
      if (roofH < 1.1 * s) continue;
      const half = 0.36 * s;
      const sh = 0.55 * s;
      forDisc(t, px + sh / 2, py + sh / 2, half + sh, (idx, dx, dy) => {
        const inBox = Math.abs(dx + sh / 2) <= half && Math.abs(dy + sh / 2) <= half;
        if (inBox) {
          const edge = Math.max(Math.abs(dx + sh / 2), Math.abs(dy + sh / 2));
          buf[idx] = edge > half - 1.2 ? c(0x4a342c) : edge > half - 2.6 ? c(0xa87460) : c(0x241c1a);
        } else if (dx + sh / 2 > -half && dy + sh / 2 > -half && Math.abs(dx - sh / 2) <= half && Math.abs(dy - sh / 2) <= half) {
          buf[idx] = shade(buf[idx], 0.62);
        }
      });
      break;
    }
  }
}

// --- kisebb elemek ---------------------------------------------------------------

function drawCrossing(t: RasterTarget, cr: Crossing): void {
  const s = t.scale;
  const { buf } = t;
  const cos = Math.cos(cr.angle);
  const sin = Math.sin(cr.angle);
  const halfLen = 1.7 * s; // a zebra mérete az út hosszában
  const halfW = (cr.width / 2 - 0.4) * s;
  const stripe = 0.5 * s;
  forDisc(t, cr.x * s, cr.y * s, Math.hypot(halfLen, halfW), (idx, dx, dy, wx, wy) => {
    const u = dx * cos + dy * sin;
    const v = dy * cos - dx * sin;
    if (Math.abs(u) > halfLen || Math.abs(v) > halfW) return;
    if (Math.floor((v + halfW) / stripe) & 1) return;
    buf[idx] = (hash(wx, wy) & 15) === 0 ? c(0xcfcfc8) : c(0xeeeee6);
  });
}

function drawBush(t: RasterTarget, x: number, y: number, r: number, seed: number): void {
  const s = t.scale;
  const { buf } = t;
  const rp = r * s;
  const k = 1 / (0.45 * s);
  const tones = seed & 1 ? [c(0x2a5f26), c(0x3a7a30), c(0x4e963c)] : [c(0x2f6428), c(0x44843a), c(0x5da248)];
  forDisc(t, x * s, y * s, rp + 1, (idx, dx, dy, wx, wy) => {
    const d = Math.sqrt(dx * dx + dy * dy);
    const edge = rp * (0.78 + 0.22 * vnoise(wx * k + seed, wy * k));
    if (d > edge) return;
    if (d > edge - Math.max(1, 0.1 * s)) {
      buf[idx] = c(0x1e4a20);
      return;
    }
    const v = 0.5 - ((dx + dy) / (rp * 1.4142)) * 0.4 + (vnoise(wx * k * 1.7, wy * k * 1.7 + seed) - 0.5) * 0.6;
    buf[idx] = v < 0.36 ? tones[0] : v < 0.62 ? tones[1] : tones[2];
  });
}

const CANOPY_TONES: number[][] = [
  [0x1f4d22, 0x2d6a2c, 0x3c8436, 0x55a045],
  [0x2a5220, 0x3b6e2a, 0x4f8a34, 0x6aa344],
  [0x1c4a2a, 0x29663a, 0x378048, 0x4d9c5a],
  [0x3a5a1e, 0x557a26, 0x739a30, 0x97b83e],
  [0x5a601c, 0x7c8426, 0x9ea632, 0xc0c248],
].map((row) => row.map(c));
// a zöld árnyalatok gyakoribbak, a sárgás lombú fa ritkább
const CANOPY_PICK = [0, 0, 1, 1, 2, 2, 0, 3, 3, 4];
const CONIFER_TONES = [0x10332a, 0x1a4a36, 0x245e42, 0x34784f].map(c);
const FRUIT_TONES = [0x2c5a22, 0x41792c, 0x5a963a, 0x78b24c].map(c);
const STREET_TONES = [0x23521f, 0x34702a, 0x478c36, 0x62a846].map(c);

function drawCanopy(t: RasterTarget, tree: Tree, seed: number): void {
  const s = t.scale;
  const { buf } = t;
  const rp = tree.r * s;
  const conifer = tree.kind === 1;
  const tones = conifer ? CONIFER_TONES : tree.kind === 2 ? FRUIT_TONES : tree.kind === 3 ? STREET_TONES : CANOPY_TONES[CANOPY_PICK[seed % CANOPY_PICK.length]];
  const lobes = 1.4 + (seed % 5) * 0.25;
  const phase = (seed & 255) / 40;
  const k = 1 / (0.42 * s);
  const edgePx = Math.max(1, 0.1 * s);
  const tier = 0.5 * s;
  forDisc(t, tree.x * s, tree.y * s, rp + 1, (idx, dx, dy, wx, wy) => {
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > rp) return;
    // fenyő: csillag alakú korona; lombos fa: szabálytalan, karéjos körvonal
    const inv = 1 / (d || 1);
    const edge = conifer
      ? rp * (0.72 + 0.28 * Math.abs(Math.sin(Math.atan2(dy, dx) * 4 + phase)))
      : rp * (0.74 + 0.26 * vnoise(dx * inv * lobes + phase, dy * inv * lobes + phase * 1.7));
    if (d > edge) return;
    if (d > edge - edgePx) {
      buf[idx] = tones[0];
      return;
    }
    const q = d / edge;
    let v = 0.5 - ((dx + dy) / (rp * 1.4142)) * 0.32 + (vnoise(wx * k + seed, wy * k + seed * 3) - 0.5) * 0.7 - q * q * q * 0.22;
    if (conifer) v += Math.floor(d / tier) & 1 ? -0.14 : 0.1;
    buf[idx] = tones[v < 0.3 ? 0 : v < 0.52 ? 1 : v < 0.74 ? 2 : 3];
  });
}

// --- a talajréteg ----------------------------------------------------------------

/** A kép területe méterben, ráhagyással (árnyékok, lombkoronák, vonalvastagság). */
function viewBox(t: RasterTarget, pad: number): [number, number, number, number] {
  const s = t.scale;
  return [t.ox / s - pad, t.oy / s - pad, (t.ox + t.w) / s + pad, (t.oy + t.h) / s + pad];
}

export function renderMap(map: GameMap, t: RasterTarget): void {
  const { data } = map;
  const { buf, scale: s, detail } = t;
  const m = matsFor(s);
  const [minX, minY, maxX, maxY] = viewBox(t, detail ? 8 : 8 / s + 2);
  const visible = (box: [number, number, number, number]) => boxesOverlap(box, minX, minY, maxX, maxY);
  const inView = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  const worldW = map.width * s;
  const worldH = map.height * s;
  scratch(t.w * t.h);

  // a térbeli indexekből csak a kép közelében lévő elemek kerülnek elő
  const buildings = map.buildingIndex
    .query(minX, minY, maxX, maxY)
    .filter((n) => visible(map.buildingBoxes[n]))
    .map((n) => data.buildings[n]);
  const specOf = (b: BuildingFeature): LandmarkBuilding | undefined => map.landmarkBuildings.get(b.id);

  // Takarékosság: ahol tető lesz, ott a talajt nem számoljuk ki, a füvet pedig
  // csak oda rajzoljuk, ahová más felület nem került (a 0 érték jelzi az üres pixelt).
  if (detail) {
    for (const b of buildings) {
      fillRings(t, b.holes ? [b.pts, ...b.holes] : [b.pts], 0, 0, (idx) => {
        coverBuf[idx] = 1;
      });
    }
  }

  // 1. a pályán kívüli rész sötét; belül egyelőre üres
  const baseFlat = c(0x5c9c3e);
  const outside = c(0x101418);
  for (let j = 0; j < t.h; j++) {
    const wy = t.oy + j;
    for (let i = 0; i < t.w; i++) {
      const wx = t.ox + i;
      const inside = wx >= 0 && wy >= 0 && wx < worldW && wy < worldH;
      buf[j * t.w + i] = !inside ? outside : detail ? 0 : baseFlat;
    }
  }
  const clipPut = (mat: Mat): Put => (idx, wx, wy) => {
    if (coverBuf[idx]) return;
    if (wx >= 0 && wy >= 0 && wx < worldW && wy < worldH) buf[idx] = mat(wx, wy);
  };
  /** Fű mindenhová, ami még üres (fedett pixelekre csak akkor, ha kérjük). */
  const fillEmpty = (includeCovered: boolean): void => {
    for (let j = 0; j < t.h; j++) {
      for (let i = 0; i < t.w; i++) {
        const idx = j * t.w + i;
        if (buf[idx] === 0 && (includeCovered || !coverBuf[idx])) buf[idx] = m.grass(t.ox + i, t.oy + j);
      }
    }
  };

  // 2. területek
  data.areas.forEach((a, n) => {
    if (!visible(map.areaBoxes[n])) return;
    const flatColor = AREA_FLAT[a.kind] ?? baseFlat;
    const mat: Mat = detail ? (m.areas[a.kind] ?? m.grass) : () => flatColor;
    fillRings(t, a.rings, 0, 0, clipPut(mat));
  });

  if (detail) {
    drawLandmarkAreas(map, t, 'under');
    fillEmpty(false);
  }

  // 3. patakok
  data.streams.forEach((st, n) => {
    if (!visible(map.streamBoxes[n])) return;
    const hw = Math.max((st.width * s) / 2, 0.6);
    const bank = Math.max(1, 0.15 * s);
    strokeLine(t, st.pts, hw, (idx, wx, wy, d) => {
      buf[idx] = !detail ? AREA_FLAT.water : d > hw - bank ? c(0x2c5c9c) : m.water(wx, wy);
    });
  });

  // 4. utak
  const roads = data.roads.map((road, n) => ({ road, n })).filter(({ n }) => visible(map.roadBoxes[n]));
  if (detail) {
    const line = Math.max(1, Math.round(0.14 * s));
    const street = data.meta.streetscape;
    for (const { road } of roads) {
      if (!MINOR_KINDS.has(road.kind)) continue;
      const hw = (road.width * s) / 2;
      if (road.kind === 'track') {
        strokeLine(t, road.pts, hw, (idx, wx, wy, d) => {
          const rut = d > hw * 0.35 && d < hw * 0.7;
          buf[idx] = rut ? shade(m.dirt(wx, wy), 0.84) : m.dirt(wx, wy);
        });
      } else {
        const mat = road.kind === 'cycleway' ? m.cycleway : road.kind === 'path' ? m.dirt : m.footway;
        strokeLine(t, road.pts, hw, (idx, wx, wy, d) => {
          buf[idx] = d > hw - line ? shade(mat(wx, wy), 0.86) : mat(wx, wy);
        });
      }
    }
    // lakóutcák: az úttest és a járda között füves sáv marad
    for (const { road } of roads) {
      if (!SIDEWALK_KINDS.has(road.kind)) continue;
      const inner = (road.width / 2 + street.verge) * s;
      const outer = inner + street.sidewalk * s;
      strokeRing(t, road.pts, inner, outer, (idx, wx, wy, d) => {
        buf[idx] = d > outer - line || d < inner + line ? c(0x8f8b80) : m.sidewalk(wx, wy);
      });
    }
    // főutak: járda helyett zúzottköves padka
    for (const { road } of roads) {
      if (!MAIN_ROADS.has(road.kind)) continue;
      strokeLine(t, road.pts, (road.width / 2 + street.shoulder) * s, (idx, wx, wy) => {
        buf[idx] = m.shoulder(wx, wy);
      });
    }
    for (const { road } of roads) {
      if (MINOR_KINDS.has(road.kind)) continue;
      const hw = (road.width * s) / 2;
      const mat = asphaltFor(m, road.kind);
      const edge = STREETS.has(road.kind) || MAIN_ROADS.has(road.kind) ? c(0x3e3e46) : c(0x55555b);
      strokeLine(t, road.pts, hw, (idx, wx, wy, d) => {
        buf[idx] = d > hw - line ? edge : mat(wx, wy);
      });
    }
    // a kereszteződésekben a szegélyt újra aszfalt fedi
    for (const { road } of roads) {
      if (MINOR_KINDS.has(road.kind)) continue;
      const mat = asphaltFor(m, road.kind);
      strokeLine(t, road.pts, (road.width * s) / 2 - line, (idx, wx, wy) => {
        buf[idx] = mat(wx, wy);
      });
    }
    // felezővonal a főúton: 3 m vonal, 6 m köz
    for (const { road } of roads) {
      if (!MARKED_KINDS.has(road.kind)) continue;
      strokeLine(t, road.pts, Math.max(0.75, 0.07 * s), (idx, _wx, _wy, _d, along) => {
        if (along % (9 * s) < 3 * s) buf[idx] = c(0xe8e6d8);
      });
    }
    for (const cr of data.crossings) {
      if (inView(cr.x, cr.y)) drawCrossing(t, cr);
    }
    // a burkolt terek az odavezető gyalogutak fölé kerülnek
    drawLandmarkAreas(map, t, 'over');
  } else {
    for (const { road } of roads) {
      if (MINOR_KINDS.has(road.kind) && road.kind !== 'track') {
        strokeLine(t, road.pts, 0.5, (idx) => {
          buf[idx] = c(0xd2c8a6);
        });
      }
    }
    for (const { road } of roads) {
      if (MINOR_KINDS.has(road.kind) && road.kind !== 'track') continue;
      const hw = Math.max((road.width * s) / 2, 0.8);
      const color = MAIN_ROADS.has(road.kind) ? c(0xffe9a0) : road.kind === 'track' ? c(0xb89a6a) : c(0xf0ece0);
      strokeLine(t, road.pts, hw, (idx) => {
        buf[idx] = color;
      });
    }
  }

  // 5. kerítések, falak, sövények
  data.barriers.forEach((b, n) => {
    if (!visible(map.barrierBoxes[n])) return;
    const color = b.kind === 'hedge' ? c(0x2f6e36) : b.kind === 'wall' ? c(0x8c8c90) : c(0x6a4a2a);
    strokeLine(t, b.pts, detail ? Math.max(1, 0.1 * s) : 0.5, (idx) => {
      buf[idx] = color;
    });
  });

  if (detail) {
    const trees = map.treeIndex.query(minX, minY, maxX, maxY).map((i) => map.trees[i]);
    const bushes = data.decor.bushes;
    const poles = data.decor.poles;
    const poleIds = map.poleIndex.query(minX, minY, maxX, maxY);

    // 6. bokrok
    for (const n of map.bushIndex.query(minX, minY, maxX, maxY)) {
      drawBush(t, bushes[n * 3], bushes[n * 3 + 1], bushes[n * 3 + 2], hash(n * 3, 313));
    }

    // 7. vetett árnyékok (épületek, fák, oszlopok) – maszkba gyűjtve, hogy az átfedés ne sötétedjen kétszer
    const mark: Put = (idx) => {
      maskBuf[idx] = 1;
    };
    for (const b of buildings) {
      const len = shadowLength(b, specOf(b)) * s;
      for (let step = 1; step <= 3; step++) fillRings(t, [b.pts], (len * step) / 3, (len * step) / 3, mark);
    }
    for (const tree of trees) {
      const off = (tree.r * 0.35 + 0.5) * s;
      const rp = tree.r * 0.9 * s;
      forDisc(t, tree.x * s + off, tree.y * s + off, rp, (idx, dx, dy) => {
        if (dx * dx + dy * dy <= rp * rp) maskBuf[idx] = 1;
      });
    }
    for (const n of poleIds) {
      const x = poles[n * 2];
      const y = poles[n * 2 + 1];
      strokeLine(t, [x, y, x + 2.6, y + 2.6], Math.max(0.75, 0.08 * s), mark);
    }
    markLandmarkShadows(map, t);
    for (let idx = 0; idx < maskBuf.length; idx++) {
      if (maskBuf[idx] && buf[idx] !== 0) buf[idx] = shade(buf[idx], 0.68);
    }

    // 8. fatörzsek és (beton) villanyoszlopok
    for (const tree of trees) {
      const rp = 0.28 * s;
      forDisc(t, tree.x * s, tree.y * s, rp, (idx, dx, dy) => {
        if (dx * dx + dy * dy <= rp * rp) buf[idx] = c(0x4a3424);
      });
    }
    for (const n of poleIds) {
      const rp = 0.24 * s;
      forDisc(t, poles[n * 2] * s, poles[n * 2 + 1] * s, rp, (idx, dx, dy) => {
        const d2 = dx * dx + dy * dy;
        if (d2 <= rp * rp) buf[idx] = d2 < rp * rp * 0.35 ? c(0xc6c6ca) : c(0x5e5e64);
      });
    }
    drawLandmarkProps(map, t);
  }

  // 9. épületek (a minitérképen az összes, egyszerűsítve)
  if (detail) {
    buildings.forEach((b, i) => drawBuilding(t, b, i + 1, specOf(b)));
    // biztonsági háló: ha egy fedettnek jelölt pixelre mégsem került tető
    fillEmpty(true);
  } else {
    for (const b of buildings) drawBuilding(t, b, 0);
  }
}

// --- a lombréteg -------------------------------------------------------------------

/**
 * Lombkoronák és vezetékek átlátszó háttérrel (a tank fölé kerülő réteg).
 * Visszaadja, hogy került-e bármi a képre.
 */
export function renderCanopy(map: GameMap, t: RasterTarget): boolean {
  const { buf, scale: s } = t;
  buf.fill(0);
  const [minX, minY, maxX, maxY] = viewBox(t, 6);
  let drawn = false;

  // a vezeték átlátszatlan: a lombrétegben így csak teljesen átlátszó vagy teljesen fedő pixel van
  const wire = c(0x34343a);
  for (const line of map.data.decor.wires) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const ax = line[i];
      const ay = line[i + 1];
      const bx = line[i + 2];
      const by = line[i + 3];
      if (Math.max(ax, bx) < minX || Math.min(ax, bx) > maxX || Math.max(ay, by) < minY || Math.min(ay, by) > maxY) continue;
      strokeLine(t, [ax, ay, bx, by], Math.max(0.6, 0.05 * s), (idx) => {
        buf[idx] = wire;
        drawn = true;
      });
    }
  }

  for (const n of map.treeIndex.query(minX, minY, maxX, maxY)) {
    const tree = map.trees[n];
    if (tree.x < minX || tree.x > maxX || tree.y < minY || tree.y > maxY) continue;
    drawCanopy(t, tree, hash(n, 991));
    drawn = true;
  }
  if (drawLandmarkOverlay(map, t)) drawn = true;
  return drawn;
}
