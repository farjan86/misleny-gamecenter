// A fotók alapján kézzel felvett tereptárgyak rajzolása
// (assets/maps/landmarks/*.json): a kiemelt épületek saját tetőformája és
// tornya, valamint a környezetük – térkő, gyep, virágágyás, padok, zászlók,
// parkoló autók.

import { CAR_SIZE, pointInPolygon, type GameMap } from './GameMap';
import {
  c,
  cssColor,
  faceBuf,
  fillRings,
  forDisc,
  forRect,
  hash,
  maskBuf,
  mottled,
  shade,
  strokeLine,
  vnoise,
  type Mat,
  type RasterTarget,
} from './rasterCore';
import type { BuildingFeature, LandmarkBuilding, LandmarkTower } from './types';

// --- felületek -------------------------------------------------------------------

interface LandmarkMats {
  plaza: Mat;
  lawn: Mat;
  flowerbed: Mat;
  woodland: Mat;
  asphalt: Mat;
}

const matsCache = new Map<number, LandmarkMats>();
function matsFor(s: number): LandmarkMats {
  let m = matsCache.get(s);
  if (m) return m;

  // térkő: kötésben rakott, világosszürke kövek
  const pv = Math.max(2, Math.round(0.3 * s));
  const stones = [c(0xb6b4ad), c(0xadaba4), c(0xbebcb5), c(0xb1afa8)];
  const joint = c(0x99978f);
  const plaza: Mat = (wx, wy) => {
    const row = Math.floor(wy / pv);
    const shifted = wx + (row & 1) * pv;
    if (wy % pv === 0 || shifted % (pv * 2) === 0) return joint;
    return stones[hash(Math.floor(shifted / (pv * 2)), row) & 3];
  };

  // nyírt gyep: egyenletesebb, világosabb zöld, halvány nyírási csíkokkal
  const turf = mottled(s, 4, 0x63a342, 0x69aa46, 0x70b24b, 0x7abc54, 4);
  const lawn: Mat = (wx, wy) => {
    const base = turf(wx, wy);
    return Math.floor((wx * 0.6 + wy * 0.8) / (1.4 * s)) & 1 ? shade(base, 1.04) : base;
  };

  const soil = c(0x6a4a34);
  const leaf = c(0x3f8a36);
  const leafDark = c(0x2f6e2c);
  const petals = [c(0xe0443a), c(0xf2d24a), c(0xe884b0), c(0xf6f2ea), c(0xe86a2a)];
  const flowerbed: Mat = (wx, wy) => {
    const v = vnoise(wx / (0.5 * s), wy / (0.5 * s));
    if (v < 0.32) return soil;
    const h = hash(wx >> 1, wy >> 1) & 15;
    if (h < 5) return petals[hash(Math.floor(wx / (0.6 * s)), Math.floor(wy / (0.6 * s))) % petals.length];
    return h < 9 ? leafDark : leaf;
  };

  m = {
    plaza,
    lawn,
    flowerbed,
    woodland: mottled(s, 2.5, 0x35562c, 0x3c6032, 0x456a38, 0x5c5a34, 24),
    asphalt: mottled(s, 2.5, 0x5e5e65, 0x64646b, 0x6b6b72, 0x7a7a81, 22),
  };
  matsCache.set(s, m);
  return m;
}

/**
 * A környezet felületei. 'under': az utak alá kerülő rétegek (gyep, erdőtalaj,
 * aszfalt); 'over': az utak fölé kerülők (térkő, virágágyás).
 */
export function drawLandmarkAreas(map: GameMap, t: RasterTarget, phase: 'under' | 'over'): void {
  const lm = map.data.landmarks;
  if (!lm) return;
  const m = matsFor(t.scale);
  const { buf } = t;
  const edge = Math.max(1, 0.12 * t.scale);
  for (const area of lm.areas) {
    const over = area.kind === 'plaza' || area.kind === 'flowerbed';
    if (over !== (phase === 'over')) continue;
    const mat = m[area.kind];
    fillRings(t, [area.ring], 0, 0, (idx, wx, wy) => {
      buf[idx] = mat(wx, wy);
    });
    // a virágágyást alacsony, világos kőszegély keretezi
    if (area.kind === 'flowerbed') {
      const ring = [...area.ring, area.ring[0], area.ring[1]];
      strokeLine(t, ring, edge * 1.6, (idx) => {
        buf[idx] = c(0xdcd8cc);
      });
    }
  }
}

