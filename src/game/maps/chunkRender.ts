// Egy térképdarab kirajzolása élsimítással. A rajzoló a darabot a végleges
// méret többszörösében (SUPERSAMPLE) készíti el, majd átlagolva kicsinyíti le:
// így a ferde élek (tetők, utak, lombok széle) nem lépcsősek. A többletmunka a
// darab egyszeri kirajzolását terheli (háttérszálon), a játék képkockáit nem.

import type { GameMap } from './GameMap';
import { renderCanopy, renderMap } from './raster';

/**
 * Ennyiszeres felbontásban rajzolunk élenként (2 → négyszer annyi pixel, 4 minta
 * átlaga; 1 → nincs élsimítás). Gyenge gépen a ChunkLayer 1-re állítja.
 */
let supersample = 2;

export function setSupersample(value: number): void {
  supersample = value >= 2 ? 2 : 1;
}

export function getSupersample(): number {
  return supersample;
}

let hiGround = new Uint32Array(0);
let hiCanopy = new Uint32Array(0);

export interface RenderedChunk {
  /** a talajréteg RGBA pixelei */
  ground: Uint32Array;
  /** a lombréteg RGBA pixelei, vagy null, ha a darabon nincs lomb */
  canopy: Uint32Array | null;
}

/** Átlagolás: a teljesen fedő talajréteg csatornánként. */
function shrinkOpaque(src: Uint32Array, size: number, out: Uint32Array): void {
  const k = supersample;
  const hi = size * k;
  const n = k * k;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < k; j++) {
        const row = (y * k + j) * hi + x * k;
        for (let i = 0; i < k; i++) {
          const px = src[row + i];
          r += px & 255;
          g += (px >>> 8) & 255;
          b += (px >>> 16) & 255;
        }
      }
      out[y * size + x] = (0xff000000 | (((b / n) | 0) << 16) | (((g / n) | 0) << 8) | ((r / n) | 0)) >>> 0;
    }
  }
}

/** Átlagolás átlátszósággal: a szín a fedő minták átlaga, az átlátszóság a fedettség aránya. */
function shrinkAlpha(src: Uint32Array, size: number, out: Uint32Array): void {
  const k = supersample;
  const hi = size * k;
  const n = k * k;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < k; j++) {
        const row = (y * k + j) * hi + x * k;
        for (let i = 0; i < k; i++) {
          const px = src[row + i];
          const alpha = px >>> 24;
          if (alpha === 0) continue;
          a += alpha;
          r += (px & 255) * alpha;
          g += ((px >>> 8) & 255) * alpha;
          b += ((px >>> 16) & 255) * alpha;
        }
      }
      out[y * size + x] = a === 0 ? 0 : ((((a / n) | 0) << 24) | (((b / a) | 0) << 16) | (((g / a) | 0) << 8) | ((r / a) | 0)) >>> 0;
    }
  }
}

/** A (cx, cy) darab kirajzolása `size` × `size` pixelre, `ppm` pixel/méter részletességgel. */
export function renderChunk(map: GameMap, cx: number, cy: number, size: number, ppm: number): RenderedChunk {
  const k = supersample;
  if (k === 1) {
    // élsimítás nélkül: közvetlenül a végleges méretben
    const target = { w: size, h: size, ox: cx * size, oy: cy * size, scale: ppm, detail: true };
    const ground = new Uint32Array(size * size);
    renderMap(map, { ...target, buf: ground });
    const canopy = new Uint32Array(size * size);
    return { ground, canopy: renderCanopy(map, { ...target, buf: canopy }) ? canopy : null };
  }
  const hi = size * k;
  if (hiGround.length !== hi * hi) {
    hiGround = new Uint32Array(hi * hi);
    hiCanopy = new Uint32Array(hi * hi);
  }
  const target = { w: hi, h: hi, ox: cx * hi, oy: cy * hi, scale: ppm * k, detail: true };

  hiGround.fill(0);
  renderMap(map, { ...target, buf: hiGround });
  const ground = new Uint32Array(size * size);
  shrinkOpaque(hiGround, size, ground);

  const hasCanopy = renderCanopy(map, { ...target, buf: hiCanopy });
  let canopy: Uint32Array | null = null;
  if (hasCanopy) {
    canopy = new Uint32Array(size * size);
    shrinkAlpha(hiCanopy, size, canopy);
  }
  return { ground, canopy };
}
