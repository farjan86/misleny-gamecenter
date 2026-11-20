// A betöltött pálya futásidejű reprezentációja: térbeli indexek a rajzoláshoz,
// ütközési rács és út-keresés a szimulációhoz. Nincs Phaser-függés.

import { SegmentGrid } from '../sim/collision';
import { FELLABLE, Fellables, type FellableItem } from '../sim/props';
import { Structures } from '../sim/structures';
import type { NetRoad } from '../sim/roadnet';
import type { RoadGuide, Terrain, Weather } from '../sim/world';
import type { LandmarkBuilding, MapData, RoadFeature } from './types';

export type Box = [minX: number, minY: number, maxX: number, maxY: number];

export function boxOf(pts: ArrayLike<number>, pad = 0): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minY) minY = pts[i + 1];
    if (pts[i + 1] > maxY) maxY = pts[i + 1];
  }
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

export function boxesOverlap(a: Box, minX: number, minY: number, maxX: number, maxY: number): boolean {
  return a[0] <= maxX && a[2] >= minX && a[1] <= maxY && a[3] >= minY;
}

export function pointInPolygon(x: number, y: number, pts: ArrayLike<number>): boolean {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2];
    const yi = pts[i * 2 + 1];
    const xj = pts[j * 2];
    const yj = pts[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface NearestOnLine {
  dist: number;
  x: number;
  y: number;
  /** a legközelebbi szakasz irányszöge */
  angle: number;
}

export function nearestOnPolyline(x: number, y: number, pts: ArrayLike<number>): NearestOnLine {
  const best: NearestOnLine = { dist: Infinity, x: pts[0], y: pts[1], angle: 0 };
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i];
    const ay = pts[i + 1];
    const dx = pts[i + 2] - ax;
    const dy = pts[i + 3] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < best.dist) {
      best.dist = d;
      best.x = px;
      best.y = py;
      best.angle = Math.atan2(dy, dx);
    }
  }
  return best;
}

/** Főutak: nincs mellettük járda, csak padka. */
export const MAIN_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
/** Lakóutcák: úttest, füves sáv, járda. */
export const STREETS = new Set(['unclassified', 'residential', 'living_street']);
const DRIVABLE = new Set([...MAIN_ROADS, ...STREETS]);
/** Vízfelületek, amelyeken a tank nem tud áthajtani. */
const SOLID_AREAS = new Set(['water', 'pool']);
/** A fák törzsének és az oszlopoknak a sugara: ennek nekimenve (vagy eltalálva) dőlnek ki. */
const TREE_TRUNK_RADIUS = 0.4;
const POLE_RADIUS = 0.25;
/** Ennyi lövésnyom marad meg a pályán; fölötte a legrégebbiek tűnnek el. */
const MAX_SCARS = 3000;
/** Sebességszorzó burkolt úton kívül. */
const OFF_ROAD_FACTOR = 0.72;
/** A parkoló autók mérete méterben. */
export const CAR_SIZE = { length: 4.4, width: 1.9 };

/** Elforgatott téglalap sarkai lapított pontlistaként. */
export function rotatedRect(x: number, y: number, angle: number, halfLength: number, halfWidth: number): number[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const out: number[] = [];
  for (const [u, v] of [[-halfLength, -halfWidth], [halfLength, -halfWidth], [halfLength, halfWidth], [-halfLength, halfWidth]]) {
    out.push(x + u * cos - v * sin, y + u * sin + v * cos);
  }
  return out;
}

export interface Tree {
  x: number;
  y: number;
  /** lombsugár méterben */
  r: number;
  /** 0 lombos, 1 fenyő, 2 gyümölcsfa, 3 utcai sorfa */
  kind: number;
}

/**
 * Egyenletes rács elemek (sorszámok) térbeli kereséséhez: a rajzoló így csak a
 * közeli fákat, bokrokat, épületeket nézi végig, nem a pálya összes elemét.
 */
export class SpatialIndex {
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: number[][];
  private stamp = 0;
  private seen: Uint32Array = new Uint32Array(0);
  private count = 0;

