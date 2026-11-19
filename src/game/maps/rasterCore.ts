// A térképrajzoló közös alapjai: célpuffer, színkezelés, zaj és a raszterizáló
// primitívek (sokszög, vastag vonal, korong). Nincs Phaser-függés.

export interface RasterTarget {
  /** ABGR (little-endian RGBA) pixelek, w*h elem */
  buf: Uint32Array;
  w: number;
  h: number;
  /** a kép bal felső sarkának helye világpixelben */
  ox: number;
  oy: number;
  /** pixel / méter */
  scale: number;
  /** true: részletes játéknézet; false: egyszerűsített (minitérkép) */
  detail: boolean;
}

export type Mat = (wx: number, wy: number) => number;
export type Put = (idx: number, wx: number, wy: number) => void;
export type StrokePut = (idx: number, wx: number, wy: number, dist: number, along: number) => void;

// --- színek és zaj -----------------------------------------------------------

/** 0xRRGGBB → a puffer ABGR formátuma. */
export function c(hex: number): number {
  return (0xff000000 | ((hex & 0xff) << 16) | (hex & 0xff00) | ((hex >> 16) & 0xff)) >>> 0;
}

/** '#rrggbb' → a puffer ABGR formátuma. */
export function cssColor(css: string): number {
  return c(parseInt(css.replace('#', ''), 16));
}

/** Szín szorzása (f > 1 világosít), csatornánként 255-re vágva. */
export function shade(color: number, f: number): number {
  const r = Math.min(255, ((color & 0xff) * f) | 0);
  const g = Math.min(255, (((color >> 8) & 0xff) * f) | 0);
  const b = Math.min(255, (((color >> 16) & 0xff) * f) | 0);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

export function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Sima értékzaj, 0..1. */
export function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const a = hash(xi, yi) & 255;
  const b = hash(xi + 1, yi) & 255;
  const d = hash(xi, yi + 1) & 255;
  const e = hash(xi + 1, yi + 1) & 255;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return (a + (b - a) * u + (d - a) * v + (a - b - d + e) * u * v) / 255;
}

/** Foltos felület: három közeli tónus sima zaj szerint, ritka pöttyökkel. */
export function mottled(s: number, sizeM: number, dark: number, mid: number, light: number, fleck: number, fleckChance: number): Mat {
  const k = 1 / (s * sizeM);
  const cd = c(dark);
  const cm = c(mid);
  const cl = c(light);
  const cf = c(fleck);
  return (wx, wy) => {
    const h = hash(wx, wy);
    if ((h & 1023) < fleckChance) return cf;
    const v = vnoise(wx * k, wy * k) * 0.72 + (((h >> 10) & 255) / 255) * 0.28;
    return v < 0.43 ? cd : v < 0.6 ? cm : cl;
  };
}

// --- raszterizáló primitívek ---------------------------------------------------

/** Sokszög kitöltése (even-odd), a pontok méterben; dx/dy pixeleltolás. */
export function fillRings(t: RasterTarget, rings: ArrayLike<number>[], dx: number, dy: number, put: Put): void {
  const s = t.scale;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rings) {
    for (let k = 1; k < r.length; k += 2) {
      const y = r[k] * s + dy;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const j0 = Math.max(0, Math.floor(minY - t.oy));
  const j1 = Math.min(t.h - 1, Math.ceil(maxY - t.oy));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const yc = t.oy + j + 0.5;
    xs.length = 0;
    for (const r of rings) {
      const n = r.length / 2;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const y0 = r[b * 2 + 1] * s + dy;
        const y1 = r[a * 2 + 1] * s + dy;
        if (y0 <= yc !== y1 <= yc) {
          const x0 = r[b * 2] * s + dx;
          const x1 = r[a * 2] * s + dx;
          xs.push(x0 + ((yc - y0) / (y1 - y0)) * (x1 - x0));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - 0.5 - t.ox));
      const i1 = Math.min(t.w - 1, Math.ceil(xs[k + 1] - 0.5 - t.ox) - 1);
      for (let i = i0; i <= i1; i++) put(j * t.w + i, t.ox + i, t.oy + j);
    }
  }
}

/** Vastag töröttvonal; hw a félszélesség pixelben. */
export function strokeLine(t: RasterTarget, pts: ArrayLike<number>, hw: number, put: StrokePut): void {
  const s = t.scale;
  const hw2 = hw * hw;
  let acc = 0;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k] * s;
    const ay = pts[k + 1] * s;
    const bx = pts[k + 2] * s;
    const by = pts[k + 3] * s;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw - t.ox));
    const i1 = Math.min(t.w - 1, Math.ceil(Math.max(ax, bx) + hw - t.ox));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by) - hw - t.oy));
    const j1 = Math.min(t.h - 1, Math.ceil(Math.max(ay, by) + hw - t.oy));
    for (let j = j0; j <= j1; j++) {
      const py = t.oy + j + 0.5 - ay;
      for (let i = i0; i <= i1; i++) {
        const px = t.ox + i + 0.5 - ax;
        const u = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
        const ex = px - u * dx;
        const ey = py - u * dy;
        const d2 = ex * ex + ey * ey;
        if (d2 <= hw2) put(j * t.w + i, t.ox + i, t.oy + j, Math.sqrt(d2), acc + u * len);
      }
    }
    acc += len;
  }
}

