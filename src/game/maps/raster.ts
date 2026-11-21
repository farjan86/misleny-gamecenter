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
import { c, coverBuf, cssColor, faceBuf, fillRings, forDisc, hash, maskBuf, mix, mottled, scratch, shade, strokeLine, strokeRing, vnoise, type Mat, type Put, type RasterTarget } from './rasterCore';
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

  const frac = (v: number) => v - Math.floor(v);
  const slab = Math.max(2, Math.round(0.55 * s));
  const slabA = c(0xb9b5a9);
  const slabB = c(0xb1ada1);
  const slabJoint = c(0x9d998e);
  const sidewalk: Mat = (wx, wy) => {
    if (wx % slab === 0 || wy % slab === 0) return slabJoint;
    return hash(Math.floor(wx / slab), Math.floor(wy / slab)) & 1 ? slabA : slabB;
  };

  const waterDark = c(0x2f6cb8);
  const waterMid = c(0x3a7ac8);
  const waterLight = c(0x6aa6e6);

  const park = mottled(s, 3.5, 0x4f9c40, 0x56a546, 0x5eae4c, 0x7ac25c, 8);
  const flowerA = c(0xf4e060);
  const flowerB = c(0xf08aa0);

  // A kertek részletei 6 méteres cellákban: a cellák egy részébe virágágyás,
  // veteményes vagy burkolt terasz kerül (ahol ház vagy út van, az úgyis eltakarja).
  const cell = 6 * s;
  const bloom = [c(0xf4e060), c(0xf08aa0), c(0xf6f2e6), c(0xd8483c), c(0xb07ad8)];
  const leaf = c(0x3c7a34);
  const slabLight = c(0xbdb7a8);
  const slabDark = c(0xa9a394);
  const garden: Mat = (wx, wy) => {
    const cxi = Math.floor(wx / cell);
    const cyi = Math.floor(wy / cell);
    const h = hash(cxi * 7 + 3, cyi * 13 + 1);
    const kind = h & 31;
    if (kind > 3) return yard(wx, wy);
    const lx = wx - cxi * cell;
    const ly = wy - cyi * cell;
    // a cellán belüli hely és méret ágyásonként más
    const jx = ((h >>> 14) & 7) * 0.14 * s;
    const jy = ((h >>> 17) & 7) * 0.14 * s;
    const grow = 1 + ((h >>> 20) & 3) * 0.14;
    if (kind <= 1) {
      // virágágyás: szabálytalan folt sötétebb lombbal és apró, színes virágokkal
      const ox = cell * (0.35 + ((h >>> 5) & 7) * 0.04);
      const oy = cell * (0.35 + ((h >>> 8) & 7) * 0.04);
      const r = s * (0.9 + ((h >>> 11) & 3) * 0.22);
      const dx = lx - ox;
      const dy = ly - oy;
      if (dx * dx + dy * dy > r * r * (0.7 + 0.5 * vnoise(wx / (0.5 * s), wy / (0.5 * s)))) return yard(wx, wy);
      // egy ágyásban egyféle (ritkán kétféle) virág nyílik
      const dot = hash(Math.floor(wx / (0.3 * s)) + h, Math.floor(wy / (0.3 * s)));
      const tint = bloom[((h >>> 13) + (dot % 11 === 0 ? 1 : 0)) % bloom.length];
      return dot % 4 === 0 ? tint : (dot & 3) === 1 ? shade(leaf, 1.12) : leaf;
    }
    if (kind === 2) {
      // veteményes: felásott ágyás zöld sorokkal
      if (lx < 1.0 * s + jx || lx > (1.0 + 2.6 * grow) * s + jx || ly < 1.2 * s + jy || ly > (1.2 + 1.9 * grow) * s + jy) return yard(wx, wy);
      return frac(ly / (0.62 * s)) < 0.42 ? veg : (hash(wx, wy) & 7) === 0 ? soilB : soilA;
    }
    // burkolt terasz: világos lapok
    if (lx < 1.2 * s + jx || lx > (1.2 + 2.0 * grow) * s + jx || ly < 1.4 * s + jy || ly > (1.4 + 1.8 * grow) * s + jy) return yard(wx, wy);
    const q = Math.max(2, Math.round(0.6 * s));
    if (wx % q === 0 || wy % q === 0) return slabDark;
    return slabLight;
  };

  const areas: Record<string, Mat> = {
    residential: garden,
    garden,
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
  const ridge = shade(style.base, 0.56);
  // a gerinc megvilágított oldala: világos kúpcserép
  const ridgeLight = shade(style.base, 1.3);
  const eavePx = 0.42 * s;
  const wearK = 1 / (2.4 * s);
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
    // a gerinc vonala mellett egy pixelnyi világos sáv fut (a fény felőli oldalon)
    const left2 = idx % w > 1 ? faceBuf[idx - 2] : 0;
    const up2 = idx >= w * 2 ? faceBuf[idx - w * 2] : 0;
    if ((left2 && left2 !== id && (left2 - 1) >> 6 === seq) || (up2 && up2 !== id && (up2 - 1) >> 6 === seq)) {
      buf[idx] = ridgeLight;
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
    let color = faceColors[base + (v === 0 ? 1 : v === 1 ? 2 : 0)];
    // az eresz felé sötétebb a tető, a felületén pedig foltokban látszik az idő (kifakulás, moha)
    const wear = vnoise(wx * wearK + seed, wy * wearK - seed);
    const tone = (roofH < eavePx ? 0.88 : 1) * (wear < 0.3 ? 0.93 : wear > 0.74 ? 1.05 : 1);
    if (tone !== 1) color = shade(color, tone);
    buf[idx] = color;
  });

  // tetőablak vagy napelem néhány lakóházon, a leghosszabb eresz fölötti tetősíkon
  const extra = seed % 100;
  if (!spec && b.kind !== 'church' && b.area > 60 && extra < 38) {
    let li = 0;
    for (let i = 1; i < edges.length; i++) if (edges[i].len > edges[li].len) li = i;
    const e = edges[li];
    const ux = e.dx / e.len;
    const uy = e.dy / e.len;
    const solar = extra >= 24 && b.area > 85;
    const count = solar ? 1 : 1 + (seed >> 8) % 2;
    for (let k = 0; k < count; k++) {
      const alongAt = e.len * (0.5 + (k === 0 ? ((seed >> 4) % 5) * 0.05 - 0.1 : 0.22));
      for (const sign of [1, -1]) {
        const depth = (solar ? 1.9 : 1.5) * s;
        const px = e.ax + ux * alongAt - uy * depth * sign;
        const py = e.ay + uy * alongAt + ux * depth * sign;
        if (!pointInPolygon(px / s, py / s, b.pts)) continue;
        roofAt(edges, gable, px, py);
        if (roofFace !== li || roofH < 1.0 * s) continue;
        drawRoofPanel(t, px, py, ux, uy, solar);
        break;
      }
    }
  }

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