  constructor(
    width: number,
    height: number,
    private readonly cell = 32,
  ) {
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  private clampCol(v: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor(v / this.cell)));
  }

  private clampRow(v: number): number {
    return Math.max(0, Math.min(this.rows - 1, Math.floor(v / this.cell)));
  }

  /** Elem felvétele a befoglaló dobozával. */
  add(index: number, minX: number, minY: number, maxX: number, maxY: number): void {
    this.count = Math.max(this.count, index + 1);
    for (let r = this.clampRow(minY); r <= this.clampRow(maxY); r++) {
      for (let c = this.clampCol(minX); c <= this.clampCol(maxX); c++) this.cells[r * this.cols + c].push(index);
    }
  }

  /** A dobozt érintő cellák elemei, mindegyik egyszer, növekvő sorszám szerint. */
  query(minX: number, minY: number, maxX: number, maxY: number): number[] {
    if (this.seen.length < this.count) this.seen = new Uint32Array(this.count);
    const stamp = ++this.stamp;
    const out: number[] = [];
    for (let r = this.clampRow(minY); r <= this.clampRow(maxY); r++) {
      for (let c = this.clampCol(minX); c <= this.clampCol(maxX); c++) {
        const list = this.cells[r * this.cols + c];
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (this.seen[i] !== stamp) {
            this.seen[i] = stamp;
            out.push(i);
          }
        }
      }
    }
    return out.sort((a, b) => a - b);
  }
}

export class GameMap implements Terrain {
  readonly width: number;
  readonly height: number;
  readonly walls: SegmentGrid;
  /** minden fa együtt: az OSM fasorai és a generált növényzet */
  readonly trees: Tree[];
  readonly areaBoxes: Box[];
  readonly streamBoxes: Box[];
  readonly roadBoxes: Box[];
  readonly barrierBoxes: Box[];
  readonly buildingBoxes: Box[];
  // térbeli indexek (sorszámok a megfelelő tömbökbe)
  readonly treeIndex: SpatialIndex;
  readonly buildingIndex: SpatialIndex;
  /** a decor.bushes tömb hármasainak sorszámai */
  readonly bushIndex: SpatialIndex;
  /** a decor.poles tömb párjainak sorszámai */
  readonly poleIndex: SpatialIndex;
  private readonly roadIndex: SpatialIndex;
  /**
   * Kidönthető tárgyak: előbb a fák (a `trees` tömb sorrendjében), utánuk a
   * villanyoszlopok (a decor.poles sorrendjében, `poleOffset`-tól).
   */
  readonly fellables: Fellables;
  readonly poleOffset: number;
  /** oszlop koordinátája → az oszlop sorszáma (a vezetékek rajzolásához) */
  readonly poleAt = new Map<string, number>();
  /** Ledönthető épületek (a data.buildings sorrendjében); a hivatal nem dönthető le. */
  readonly structures: Structures;
  /** a játéktér, ha a meccs a pályának csak egy részén folyik */
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  private borderOwner = -10;
  /** időjárás: a rajzolást (sár) és a talaj tapadását befolyásolja */
  weather: Weather = 'day';
  /** stopvonalak a főútra kiérkező utcák végén, lapítva: x, y, irány (rad), fél hossz */
  readonly stopLines: number[] = [];
  /** maradandó lövésnyomok, lapítva: x, y, sugár */
  readonly scars: number[] = [];
  scarIndex: SpatialIndex;
  /** fotók alapján felvett épületmegjelenések, OSM-azonosító szerint */
  readonly landmarkBuildings = new Map<number, LandmarkBuilding>();
  /** burkolt felületek az utakon kívül (tér, aszfaltozott udvar) */
  private pavedRings: number[][] = [];
  private pavedBox: Box = [0, 0, -1, -1];
  /** a közutak a hosszukkal, a véletlen helyek kisorsolásához (első használatkor épül fel) */
  private spotRoads: { road: RoadFeature; length: number }[] | null = null;
  private spotTotal = 0;
  /** a tárgyaknak, születési helynek használható utak játéktérbe eső hossza (m) */
  private spotInside = 0;