/** a strokeRing munkapufferei: a töröttvonaltól mért legkisebb távolság és a hozzá tartozó ívhossz */
let distBuf = new Float32Array(0);
let alongBuf = new Float32Array(0);
const touched: number[] = [];

/**
 * Sáv a töröttvonal mentén, a vonaltól `inner`..`outer` pixel távolságra (pl.
 * járda az úttest mellett). A távolság a teljes vonaltól mért legkisebb érték,
 * így a töréspontoknál nem keletkeznek ívek; a vonal két végén a sáv egyenesen
 * ér véget.
 */
export function strokeRing(t: RasterTarget, pts: ArrayLike<number>, inner: number, outer: number, put: StrokePut): void {
  const size = t.w * t.h;
  if (distBuf.length !== size) {
    distBuf = new Float32Array(size).fill(Infinity);
    alongBuf = new Float32Array(size);
  }
  let total = 0;
  for (let k = 0; k + 3 < pts.length; k += 2) total += Math.hypot(pts[k + 2] - pts[k], pts[k + 3] - pts[k + 1]);
  total *= t.scale;
  touched.length = 0;
  strokeLine(t, pts, outer, (idx, _wx, _wy, d, along) => {
    if (distBuf[idx] === Infinity) touched.push(idx);
    if (d < distBuf[idx]) {
      distBuf[idx] = d;
      alongBuf[idx] = along;
    }
  });
  for (const idx of touched) {
    const d = distBuf[idx];
    const along = alongBuf[idx];
    distBuf[idx] = Infinity;
    if (d >= inner && along > 0.5 && along < total - 0.5) put(idx, t.ox + (idx % t.w), t.oy + Math.floor(idx / t.w), d, along);
  }
}

/** Kör (és környéke) pixeleinek bejárása; a visszahívás a középponttól mért eltérést kapja pixelben. */
export function forDisc(t: RasterTarget, cx: number, cy: number, reach: number, fn: (idx: number, dx: number, dy: number, wx: number, wy: number) => void): void {
  const i0 = Math.max(0, Math.floor(cx - reach - t.ox));
  const i1 = Math.min(t.w - 1, Math.ceil(cx + reach - t.ox));
  const j0 = Math.max(0, Math.floor(cy - reach - t.oy));
  const j1 = Math.min(t.h - 1, Math.ceil(cy + reach - t.oy));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      fn(j * t.w + i, t.ox + i + 0.5 - cx, t.oy + j + 0.5 - cy, t.ox + i, t.oy + j);
    }
  }
}

/**
 * Elforgatott téglalap pixeleinek bejárása; (u, v) a téglalap saját tengelyei
 * szerinti eltérés pixelben (u a hossz, v a szélesség mentén). `pad`: ennyivel
 * nagyobb területet jár be (pl. árnyékhoz).
 */
export function forRect(
  t: RasterTarget,
  cx: number,
  cy: number,
  angle: number,
  halfL: number,
  halfW: number,
  pad: number,
  fn: (idx: number, u: number, v: number, wx: number, wy: number) => void,
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  forDisc(t, cx, cy, Math.hypot(halfL, halfW) + pad, (idx, dx, dy, wx, wy) => {
    const u = dx * cos + dy * sin;
    const v = dy * cos - dx * sin;
    if (Math.abs(u) <= halfL + pad && Math.abs(v) <= halfW + pad) fn(idx, u, v, wx, wy);
  });
}

// --- munkapufferek (a legutóbbi képmérethez igazodnak) -----------------------------

/** vetett árnyékok maszkja */
export let maskBuf = new Uint8Array(0);
/** tetősík-azonosítók a gerincvonalak felismeréséhez */
export let faceBuf = new Int32Array(0);
/** épülettel fedett pixelek: itt a talajt fölösleges kiszámolni, a tető úgyis eltakarja */
export let coverBuf = new Uint8Array(0);

export function scratch(size: number): void {
  if (maskBuf.length !== size) {
    maskBuf = new Uint8Array(size);
    faceBuf = new Int32Array(size);
    coverBuf = new Uint8Array(size);
  } else {
    maskBuf.fill(0);
    faceBuf.fill(0);
    coverBuf.fill(0);
  }
}