/** Tetőablak (világos keret, sötét üveg) vagy napelemtábla (sötétkék cellák) a tetősíkon, az eresszel párhuzamosan. */
function drawRoofPanel(t: RasterTarget, cx: number, cy: number, ux: number, uy: number, solar: boolean): void {
  const s = t.scale;
  const { buf } = t;
  const halfU = (solar ? 1.9 : 0.5) * s;
  const halfV = (solar ? 1.05 : 0.62) * s;
  const frame = Math.max(1, 0.1 * s);
  const cellU = 0.95 * s;
  const cellV = 1.05 * s;
  forDisc(t, cx, cy, Math.hypot(halfU, halfV) + 1, (idx, dx, dy) => {
    const u = dx * ux + dy * uy;
    const v = dy * ux - dx * uy;
    if (Math.abs(u) > halfU || Math.abs(v) > halfV) return;
    if (solar) {
      const lu = (u + halfU) % cellU;
      const lv = (v + halfV) % cellV;
      buf[idx] = lu < frame || lv < frame || Math.abs(u) > halfU - frame || Math.abs(v) > halfV - frame ? c(0x8c98a8) : (u + v) % (0.5 * s) < 0.08 * s ? c(0x2c4468) : c(0x1c2c48);
      return;
    }
    if (Math.abs(u) > halfU - frame || Math.abs(v) > halfV - frame) buf[idx] = c(0xd6d4c8);
    else buf[idx] = u - v > 0.25 * s ? c(0x5c7896) : c(0x2a3a52); // az üvegen megcsillan az ég
  });
}