  /**
   * `collision: false` – csak rajzoláshoz (pl. háttérszálon): az ütközési rács
   * felépítése kimarad.
   */
  constructor(
    readonly data: MapData,
    options: { collision?: boolean } = {},
  ) {
    const { width, height } = data.meta;
    this.width = width;
    this.height = height;
    const street = data.meta.streetscape;
    this.areaBoxes = data.areas.map((a) => boxOf(a.rings.flat()));
    this.streamBoxes = data.streams.map((s) => boxOf(s.pts, s.width));
    // a füves sáv és a járda miatt a rajzolt sáv szélesebb az útnál
    this.roadBoxes = data.roads.map((r) => boxOf(r.pts, r.width / 2 + street.verge + street.sidewalk + 1));
    this.barrierBoxes = data.barriers.map((b) => boxOf(b.pts, 1));
    this.buildingBoxes = data.buildings.map((b) => boxOf(b.pts));

    this.buildingIndex = new SpatialIndex(width, height);
    this.buildingBoxes.forEach((b, i) => this.buildingIndex.add(i, b[0], b[1], b[2], b[3]));
    this.roadIndex = new SpatialIndex(width, height, 48);
    this.roadBoxes.forEach((b, i) => this.roadIndex.add(i, b[0], b[1], b[2], b[3]));

    this.walls = new SegmentGrid(width, height, 16);
    const walls = options.collision === false ? null : this.walls;
    // az épületek falainak gazdája az épület sorszáma: összedőléskor így kapcsolhatók ki
    data.buildings.forEach((b, i) => {
      walls?.addPolygon(b.pts, i);
      for (const h of b.holes ?? []) walls?.addPolygon(h, i);
    });
    this.structures = new Structures(
      data.buildings.map((b, i) => {
        const box = this.buildingBoxes[i];
        return { area: b.area, x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2, indestructible: b.townhall === true };
      }),
    );
    for (const a of data.areas) {
      if (SOLID_AREAS.has(a.kind)) for (const ring of a.rings) walls?.addPolygon(ring);
    }
    for (const b of data.barriers) walls?.addPolyline(b.pts);

    this.trees = data.trees.map((t, i) => ({ x: t.x, y: t.y, r: 2.5 + (i % 4) * 0.15, kind: 3 }));
    const dt = data.decor.trees;
    for (let i = 0; i + 3 < dt.length; i += 4) this.trees.push({ x: dt[i], y: dt[i + 1], r: dt[i + 2], kind: dt[i + 3] });
    this.treeIndex = new SpatialIndex(width, height);
    const fellable: FellableItem[] = [];
    this.trees.forEach((t, i) => {
      // az árnyék és a kidőlt fa (bármelyik irányba dőlhet) helyigényével együtt
      const reach = t.r * 2.6 + 1.5;
      this.treeIndex.add(i, t.x - reach, t.y - reach, t.x + reach, t.y + reach);
      fellable.push({ x: t.x, y: t.y, r: TREE_TRUNK_RADIUS, kind: FELLABLE.tree });
    });
    this.poleOffset = this.trees.length;

    const bushes = data.decor.bushes;
    this.bushIndex = new SpatialIndex(width, height);
    for (let i = 0; i + 2 < bushes.length; i += 3) {
      const r = bushes[i + 2] + 0.2;
      this.bushIndex.add(i / 3, bushes[i] - r, bushes[i + 1] - r, bushes[i] + r, bushes[i + 1] + r);
    }
    const poles = data.decor.poles;
    this.poleIndex = new SpatialIndex(width, height);
    for (let i = 0; i + 1 < poles.length; i += 2) {
      this.poleIndex.add(i / 2, poles[i] - 8, poles[i + 1] - 8, poles[i] + 8, poles[i + 1] + 8);
      fellable.push({ x: poles[i], y: poles[i + 1], r: POLE_RADIUS, kind: FELLABLE.pole });
      this.poleAt.set(`${poles[i]},${poles[i + 1]}`, i / 2);
    }
    this.fellables = new Fellables(width, height, fellable);
    this.scarIndex = new SpatialIndex(width, height);

    // Stopvonal ott, ahol egy utca vége főútra fut ki: a kereszteződés előtt, az érkező (jobb oldali) sávban.
    data.roads.forEach((road, i) => {
      if (!STREETS.has(road.kind)) return;
      const p = road.pts;
      const n = p.length;
      if (n < 4) return;
      for (const end of [0, 1]) {
        const ex = end ? p[n - 2] : p[0];
        const ey = end ? p[n - 1] : p[1];
        const bx = end ? p[n - 4] : p[2];
        const by = end ? p[n - 3] : p[3];
        const len = Math.hypot(ex - bx, ey - by);
        if (len < 4) continue;
        const dx = (ex - bx) / len;
        const dy = (ey - by) / len;
        for (const j of this.roadIndex.query(ex - 4, ey - 4, ex + 4, ey + 4)) {
          const other = data.roads[j];
          if (j === i || !MAIN_ROADS.has(other.kind)) continue;
          const hit = nearestOnPolyline(ex, ey, other.pts);
          if (hit.dist > 3) continue;
          const back = other.width / 2 + street.shoulder + 0.9;
          const half = road.width / 4;
          // a haladási irány jobb oldala (a képernyőn y lefelé nő)
          this.stopLines.push(ex - dx * back - dy * half, ey - dy * back + dx * half, Math.atan2(dy, dx), half - 0.3);
          break;
        }
      }
    });

    // a fotók alapján felvett tárgyak közül a parkoló autók és a zászlórudak akadályok
    const lm = data.landmarks;
    if (lm) {
      for (const b of lm.buildings) this.landmarkBuildings.set(b.id, b);
      for (const car of lm.cars) walls?.addPolygon(rotatedRect(car.x, car.y, car.angle, CAR_SIZE.length / 2, CAR_SIZE.width / 2));
      for (const pole of lm.flagpoles) walls?.addCircle(pole.x, pole.y, 0.15, 6);
      this.pavedRings = lm.areas.filter((a) => a.kind === 'plaza' || a.kind === 'asphalt').map((a) => a.ring);
      if (this.pavedRings.length) this.pavedBox = boxOf(this.pavedRings.flat());
    }
  }

