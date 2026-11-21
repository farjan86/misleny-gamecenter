// Ajánlott játéktér: adott méretű (km²) területet választ a pályán véletlenszerűen, de „jó helyen”:
// ahol van elég út (hol mozogni) és épület (takarás, rombolnivaló), nem üres szántón vagy erdőben.
// A pályakijelölő rács celláival dolgozik (lásd MATCH.cell); tiszta logika, a tesztek Node alatt futtatják.

import type { MapData } from '../maps/types';

export interface CellRect {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

/** a mozgásra alkalmas utak (a gyalogutak nem számítanak) */
const ROAD_KINDS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'track']);
/** egy cella legfeljebb ennyi út-, illetve épületpontot ér (a sűrű belváros se nyomjon el mindent) */
const ROAD_CAP = 300;
const BUILDING_CAP = 14;
/** a jelöltek közül a legjobb ennyi közül választ véletlenszerűen */
const TOP = 8;
/** a játéktér kissé fekvő (mint a képernyő) */
const ASPECT = 1.3;
/** ennyi út (m) kell egy cellában, hogy utcás cellának számítson */
const STREET_CELL = 40;
/** a kijelölt cellák legalább ekkora részében legyen utca, és legfeljebb ekkora részük lehet víz */
export const MIN_STREET_SHARE = 0.6;
export const MAX_WATER_SHARE = 0.15;
const WATER_KINDS = new Set(['water', 'pool', 'reservoir', 'basin', 'wetland']);

interface Cells {
  score: Float64Array;
  /** 1, ha a cellában van utca */
  street: Float64Array;
  /** 1, ha a cella nagyobb része víz */
  water: Float64Array;
}
const cache = new WeakMap<MapData, Cells>();

function inside(x: number, y: number, ring: number[]): boolean {
  let hit = false;
  for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Cellánként: mennyire játszható (0–2: az út és az épületek aránya a felső korláthoz), van-e utca, víz-e. */
function cellScores(data: MapData, cols: number, rows: number): Cells {
  const cached = cache.get(data);
  if (cached && cached.score.length === cols * rows) return cached;
  const cw = data.meta.width / cols;
  const ch = data.meta.height / rows;
  const roads = new Float64Array(cols * rows);
  const buildings = new Float64Array(cols * rows);
  const cellOf = (x: number, y: number): number => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor(x / cw)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor(y / ch)));
    return r * cols + c;
  };
  for (const road of data.roads) {
    if (!ROAD_KINDS.has(road.kind)) continue;
    const p = road.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      // a szakasz hosszát a felezőpontja cellájához adjuk (hosszú szakaszt darabolva)
      const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      const parts = Math.max(1, Math.ceil(len / 40));
      for (let k = 0; k < parts; k++) {
        const t = (k + 0.5) / parts;
        roads[cellOf(p[i] + (p[i + 2] - p[i]) * t, p[i + 1] + (p[i + 3] - p[i + 1]) * t)] += len / parts;
      }
    }
  }
  for (const b of data.buildings) {
    let x = 0;
    let y = 0;
    const n = b.pts.length / 2;
    for (let i = 0; i < b.pts.length; i += 2) {
      x += b.pts[i] / n;
      y += b.pts[i + 1] / n;
    }
    buildings[cellOf(x, y)]++;
  }
  // víz: a cella 9 mintapontjából legalább 5 valamelyik vízfelületen van
  const water = new Float64Array(cols * rows);
  const lakes = data.areas.filter((a) => WATER_KINDS.has(a.kind));
  if (lakes.length) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let wet = 0;
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            const x = (c + (i + 0.5) / 3) * cw;
            const y = (r + (j + 0.5) / 3) * ch;
            if (lakes.some((a) => a.rings.some((ring) => inside(x, y, ring)))) wet++;
          }
        }
        water[r * cols + c] = wet >= 5 ? 1 : 0;
      }
    }
  }
  const score = new Float64Array(cols * rows);
  const street = new Float64Array(cols * rows);
  for (let i = 0; i < score.length; i++) {
    street[i] = roads[i] >= STREET_CELL ? 1 : 0;
    score[i] = water[i] ? 0 : Math.min(roads[i], ROAD_CAP) / ROAD_CAP + Math.min(buildings[i], BUILDING_CAP) / BUILDING_CAP;
  }
  const cells = { score, street, water };
  cache.set(data, cells);
  return cells;
}