/** Stopvonal: széles fehér sáv keresztben az érkező sávon. */
function drawStopLine(t: RasterTarget, x: number, y: number, angle: number, half: number): void {
  const s = t.scale;
  const { buf } = t;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const halfLen = half * s;
  const halfThick = 0.25 * s;
  forDisc(t, x * s, y * s, halfLen + 1, (idx, dx, dy, wx, wy) => {
    const u = dx * cos + dy * sin;
    const v = dy * cos - dx * sin;
    if (Math.abs(u) > halfThick || Math.abs(v) > halfLen) return;
    buf[idx] = (hash(wx, wy) & 15) === 0 ? c(0xc9c9c2) : c(0xe9e9e1);
  });
}

/** Aknafedél: sötét öntöttvas korong világosabb gyűrűvel és bordázattal. */
function drawManhole(t: RasterTarget, x: number, y: number): void {
  const s = t.scale;
  const { buf } = t;
  const r = 0.4 * s;
  const rib = Math.max(1, 0.16 * s);
  forDisc(t, x * s, y * s, r, (idx, dx, dy) => {
    const d2 = dx * dx + dy * dy;
    if (d2 > r * r) return;
    const d = Math.sqrt(d2);
    if (d > r - Math.max(1, 0.07 * s)) buf[idx] = c(0x2a2a30);
    else if (d > r * 0.72) buf[idx] = c(0x5c5c64);
    else buf[idx] = Math.floor((dx + r) / rib) & 1 ? c(0x44444c) : c(0x3a3a42);
  });
}

/** A vonal bejárása méterben: `start`-tól `step` méterenként hívja a függvényt a ponttal és az iránnyal. */
function walk(pts: ArrayLike<number>, start: number, step: number, fn: (x: number, y: number, angle: number) => void): void {
  let next = start;
  let acc = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const dx = pts[i + 2] - pts[i];
    const dy = pts[i + 3] - pts[i + 1];
    const len = Math.hypot(dx, dy);
    while (next <= acc + len && len > 0) {
      const k = (next - acc) / len;
      fn(pts[i] + dx * k, pts[i + 1] + dy * k, Math.atan2(dy, dx));
      next += step;
    }
    acc += len;
  }
}

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
    // némelyik bokor virágzik: apró, világos pöttyök a lombon
    if (seed % 6 === 0) {
      const dot = hash(Math.floor(wx / (0.24 * s)) + seed, Math.floor(wy / (0.24 * s)));
      if (dot % 7 === 0) {
        buf[idx] = BLOSSOM[(seed >>> 4) % BLOSSOM.length];
        return;
      }
    }
    const v = 0.5 - ((dx + dy) / (rp * 1.4142)) * 0.4 + (vnoise(wx * k * 1.7, wy * k * 1.7 + seed) - 0.5) * 0.6;
    buf[idx] = v < 0.36 ? tones[0] : v < 0.62 ? tones[1] : tones[2];
  });
}