  /** A ponthoz legközelebbi út (opcionálisan csak a járművel járható utak közül). */
  nearestRoad(x: number, y: number, maxDist: number, drivableOnly = false): { road: RoadFeature; hit: NearestOnLine } | null {
    let best: { road: RoadFeature; hit: NearestOnLine } | null = null;
    const { roads } = this.data;
    for (const i of this.roadIndex.query(x - maxDist, y - maxDist, x + maxDist, y + maxDist)) {
      const road = roads[i];
      if (drivableOnly && !DRIVABLE.has(road.kind)) continue;
      if (!boxesOverlap(this.roadBoxes[i], x - maxDist, y - maxDist, x + maxDist, y + maxDist)) continue;
      const hit = nearestOnPolyline(x, y, road.pts);
      if (hit.dist <= maxDist && (!best || hit.dist < best.hit.dist)) best = { road, hit };
    }
    return best;
  }

  /** A ponthoz legközelebbi, névvel rendelkező út neve (az úttest szélétől mért `reach` méteren belül). */
  streetNameAt(x: number, y: number, reach = 16): string {
    const { roads } = this.data;
    let best = reach;
    let name = '';
    for (const i of this.roadIndex.query(x - reach, y - reach, x + reach, y + reach)) {
      const road = roads[i];
      if (!road.name) continue;
      const d = nearestOnPolyline(x, y, road.pts).dist - road.width / 2;
      if (d < best) {
        best = d;
        name = road.name;
      }
    }
    return name;
  }

  speedFactor(x: number, y: number): number {
    const { roads } = this.data;
    for (const i of this.roadIndex.query(x, y, x, y)) {
      const road = roads[i];
      const reach = road.width / 2 + 1;
      if (!boxesOverlap(this.roadBoxes[i], x - reach, y - reach, x + reach, y + reach)) continue;
      if (nearestOnPolyline(x, y, road.pts).dist <= reach) return 1;
    }
    if (boxesOverlap(this.pavedBox, x, y, x, y)) {
      for (const ring of this.pavedRings) if (pointInPolygon(x, y, ring)) return 1;
    }
    return OFF_ROAD_FACTOR;
  }

  /**
   * A ponthoz legközelebbi tetőpont: maga a pont, ha épületen van, különben a
   * `reach` méterre lévő környezetének első olyan pontja, amely épületre esik
   * (a lövedék a falnál robban, a tűz a tetőn ég). null, ha nincs a közelben épület.
   */
  roofNear(x: number, y: number, reach = 1.5): { x: number; y: number } | null {
    const { buildings } = this.data;
    const onRoof = (px: number, py: number): boolean => {
      for (const n of this.buildingIndex.query(px, py, px, py)) if (!this.structures.collapsed[n] && pointInPolygon(px, py, buildings[n].pts)) return true;
      return false;
    };
    if (onRoof(x, y)) return { x, y };
    for (let k = 0; k < 8; k++) {
      const px = x + Math.cos((k * Math.PI) / 4) * reach;
      const py = y + Math.sin((k * Math.PI) / 4) * reach;
      if (onRoof(px, py)) return { x: px, y: py };
    }
    return null;
  }