// --- vetett árnyékok ---------------------------------------------------------------

export function markLandmarkShadows(map: GameMap, t: RasterTarget): void {
  const lm = map.data.landmarks;
  if (!lm) return;
  const s = t.scale;
  const mark = (idx: number) => {
    maskBuf[idx] = 1;
  };
  // a tornyok magasak: hosszú árnyék
  for (const b of lm.buildings) {
    for (const tower of b.towers ?? []) {
      const len = tower.shadow * s;
      const steps = Math.max(8, Math.ceil(len / 3));
      for (let step = 1; step <= steps; step++) fillRings(t, [tower.polygon], (len * step) / steps, (len * step) / steps, mark);
    }
  }
  for (const b of lm.benches) {
    const off = 0.3 * s;
    forRect(t, b.x * s + off, b.y * s + off, b.angle, (b.length / 2) * s, 0.35 * s, 0, mark);
  }
  for (const car of lm.cars) {
    const off = 0.45 * s;
    forRect(t, car.x * s + off, car.y * s + off, car.angle, (CAR_SIZE.length / 2) * s, (CAR_SIZE.width / 2) * s, 0, mark);
  }
  for (const p of lm.flagpoles) strokeLine(t, [p.x, p.y, p.x + 5, p.y + 5], Math.max(0.75, 0.07 * s), mark);
  for (const [x, y] of lm.lamps) strokeLine(t, [x, y, x + 2.6, y + 2.6], Math.max(0.75, 0.08 * s), mark);
}

// --- tárgyak a talajrétegen ----------------------------------------------------------

export function drawLandmarkProps(map: GameMap, t: RasterTarget): void {
  const lm = map.data.landmarks;
  if (!lm) return;
  const s = t.scale;
  const { buf } = t;

  // kőpadok
  for (const b of lm.benches) {
    const hl = (b.length / 2) * s;
    const hw = 0.35 * s;
    forRect(t, b.x * s, b.y * s, b.angle, hl, hw, 0, (idx, u, v, wx, wy) => {
      const rim = Math.abs(u) > hl - 1.5 || Math.abs(v) > hw - 1.5;
      buf[idx] = rim ? c(0x86837b) : (hash(wx, wy) & 7) === 0 ? c(0xbdbab1) : c(0xcfccc3);
    });
  }

  // parkoló autók
  const hl = (CAR_SIZE.length / 2) * s;
  const hw = (CAR_SIZE.width / 2) * s;
  const corner = 0.45 * s;
  for (const car of lm.cars) {
    const body = cssColor(car.color);
    forRect(t, car.x * s, car.y * s, car.angle, hl, hw, 0, (idx, u, v) => {
      // lekerekített sarkok
      const cu = Math.abs(u) - (hl - corner);
      const cv = Math.abs(v) - (hw - corner);
      if (cu > 0 && cv > 0 && cu * cu + cv * cv > corner * corner) return;
      const edge = Math.min(hl - Math.abs(u), hw - Math.abs(v));
      const um = u / s;
      const vm = Math.abs(v) / s;
      if (edge < 1.3) buf[idx] = shade(body, 0.45);
      else if (um > 0.45 && um < 1.15 && vm < 0.78) buf[idx] = c(0x2c3642); // szélvédő
      else if (um < -1.25 && um > -1.7 && vm < 0.74) buf[idx] = c(0x2c3642); // hátsó ablak
      else if (um > -1.25 && um < 0.45 && vm > 0.62 && vm < 0.8) buf[idx] = c(0x39434f); // oldalablakok
      else if (um > 1.95 && vm > 0.45) buf[idx] = c(0xfff4c0); // fényszórók
      else if (um < -1.98 && vm > 0.45) buf[idx] = c(0xc83a30); // hátsó lámpák
      else buf[idx] = um > -1.25 && um < 0.45 ? body : shade(body, 0.9);
    });
  }

  // zászlórudak és lámpaoszlopok talpa
  for (const p of lm.flagpoles) {
    const r = 0.22 * s;
    forDisc(t, p.x * s, p.y * s, r, (idx, dx, dy) => {
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r) buf[idx] = d2 < r * r * 0.35 ? c(0xf0f0f0) : c(0x70706e);
    });
  }
  for (const [x, y] of lm.lamps) {
    const r = 0.2 * s;
    forDisc(t, x * s, y * s, r, (idx, dx, dy) => {
      if (dx * dx + dy * dy <= r * r) buf[idx] = c(0x34343a);
    });
  }
}