/** virágzó bokrok és fák pöttyeinek színe */
const BLOSSOM = [0xf6eef0, 0xf2a8c0, 0xf4e27a, 0xe8d0f0].map(c);

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
  // a legvilágosabb, napsütötte levélcsomók színe
  const sunlit = shade(tones[3], 1.16);
  // a gyümölcsfák és néhány lombos fa virágzik
  const blossom = !conifer && (tree.kind === 2 ? seed % 3 === 0 : seed % 23 === 0) ? BLOSSOM[seed % 2] : 0;
  const k2 = 1 / (0.2 * s);
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
    else {
      // kisebb levélcsomók: ettől a korona nem egyenletes folt, hanem tagolt lomb
      v += (vnoise(wx * k2 + seed * 5, wy * k2 - seed) - 0.5) * 0.34;
      if (blossom && hash(Math.floor(wx / (0.28 * s)) + seed, Math.floor(wy / (0.28 * s))) % 5 === 0) {
        buf[idx] = blossom;
        return;
      }
    }
    buf[idx] = v < 0.28 ? tones[0] : v < 0.5 ? tones[1] : v < 0.72 ? tones[2] : v < 0.94 ? tones[3] : sunlit;
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
  const buildingIds = map.buildingIndex.query(minX, minY, maxX, maxY).filter((n) => visible(map.buildingBoxes[n]));
  // az összedőlt épületeknek nincs tetejük és árnyékuk: a helyükön rom van a talajon
  const collapsed = map.structures.collapsed;
  const buildings = buildingIds.filter((n) => !collapsed[n]).map((n) => data.buildings[n]);
  const ruins = buildingIds.filter((n) => collapsed[n]);
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
      // lakóutcán világos szegélykő, mögötte sötét vízfolyóka; főúton sötét aszfaltszél (a padka mellett)
      const kerb = STREETS.has(road.kind);
      const edge = kerb ? c(0xa39f93) : MAIN_ROADS.has(road.kind) ? c(0x3e3e46) : c(0x55555b);
      const gutter = c(0x3a3a42);
      strokeLine(t, road.pts, hw, (idx, wx, wy, d, _along, cap) => {
        buf[idx] = d > hw - line ? edge : kerb && !cap && d > hw - line * 2.2 ? gutter : mat(wx, wy);
      });
    }
    // a kereszteződésekben a szegélyt újra aszfalt fedi
    for (const { road } of roads) {
      if (MINOR_KINDS.has(road.kind)) continue;
      const mat = asphaltFor(m, road.kind);
      strokeLine(t, road.pts, (road.width * s) / 2 - (STREETS.has(road.kind) ? line * 2.2 : line), (idx, wx, wy) => {
        buf[idx] = mat(wx, wy);
      });
    }
    // A közutakon látszik a használat: sötétebb keréknyomok a két sávban, itt-ott foltozás, a
    // főúton szélső vonal. Ezek csak a szakaszok mellé kerülnek (a lekerekített végekbe nem),
    // így a töréspontoknál és a kereszteződésekben nem rajzolnak íveket.
    for (const { road, n } of roads) {
      const kerb = STREETS.has(road.kind);
      const main = MAIN_ROADS.has(road.kind);
      if (!kerb && !main) continue;
      const hw = (road.width * s) / 2;
      const inner = hw - (kerb ? line * 2.2 : line);
      const lane = hw * 0.5;
      const wheel = 0.82 * s;
      const band = 0.3 * s;
      const patchLen = 13 * s;
      const edgeLine = c(0xdedcd0);
      strokeLine(t, road.pts, inner, (idx, _wx, _wy, d, along, cap) => {
        if (cap) return;
        let color = buf[idx];
        {
          if (Math.abs(Math.abs(d - lane) - wheel) < band) color = shade(color, 0.945);
          const seg = Math.floor(along / patchLen);
          const ph = hash(seg + n * 31, n);
          if ((ph & 15) === 0) {
            const u = along - seg * patchLen;
            const from = hw * (0.12 + ((ph >>> 3) & 3) * 0.12);
            if (u > patchLen * 0.25 && u < patchLen * (0.45 + ((ph >>> 5) & 3) * 0.08) && d > from && d < from + hw * 0.42) color = shade(color, 0.9);
          }
          // főúton folytonos fehér szélső vonal
          if (main && d > hw - 0.62 * s && d < hw - 0.48 * s) color = edgeLine;
        }
        buf[idx] = color;
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
    // stopvonalak a főútra kiérkező utcák végén
    for (let i = 0; i < map.stopLines.length; i += 4) {
      if (inView(map.stopLines[i], map.stopLines[i + 1])) drawStopLine(t, map.stopLines[i], map.stopLines[i + 1], map.stopLines[i + 2], map.stopLines[i + 3]);
    }
    // aknafedelek a közutakon, kb. 60 méterenként, felváltva a két sávban
    for (const { road, n } of roads) {
      if (!STREETS.has(road.kind) && !MAIN_ROADS.has(road.kind)) continue;
      let k = 0;
      walk(road.pts, 14 + (hash(n, 5) % 30), 61, (x, y, angle) => {
        const side = (k++ + n) & 1 ? 1 : -1;
        const off = road.width * 0.22 * side;
        const mx = x - Math.sin(angle) * off;
        const my = y + Math.cos(angle) * off;
        if (inView(mx, my)) drawManhole(t, mx, my);
      });
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
    const props = map.fellables;
    const treeIds = map.treeIndex.query(minX, minY, maxX, maxY);
    const bushes = data.decor.bushes;
    const poles = data.decor.poles;
    const poleIds = map.poleIndex.query(minX, minY, maxX, maxY);

    // esőben a burkolatlan talaj foltokban felázik (a bokrok és az épületek már e fölé kerülnek)
    if (map.weather === 'rain') muddy(t);

    // 6. bokrok
    for (const n of map.bushIndex.query(minX, minY, maxX, maxY)) {
      drawBush(t, bushes[n * 3], bushes[n * 3 + 1], bushes[n * 3 + 2], hash(n * 3, 313));
    }

    // az összedőlt épületek romjai a talajon
    for (const n of ruins) drawRuin(t, data.buildings[n], n);

    // a falak tövében a talaj sötétebb: ettől az épület „ül” a földön
    const aoPx = 1.0 * s;
    for (const b of buildings) {
      const ring = Array.from(b.pts);
      ring.push(ring[0], ring[1]);
      strokeRing(t, ring, 0, aoPx, (idx, _wx, _wy, d) => {
        if (!coverBuf[idx] && buf[idx] !== 0) buf[idx] = shade(buf[idx], 0.74 + 0.26 * (d / aoPx));
      });
    }

    // 7. vetett árnyékok (épületek, álló fák és oszlopok) – maszkba gyűjtve, hogy az átfedés ne sötétedjen kétszer
    const mark: Put = (idx) => {
      maskBuf[idx] = 1;
    };
    for (const b of buildings) {
      const len = shadowLength(b, specOf(b)) * s;
      for (let step = 1; step <= 3; step++) fillRings(t, [b.pts], (len * step) / 3, (len * step) / 3, mark);
    }
    for (const n of treeIds) {
      if (props.fallen[n]) continue;
      const tree = map.trees[n];
      const off = (tree.r * 0.35 + 0.5) * s;
      const rp = tree.r * 0.9 * s;
      forDisc(t, tree.x * s + off, tree.y * s + off, rp, (idx, dx, dy) => {
        if (dx * dx + dy * dy <= rp * rp) maskBuf[idx] = 1;
      });
    }
    for (const n of poleIds) {
      if (props.fallen[map.poleOffset + n]) continue;
      const x = poles[n * 2];
      const y = poles[n * 2 + 1];
      strokeLine(t, [x, y, x + 2.6, y + 2.6], Math.max(0.75, 0.08 * s), mark);
    }
    markLandmarkShadows(map, t);
    for (let idx = 0; idx < maskBuf.length; idx++) {
      if (maskBuf[idx] && buf[idx] !== 0) buf[idx] = shade(buf[idx], 0.68);
    }

    // 8. fatörzsek és (beton) villanyoszlopok; a kidőltek a földön fekszenek
    for (const n of treeIds) {
      const tree = map.trees[n];
      if (props.fallen[n]) {
        drawFallenTree(t, tree, props.angle[n], hash(n, 991));
        continue;
      }
      const rp = 0.28 * s;
      forDisc(t, tree.x * s, tree.y * s, rp, (idx, dx, dy) => {
        if (dx * dx + dy * dy <= rp * rp) buf[idx] = c(0x4a3424);
      });
    }
    for (const n of poleIds) {
      const x = poles[n * 2];
      const y = poles[n * 2 + 1];
      if (props.fallen[map.poleOffset + n]) {
        // kidőlt oszlop: a földön fekvő betonrúd a keresztkarral
        const a = props.angle[map.poleOffset + n];
        const ex = x + Math.cos(a) * 7;
        const ey = y + Math.sin(a) * 7;
        strokeLine(t, [x, y, ex, ey], Math.max(1, 0.2 * s), (idx, _wx, _wy, d) => {
          buf[idx] = d > 0.1 * s ? c(0x5e5e64) : c(0xb4b4b8);
        });
        const cx = x + Math.cos(a) * 6;
        const cy = y + Math.sin(a) * 6;
        strokeLine(t, [cx - Math.sin(a) * 0.9, cy + Math.cos(a) * 0.9, cx + Math.sin(a) * 0.9, cy - Math.cos(a) * 0.9], Math.max(1, 0.1 * s), (idx) => {
          buf[idx] = c(0x4a4a50);
        });
        continue;
      }
      const rp = 0.24 * s;
      forDisc(t, x * s, y * s, rp, (idx, dx, dy) => {
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
    // 10. maradandó lövésnyomok: a talajon kráter, a tetőn lyuk
    for (const n of map.scarIndex.query(minX, minY, maxX, maxY)) {
      drawScar(t, map.scars[n * 3], map.scars[n * 3 + 1], map.scars[n * 3 + 2], n);
    }
  } else {
    for (const b of buildings) drawBuilding(t, b, 0);
    const ruin = c(0x6e6860);
    for (const n of ruins) fillRings(t, [data.buildings[n].pts], 0, 0, (idx) => {
      buf[idx] = ruin;
    });
  }
  // a játéktéren kívüli rész nem látszik (a pálya itt le van vágva), a határon sárga vonal fut
  const area = map.bounds;
  if (area) {
    const x0 = area.minX * s - t.ox;
    const y0 = area.minY * s - t.oy;
    const x1 = area.maxX * s - t.ox;
    const y1 = area.maxY * s - t.oy;
    const line = Math.max(1, 0.35 * s);
    const edge = c(0xf2c230);
    const outside = c(0x101418);
    for (let py = 0; py < t.h; py++) {
      const outY = py < y0 || py >= y1;
      for (let px = 0; px < t.w; px++) {
        const idx = py * t.w + px;
        if (outY || px < x0 || px >= x1) {
          buf[idx] = outside;
          continue;
        }
        if (px < x0 + line || px >= x1 - line || py < y0 + line || py >= y1 - line) buf[idx] = edge;
      }
    }
  }
}

/** Esőben a zöld (burkolatlan) felületek sárosak: a zöld árnyalatok barnába hajlanak. */
function muddy(t: RasterTarget): void {
  const { buf, scale: s } = t;
  // a foltok mérete méterben: nagy, lassan változó sárfoltok, bennük kisebb tócsák
  const big = 1 / (9 * s);
  const small = 1 / (2.2 * s);
  for (let py = 0; py < t.h; py++) {
    const wy = py + t.oy;
    for (let px = 0; px < t.w; px++) {
      const idx = py * t.w + px;
      const color = buf[idx];
      const r = color & 255;
      const g = (color >>> 8) & 255;
      const b = (color >>> 16) & 255;
      // csak a zöld túlsúlyú pixelek (fű, kert, park, erdőtalaj)
      if (g <= r * 1.06 || g <= b * 1.12) continue;
      const wx = px + t.ox;
      const n = vnoise(wx * big, wy * big) * 0.7 + vnoise(wx * small + 31, wy * small + 17) * 0.3;
      // a fű mindenütt nedves (kicsit sötétebb, tompább); a foltokban egyre sárosabb
      const mud = Math.max(0, Math.min(1, (n - 0.38) * 2.6));
      const grain = ((hash(wx, wy) & 31) - 15) * 0.6;
      let nr = r * 0.86 + (112 - r * 0.86) * mud * 0.8 + grain * mud;
      let ng = g * 0.84 + (90 - g * 0.84) * mud * 0.8 + grain * mud;
      let nb = b * 0.9 + (62 - b * 0.9) * mud * 0.8 + grain * mud * 0.6;
      if (n > 0.74) {
        // tócsa a sárfolt közepén: az eget tükröző, szürkéskék víz, világosabb szegéllyel
        const edge = n < 0.765 ? 1.18 : 1;
        nr = 96 * edge;
        ng = 108 * edge;
        nb = 120 * edge;
      }
      buf[idx] = ((color & 0xff000000) | ((nb & 255) << 16) | ((ng & 255) << 8) | (nr & 255)) >>> 0;
    }
  }
}

/** Összedőlt épület: törmelékkupac az alaprajzon, a falak csonkjával. */
function drawRuin(t: RasterTarget, b: BuildingFeature, seed: number): void {
  const { buf, scale: s } = t;
  const k = 1 / (0.45 * s);
  const tones = [c(0x7d756c), c(0x8f877c), c(0x6a625a), c(0x9a8f80)];
  const brick = c(0x9a4a34);
  const char = c(0x3a3531);
  fillRings(t, [b.pts], 0, 0, (idx) => {
    const wx = (idx % t.w) + t.ox;
    const wy = Math.floor(idx / t.w) + t.oy;
    const n = vnoise(wx * k + seed * 3.1, wy * k + seed * 1.7);
    const h = (hash(wx + seed, wy) & 1023) / 1023;
    buf[idx] = h > 0.93 ? brick : h < 0.08 ? char : tones[Math.min(3, Math.floor(n * 4))];
    coverBuf[idx] = 0;
  });
  // a falak csonkja: szaggatott, sötét körvonal
  const wall = c(0x4a443e);
  const pts = b.pts;
  const count = pts.length / 2;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    if ((hash(seed * 7 + i, i * 13) & 255) < 77) continue;
    strokeLine(t, [pts[j * 2], pts[j * 2 + 1], pts[i * 2], pts[i * 2 + 1]], Math.max(1, 0.4 * s), (idx) => {
      buf[idx] = wall;
    });
  }
}

/** Kidőlt fa: a földön fekvő törzs és az összenyomott, megbarnult lomb. */
function drawFallenTree(t: RasterTarget, tree: Tree, angle: number, seed: number): void {
  const s = t.scale;
  const { buf } = t;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const length = tree.r * 1.5 + 1;
  // törzs
  strokeLine(t, [tree.x, tree.y, tree.x + cos * length, tree.y + sin * length], Math.max(1, 0.24 * s), (idx, _wx, _wy, d) => {
    buf[idx] = d > 0.14 * s ? c(0x3a2818) : c(0x6a4a2c);
  });
  // a lomb a törzs végénél terül el, a dőlés irányában megnyúlva
  const cx = (tree.x + cos * length * 0.8) * s;
  const cy = (tree.y + sin * length * 0.8) * s;
  const ra = tree.r * 0.95 * s;
  const rb = tree.r * 0.62 * s;
  const k = 1 / (0.42 * s);
  const conifer = tree.kind === 1;
  const tones = conifer ? [c(0x16302a), c(0x234436), c(0x30563e)] : [c(0x2a4420), c(0x47622a), c(0x6a7a34)];
  forDisc(t, cx, cy, ra + 1, (idx, dx, dy, wx, wy) => {
    const u = (dx * cos + dy * sin) / ra;
    const v = (dy * cos - dx * sin) / rb;
    const q = u * u + v * v;
    const edge = 0.78 + 0.22 * vnoise(wx * k + seed, wy * k);
    if (q > edge) return;
    if (q > edge - 0.14) {
      buf[idx] = c(0x1e3018);
      return;
    }
    const n = vnoise(wx * k * 1.6 + seed, wy * k * 1.6 + seed * 3);
    buf[idx] = tones[n < 0.38 ? 0 : n < 0.66 ? 1 : 2];
  });
  // a tő helyén a csonk
  const rp = 0.3 * s;
  forDisc(t, tree.x * s, tree.y * s, rp, (idx, dx, dy) => {
    const d2 = dx * dx + dy * dy;
    if (d2 <= rp * rp) buf[idx] = d2 < rp * rp * 0.4 ? c(0xc8a878) : c(0x4a3424);
  });
}

/** Lövésnyom: a talajon kormos kráter törmelékkel, a tetőn beszakadt lyuk a szarufákkal. */
function drawScar(t: RasterTarget, x: number, y: number, r: number, seed: number): void {
  const s = t.scale;
  const { buf } = t;
  const rp = r * s;
  const k = 1 / (0.5 * s);
  // a kráter mélysége a méretéből: a kis nyom (ágyú) 0, a rakétáé kb. 1
  const depth = Math.min(1, Math.max(0, (r - 1.3) / 2.3));
  forDisc(t, x * s, y * s, rp * 1.25, (idx, dx, dy, wx, wy) => {
    const n = vnoise(wx * k + seed * 1.3, wy * k + seed * 0.7);
    const q = Math.sqrt(dx * dx + dy * dy) / rp + (n - 0.5) * 0.45;
    if (q >= 1.15) return;
    const onRoof = coverBuf[idx] === 1;
    if (q >= 1) {
      // kormos perem, szétszórt törmelék
      if ((hash(wx, wy) & 7) === 0) buf[idx] = onRoof ? c(0x2a1c16) : c(0x8a8478);
      else buf[idx] = shade(buf[idx], 0.72);
      return;
    }
    if (onRoof) {
      if (q < 0.62) buf[idx] = (wx + wy * 2) % Math.max(3, Math.round(0.45 * s)) === 0 ? c(0x5a4028) : c(0x16100e);
      else buf[idx] = shade(buf[idx], 0.42);
      return;
    }
    if (depth < 0.15) {
      // kis nyom (ágyú, lézer): mint eddig
      if (q < 0.45) buf[idx] = n > 0.6 ? c(0x2e2822) : c(0x221c18);
      else if (q < 0.72) buf[idx] = c(0x3e362e);
      else buf[idx] = shade(buf[idx], 0.55);
      return;
    }
    // mély kráter: gödör, amelynek a bal felső (a fény felőli) fala árnyékban, a jobb alsó világosban van;
    // minél nagyobb, annál sötétebb a mélye
    const light = (dx + dy) / (rp * 1.414);
    const tone = 0.3 + 0.55 * q * q - 0.2 * depth * (1 - q) + 0.22 * depth * light * Math.min(1, q * 1.6) + (n - 0.5) * 0.12;
    buf[idx] = shade(q < 0.3 && n > 0.55 ? c(0x3a3026) : c(0x7a6a56), Math.max(0.1, Math.min(1, tone)));
  });
  if (depth >= 0.15) {
    // kidobott föld a kráter körül: világosabb, rögös perem
    forDisc(t, x * s, y * s, rp * 1.6, (idx, dx, dy, wx, wy) => {
      if (coverBuf[idx] === 1) return;
      const n = vnoise(wx * k * 1.7 + seed * 2.1, wy * k * 1.7 + seed * 1.1);
      const q = Math.sqrt(dx * dx + dy * dy) / rp + (n - 0.5) * 0.35;
      if (q < 1.12 || q >= 1.55) return;
      const strength = (1 - (q - 1.12) / 0.43) * depth;
      if (n > 0.48) buf[idx] = mix(buf[idx], (hash(wx, wy) & 3) === 0 ? c(0x5a4e40) : c(0x9a8a6e), Math.min(0.85, strength * 1.1));
    });
  }
}

// --- a lombréteg -------------------------------------------------------------------

/** Kidőlt-e az adott koordinátán álló villanyoszlop. */
function poleDown(map: GameMap, x: number, y: number): boolean {
  const n = map.poleAt.get(`${x},${y}`);
  return n !== undefined && map.fellables.fallen[map.poleOffset + n] === 1;
}

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
      if (poleDown(map, ax, ay) || poleDown(map, bx, by)) continue;
      strokeLine(t, [ax, ay, bx, by], Math.max(0.6, 0.05 * s), (idx) => {
        buf[idx] = wire;
        drawn = true;
      });
    }
  }

  for (const n of map.treeIndex.query(minX, minY, maxX, maxY)) {
    if (map.fellables.fallen[n]) continue;
    const tree = map.trees[n];
    if (tree.x < minX || tree.x > maxX || tree.y < minY || tree.y > maxY) continue;
    drawCanopy(t, tree, hash(n, 991));
    drawn = true;
  }
  if (drawLandmarkOverlay(map, t)) drawn = true;
  // a játéktéren kívülre eső lomb és vezeték nem látszik
  const area = map.bounds;
  if (area && drawn) {
    const x0 = area.minX * s - t.ox;
    const y0 = area.minY * s - t.oy;
    const x1 = area.maxX * s - t.ox;
    const y1 = area.maxY * s - t.oy;
    if (x0 > 0 || y0 > 0 || x1 < t.w || y1 < t.h) {
      for (let py = 0; py < t.h; py++) {
        const outY = py < y0 || py >= y1;
        for (let px = 0; px < t.w; px++) if (outY || px < x0 || px >= x1) buf[py * t.w + px] = 0;
      }
    }
  }
  return drawn;
}