/** Összegtábla: egy w × h-s téglalap összege négy kivonással. */
function summed(values: Float64Array, cols: number, rows: number): (c0: number, r0: number, w: number, h: number) => number {
  const sum = new Float64Array((cols + 1) * (rows + 1));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      sum[(r + 1) * (cols + 1) + c + 1] = values[r * cols + c] + sum[r * (cols + 1) + c + 1] + sum[(r + 1) * (cols + 1) + c] - sum[r * (cols + 1) + c];
    }
  }
  return (c0, r0, w, h) => sum[(r0 + h) * (cols + 1) + c0 + w] - sum[r0 * (cols + 1) + c0 + w] - sum[(r0 + h) * (cols + 1) + c0] + sum[r0 * (cols + 1) + c0];
}

/** Egy cellatartomány jellemzői: az utcás és a vizes cellák aránya. */
export function areaShares(data: MapData, cols: number, rows: number, rect: CellRect): { street: number; water: number } {
  const cells = cellScores(data, cols, rows);
  let street = 0;
  let water = 0;
  let n = 0;
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      street += cells.street[r * cols + c];
      water += cells.water[r * cols + c];
      n++;
    }
  }
  return { street: n ? street / n : 0, water: n ? water / n : 0 };
}

/** A kívánt területhez (km²) illő cellaméret: kissé fekvő téglalap, legalább `minCells` × `minCells`. */
export function areaCells(km2: number, data: MapData, cols: number, rows: number, minCells: number): { w: number; h: number } {
  const cw = data.meta.width / cols;
  const ch = data.meta.height / rows;
  const side = Math.sqrt(Math.max(0, km2)) * 1000;
  const w = Math.max(minCells, Math.min(cols, Math.round((side * Math.sqrt(ASPECT)) / cw)));
  const h = Math.max(minCells, Math.min(rows, Math.round(side / Math.sqrt(ASPECT) / ch)));
  return { w, h };
}

/**
 * Ajánlott játéktér: a kívánt méretű téglalapok közül (a rács minden helyén) a legjobban
 * játszható néhány közül egyet véletlenszerűen. `avoid`: az előző ajánlat – a „Másik helyszín”
 * gomb ne ugyanazt adja vissza.
 */
export function pickArea(data: MapData, cols: number, rows: number, km2: number, minCells: number, rnd: () => number, avoid?: CellRect): CellRect {
  const cells = cellScores(data, cols, rows);
  const { w, h } = areaCells(km2, data, cols, rows, minCells);
  const score = summed(cells.score, cols, rows);
  const street = summed(cells.street, cols, rows);
  const water = summed(cells.water, cols, rows);
  const all: { c0: number; r0: number; s: number; ok: boolean }[] = [];
  for (let r0 = 0; r0 + h <= rows; r0++) {
    for (let c0 = 0; c0 + w <= cols; c0++) {
      const n = w * h;
      // játszható: elég utca, kevés víz – ami nem az, csak végső esetben jöhet szóba
      const ok = street(c0, r0, w, h) / n >= MIN_STREET_SHARE && water(c0, r0, w, h) / n <= MAX_WATER_SHARE;
      // a teljesen egyforma jelöltek közül is legyen véletlen a sorrend
      all.push({ c0, r0, s: score(c0, r0, w, h) / n + rnd() * 0.02, ok });
    }
  }
  const playable = all.filter((c) => c.ok);
  const candidates = playable.length ? playable : all;
  candidates.sort((a, b) => b.s - a.s);
  // a legjobbak közül; egymáshoz túl közeli jelöltek közül csak egy (különben a „másik helyszín” alig mozdulna)
  const picked: { c0: number; r0: number }[] = [];
  for (const cand of candidates) {
    if (picked.length >= TOP) break;
    if (picked.some((p) => Math.abs(p.c0 - cand.c0) < Math.max(2, w / 2) && Math.abs(p.r0 - cand.r0) < Math.max(2, h / 2))) continue;
    if (avoid && Math.abs(avoid.c0 - cand.c0) < Math.max(2, w / 2) && Math.abs(avoid.r0 - cand.r0) < Math.max(2, h / 2)) continue;
    picked.push(cand);
  }
  const choice = picked.length ? picked[Math.floor(rnd() * picked.length)] : (candidates[0] ?? { c0: 0, r0: 0 });
  return { c0: choice.c0, r0: choice.r0, c1: choice.c0 + w - 1, r1: choice.r0 + h - 1 };
}