// --- kiemelt épületek teteje ---------------------------------------------------------

interface Line {
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  len: number;
  /** megvilágítás: 1 = a fény felé néző tetősík, −1 = árnyékos */
  light: number;
}

function line(pts: number[], s: number): Line {
  const ax = pts[0] * s;
  const ay = pts[1] * s;
  const dx = pts[2] * s - ax;
  const dy = pts[3] * s - ay;
  return { ax, ay, dx, dy, len: Math.hypot(dx, dy) || 1e-6, light: 0 };
}

const perp = (l: Line, px: number, py: number): number => Math.abs((px - l.ax) * l.dy - (py - l.ay) * l.dx) / l.len;

/** A tetősík lejtésiránya: az eresz vonalára merőlegesen, a másik eresztől elfelé. */
function setLight(self: Line, other: Line): void {
  let nx = self.dy / self.len;
  let ny = -self.dx / self.len;
  if (nx * (other.ax - self.ax) + ny * (other.ay - self.ay) > 0) {
    nx = -nx;
    ny = -ny;
  }
  self.light = -(nx + ny) * 0.7071;
}

/** A sokszög éleitől mért legkisebb távolság és a legközelebbi él sorszáma (pixelben megadott pontra). */
function nearestEdge(poly: number[], s: number, px: number, py: number): { dist: number; edge: number; along: number } {
  const n = poly.length / 2;
  let dist = Infinity;
  let edge = 0;
  let along = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j * 2] * s;
    const ay = poly[j * 2 + 1] * s;
    const dx = poly[i * 2] * s - ax;
    const dy = poly[i * 2 + 1] * s - ay;
    const len = Math.hypot(dx, dy) || 1;
    // az él szakaszától (nem a meghosszabbított egyenesétől) mért távolság
    const proj = ((px - ax) * dx + (py - ay) * dy) / len;
    const u = Math.max(0, Math.min(len, proj));
    const d = Math.hypot(px - ax - (dx / len) * u, py - ay - (dy / len) * u);
    if (d < dist) {
      dist = d;
      edge = i;
      along = proj;
    }
  }
  return { dist, edge, along };
}

/**
 * Fotó alapján felvett tető: részenként nyeregtető (gerinc a két eresz között),
 * a részek találkozásánál a magasabb tetősík érvényesül – így alakul ki a vápa
 * és az oromfalas lépcső. Szegély, tetőablak-sáv, tornyok, szellőzők.
 */