  /** Igaz, ha a pont valamelyik fa lombkoronája alatt van. */
  underCanopy(x: number, y: number): boolean {
    for (const i of this.treeIndex.query(x, y, x, y)) {
      if (this.fellables.fallen[i]) continue;
      const t = this.trees[i];
      const dx = t.x - x;
      const dy = t.y - y;
      if (dx * dx + dy * dy < t.r * t.r * 0.8) return true;
    }
    return false;
  }

  /**
   * Véletlen pont egy közút úttestjén (felvehető tárgynak, újraéledő botnak).
   * Az utak a hosszuk arányában kerülnek sorra, így a tárgyak egyenletesen
   * oszlanak el a városban. null, ha a kisorsolt hely nem használható.
   */
  pickupSpot(rnd: () => number): { x: number; y: number } | null {
    const area = this.bounds;
    if (!this.spotRoads) {
      this.spotRoads = [];
      this.spotTotal = 0;
      this.spotInside = 0;
      this.data.roads.forEach((road, ri) => {
        if (!DRIVABLE.has(road.kind) || road.kind.startsWith('motorway')) return;
        // a játéktéren kívüli utak kimaradnak
        if (area && !boxesOverlap(this.roadBoxes[ri], area.minX, area.minY, area.maxX, area.maxY)) return;
        let length = 0;
        // a játéktérbe eső hossz (a szakaszok felezőpontja szerint)
        let inside = 0;
        for (let i = 0; i + 3 < road.pts.length; i += 2) {
          const len = Math.hypot(road.pts[i + 2] - road.pts[i], road.pts[i + 3] - road.pts[i + 1]);
          length += len;
          const mx = (road.pts[i] + road.pts[i + 2]) / 2;
          const my = (road.pts[i + 1] + road.pts[i + 3]) / 2;
          if (!area || (mx > area.minX + 6 && my > area.minY + 6 && mx < area.maxX - 6 && my < area.maxY - 6)) inside += len;
        }
        // amelyik út csak a befoglaló téglalapjával ér a játéktérbe, arra nem kerülhet semmi
        if (inside <= 0) return;
        this.spotRoads!.push({ road, length });
        this.spotTotal += length;
        this.spotInside += inside;
      });
    }
    // nagyon kicsi játéktéren alig (vagy egyáltalán nem) van út: ott bármelyik szabad pont megfelel
    if (area && this.spotInside < 60) {
      const x = area.minX + 8 + rnd() * Math.max(0, area.maxX - area.minX - 16);
      const y = area.minY + 8 + rnd() * Math.max(0, area.maxY - area.minY - 16);
      return this.walls.resolveCircle(x, y, 3).hit ? null : { x, y };
    }
    let roll = rnd() * this.spotTotal;
    let pick = this.spotRoads[0];
    for (const entry of this.spotRoads) {
      pick = entry;
      roll -= entry.length;
      if (roll < 0) break;
    }
    if (!pick) return null;
    // a kisorsolt út véletlen pontja, a tengelytől oldalra eltolva (az úttesten belül)
    const pts = pick.road.pts;
    let along = rnd() * pick.length;
    const side = (rnd() - 0.5) * Math.max(0, pick.road.width - 4.6);
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const dx = pts[i + 2] - pts[i];
      const dy = pts[i + 3] - pts[i + 1];
      const len = Math.hypot(dx, dy);
      if (along > len) {
        along -= len;
        continue;
      }
      const t = len > 0 ? along / len : 0;
      const x = pts[i] + dx * t - (dy / (len || 1)) * side;
      const y = pts[i + 1] + dy * t + (dx / (len || 1)) * side;
      if (x < 6 || y < 6 || x > this.width - 6 || y > this.height - 6) return null;
      if (area && (x < area.minX + 6 || y < area.minY + 6 || x > area.maxX - 6 || y > area.maxY - 6)) return null;
      if (this.walls.resolveCircle(x, y, 2).hit) return null;
      return { x, y };
    }
    return null;
  }

  /** A járművel járható közutak (a forgalom úthálózatához). */
  driveRoads(): NetRoad[] {
    return this.data.roads.filter((r) => DRIVABLE.has(r.kind) && !r.kind.startsWith('motorway')).map((r) => ({ pts: r.pts, width: r.width, main: MAIN_ROADS.has(r.kind) }));
  }

  /** A legközelebbi közút pontja és iránya (a botok útkövetéséhez). */
  roadGuide(x: number, y: number): RoadGuide | null {
    const near = this.nearestRoad(x, y, 45, true);
    if (!near) return null;
    return { x: near.hit.x, y: near.hit.y, angle: near.hit.angle, width: near.road.width };
  }

  /**
   * Maradandó lövésnyom felvétele. Visszaadja, hogy bekerült-e (a nagyon közeli,
   * nem kisebb nyom mellé nem kerül újabb). A fő szálon és a háttérszálakon
   * ugyanabban a sorrendben hívva mindenhol ugyanaz az állapot áll elő.
   */
  addScar(x: number, y: number, r: number): boolean {
    for (const i of this.scarIndex.query(x - 0.6, y - 0.6, x + 0.6, y + 0.6)) {
      if (this.scars[i * 3 + 2] >= r && Math.hypot(this.scars[i * 3] - x, this.scars[i * 3 + 1] - y) < 0.6) return false;
    }
    if (this.scars.length / 3 >= MAX_SCARS) {
      // a legrégebbi nyomok eltűnnek; az index újraépül
      this.scars.splice(0, (MAX_SCARS / 5) * 3);
      this.scarIndex = new SpatialIndex(this.width, this.height);
      for (let i = 0; i < this.scars.length; i += 3) this.indexScar(i / 3);
    }
    this.scars.push(x, y, r);
    this.indexScar(this.scars.length / 3 - 1);
    return true;
  }

  private indexScar(n: number): void {
    const x = this.scars[n * 3];
    const y = this.scars[n * 3 + 1];
    const r = this.scars[n * 3 + 2] * 1.3;
    this.scarIndex.add(n, x - r, y - r, x + r, y + r);
  }

  /**
   * A játéktér kijelölése (méterben; null: a teljes pálya). A határ fal: a
   * tankok nem mennek át rajta, a lövedék ott becsapódik.
   */
  setArea(area: { minX: number; minY: number; maxX: number; maxY: number } | null): void {
    this.walls.setOwnerEnabled(this.borderOwner, false);
    this.bounds = area;
    this.spotRoads = null;
    this.spotInside = 0;
    if (!area) return;
    this.borderOwner--;
    this.walls.addPolygon([area.minX, area.minY, area.maxX, area.minY, area.maxX, area.maxY, area.minX, area.maxY], this.borderOwner);
  }

  /** Épület összedőlése (a szimuláció eseményéből, a megjelenítés oldalán): a falai eltűnnek. */
  collapse(index: number): void {
    this.structures.damage(index, Infinity);
    this.walls.setOwnerEnabled(index, false);
  }

  /** Új kör: minden fa, oszlop és épület újra áll, a lövésnyomok eltűnnek. */
  resetDamage(): void {
    for (let i = 0; i < this.structures.count; i++) if (this.structures.collapsed[i]) this.walls.setOwnerEnabled(i, true);
    this.structures.reset();
    this.fellables.reset();
    this.scars.length = 0;
    this.scarIndex = new SpatialIndex(this.width, this.height);
  }

  /** Kezdőpont: a hivatalhoz legközelebbi közút tengelyvonalán. */
  spawnPoint(): { x: number; y: number; angle: number } {
    const th = this.data.townhall;
    const near = this.nearestRoad(th.x, th.y, 200, true);
    if (!near) return { x: th.x, y: th.y, angle: 0 };
    return { x: near.hit.x, y: near.hit.y, angle: near.hit.angle };
  }
}

export async function loadGameMap(url: string): Promise<GameMap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`A pályafájl nem tölthető be (${res.status}): ${url}`);
  return new GameMap((await res.json()) as MapData);
}