export function drawLandmarkRoof(t: RasterTarget, b: BuildingFeature, spec: LandmarkBuilding, seq: number): void {
  const s = t.scale;
  const { buf, w } = t;
  const base = cssColor(spec.roofColor);
  const trim = spec.trimColor ? cssColor(spec.trimColor) : shade(base, 0.7);
  const outline = shade(base, 0.36);
  const ridge = shade(base, 0.62);
  const outlinePx = Math.max(1, 0.1 * s);
  const trimPx = 0.3 * s;
  const coursePx = Math.max(2, Math.round(0.33 * s));
  const tilePx = Math.max(2, Math.round(0.25 * s));

  const parts = (spec.parts ?? []).map((p) => {
    const a = line(p.eaveA, s);
    const e = line(p.eaveB, s);
    setLight(a, e);
    setLight(e, a);
    return { poly: p.polygon, a, e, r: p.ridgeAt, band: p.skylightBand };
  });
  // síkonként négy árnyalat: alap, sötétebb és világosabb cserép, cserépsor árnyéka
  const faceColors = new Uint32Array(parts.length * 8);
  parts.forEach((p, i) => {
    [p.a, p.e].forEach((l, side) => {
      const lit = shade(base, 0.9 + 0.14 * l.light);
      const k = (i * 2 + side) * 4;
      faceColors[k] = lit;
      faceColors[k + 1] = shade(lit, 0.92);
      faceColors[k + 2] = shade(lit, 1.06);
      faceColors[k + 3] = shade(lit, 0.82);
    });
  });

  fillRings(t, [b.pts], 0, 0, (idx, wx, wy) => {
    const px = wx + 0.5;
    const py = wy + 0.5;
    const dEdge = nearestEdge(b.pts, s, px, py).dist;
    if (dEdge < outlinePx) {
      buf[idx] = outline;
      return;
    }
    if (dEdge < trimPx) {
      buf[idx] = trim;
      return;
    }
    // a pontot lefedő részek közül a legmagasabb tetősík érvényes
    let best = -1;
    let bestH = -1;
    let side = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!pointInPolygon(px / s, py / s, p.poly)) continue;
      const hA = perp(p.a, px, py) / (2 * p.r);
      const hB = perp(p.e, px, py) / (2 * (1 - p.r));
      const h = Math.min(hA, hB);
      if (h > bestH) {
        bestH = h;
        best = i;
        side = hA <= hB ? 0 : 1;
      }
    }
    if (best < 0) {
      buf[idx] = shade(base, 0.86);
      return;
    }
    const part = parts[best];
    const eave = side ? part.e : part.a;
    const face = best * 2 + side;
    const id = seq * 64 + face + 1;
    faceBuf[idx] = id;
    const left = idx % w > 0 ? faceBuf[idx - 1] : 0;
    const up = idx >= w ? faceBuf[idx - w] : 0;
    if ((left && left !== id && (left - 1) >> 6 === seq) || (up && up !== id && (up - 1) >> 6 === seq)) {
      buf[idx] = ridge;
      return;
    }
    const d = perp(eave, px, py);
    const along = ((px - eave.ax) * eave.dx + (py - eave.ay) * eave.dy) / eave.len;
    // tetőablak-sáv
    if (part.band && side === 1) {
      const dm = d / s;
      if (dm >= part.band.fromEaveB && dm <= part.band.fromEaveB + part.band.width) {
        const frame = Math.floor(along / (1.3 * s)) !== Math.floor((along + 1.6) / (1.3 * s));
        const border = dm - part.band.fromEaveB < 0.12 || part.band.fromEaveB + part.band.width - dm < 0.12;
        buf[idx] = frame || border ? c(0x8e9296) : (hash(wx >> 2, wy >> 2) & 3) === 0 ? c(0x4a5a6c) : c(0x364452);
        return;
      }
    }
    const course = Math.floor(d / coursePx);
    if (d - course * coursePx < 1) {
      buf[idx] = faceColors[face * 4 + 3];
      return;
    }
    const col = Math.floor((along + (course & 1) * tilePx * 0.5) / tilePx);
    const v = hash(col + face * 131, course + 977) & 7;
    buf[idx] = faceColors[face * 4 + (v === 0 ? 1 : v === 1 ? 2 : 0)];
  });

  for (const tower of spec.towers ?? []) drawTower(t, tower, outlinePx);

  // szellőzők a tetőn
  for (const [x, y] of spec.vents ?? []) {
    const r = 0.3 * s;
    forDisc(t, x * s, y * s, r + 0.5 * s, (idx, dx, dy) => {
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r) buf[idx] = d2 < r * r * 0.3 ? c(0x3a3c40) : d2 < r * r * 0.7 ? c(0xb8bcc0) : c(0x6a6e72);
      else if ((dx - 0.3 * s) * (dx - 0.3 * s) + (dy - 0.3 * s) * (dy - 0.3 * s) <= r * r) buf[idx] = shade(buf[idx], 0.7);
    });
  }
}

/** Torony felülnézetben: lapos tetejű falazott tömb, vagy gúlasisak a falkorona fölött. */
function drawTower(t: RasterTarget, tower: LandmarkTower, outlinePx: number): void {
  const s = t.scale;
  const { buf } = t;
  const wall = cssColor(tower.wall);
  const top = cssColor(tower.top);
  const poly = tower.polygon;
  const n = poly.length / 2;

  if (tower.kind === 'spire') {
    // a sisak lapjainak megvilágítása az élek iránya szerint (a fény ÉNy-ról jön)
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      cx += poly[i * 2];
      cy += poly[i * 2 + 1];
    }
    cx /= n;
    cy /= n;
    const lights: number[] = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const mx = (poly[j * 2] + poly[i * 2]) / 2 - cx;
      const my = (poly[j * 2 + 1] + poly[i * 2 + 1]) / 2 - cy;
      const len = Math.hypot(mx, my) || 1;
      lights[i] = -(mx / len + my / len) * 0.7071;
    }
    const wallPx = 0.42 * s;
    const coursePx = Math.max(2, Math.round(0.33 * s));
    fillRings(t, [poly], 0, 0, (idx, wx, wy) => {
      const near = nearestEdge(poly, s, wx + 0.5, wy + 0.5);
      faceBuf[idx] = 0;
      if (near.dist < outlinePx * 1.4) buf[idx] = shade(wall, 0.45);
      else if (near.dist < wallPx) buf[idx] = wall; // a fehér falkorona
      else if (near.dist < wallPx + outlinePx) buf[idx] = shade(top, 0.5);
      else {
        // gúla: a legközelebbi oldal lapja; a lapok élei a csúcs felé futnak
        const lit = shade(top, 0.86 + 0.26 * lights[near.edge]);
        const course = Math.floor((near.dist - wallPx) / coursePx);
        buf[idx] = near.dist - wallPx - course * coursePx < 1 ? shade(lit, 0.84) : lit;
      }
    });
    // a csúcs gombja
    const r = 0.22 * s;
    forDisc(t, cx * s, cy * s, r, (idx, dx, dy) => {
      if (dx * dx + dy * dy <= r * r) buf[idx] = c(0xe8d27a);
    });
    return;
  }

  // lapos tetejű tömb: falkorona, belül burkolt tető
  fillRings(t, [poly], 0, 0, (idx, wx, wy) => {
    const d = nearestEdge(poly, s, wx + 0.5, wy + 0.5).dist;
    if (d < outlinePx * 1.4) buf[idx] = shade(wall, 0.4);
    else if (d < 0.22 * s) buf[idx] = c(0xcfcfca);
    else if (d < 0.75 * s) {
      // téglafal koronája
      const course = Math.floor(wy / Math.max(2, 0.18 * s));
      const stone = Math.floor((wx + (course & 1) * 0.2 * s) / Math.max(2, 0.4 * s));
      buf[idx] = shade(wall, 0.9 + (hash(stone, course) & 3) * 0.06);
    } else if (d < 0.75 * s + outlinePx) buf[idx] = shade(top, 0.6);
    else buf[idx] = (hash(wx, wy) & 7) === 0 ? shade(top, 0.92) : top;
    faceBuf[idx] = 0;
  });
}

// --- a tank fölé kerülő elemek ---------------------------------------------------------

const FLAG_SIZE = { length: 1.9, width: 1.1 };

/** Zászlók és lámpafejek az átlátszó hátterű lombrétegre. Visszaadja, hogy rajzolt-e valamit. */
export function drawLandmarkOverlay(map: GameMap, t: RasterTarget): boolean {
  const lm = map.data.landmarks;
  if (!lm) return false;
  const s = t.scale;
  const { buf } = t;
  let drawn = false;

  for (const p of lm.flagpoles) {
    // a zászlók a rudak sorára merőlegesen, a tér felé lobognak
    const angle = 0.7;
    const hl = (FLAG_SIZE.length / 2) * s;
    const hw = (FLAG_SIZE.width / 2) * s;
    const cx = p.x * s + Math.cos(angle) * hl;
    const cy = p.y * s + Math.sin(angle) * hl;
    forRect(t, cx, cy, angle, hl, hw, 0, (idx, u, v) => {
      // hullámzó szél: a zászló széle kissé ívelt
      const wave = Math.sin((u / s) * 4) * 0.08 * s;
      const vv = v + wave;
      if (Math.abs(vv) > hw) return;
      drawn = true;
      const q = (vv + hw) / (2 * hw); // 0..1 a zászló szélességében
      const edge = Math.min(hl - Math.abs(u), hw - Math.abs(vv)) < 1;
      let color: number;
      if (p.flag === 'hungary') color = q < 1 / 3 ? c(0xd43a3a) : q < 2 / 3 ? c(0xf4f4f4) : c(0x3a9a4a);
      else if (p.flag === 'eu') {
        const ring = Math.abs(Math.hypot(u, vv) - 0.32 * s) < 0.07 * s;
        color = ring ? c(0xffd83a) : c(0x2a4aa8);
      } else color = q < 0.5 ? c(0x2a5ab8) : c(0xf4f4f4);
      buf[idx] = edge ? shade(color, 0.7) : color;
    });
    const r = 0.16 * s;
    forDisc(t, p.x * s, p.y * s, r, (idx, dx, dy) => {
      if (dx * dx + dy * dy <= r * r) {
        buf[idx] = c(0xf4f4f4);
        drawn = true;
      }
    });
  }

  for (const [x, y] of lm.lamps) {
    const r = 0.34 * s;
    forDisc(t, x * s, y * s, r, (idx, dx, dy) => {
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) return;
      buf[idx] = d2 > r * r * 0.6 ? c(0x2e2e34) : d2 < r * r * 0.2 ? c(0xfff6d0) : c(0xc8c8cc);
      drawn = true;
    });
  }
  return drawn;
}
