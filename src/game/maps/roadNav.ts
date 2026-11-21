// GPS-útvonaltervező: csak a normál (autós) utakon vezet – fő utak, lakóutcák, kiszolgáló utak –,
// gyalogúton, kerékpárúton, földúton és zöldterületen nem. A térkép útjaiból gráfot épít (a
// csomópontok az utak töréspontjai, legfeljebb STEP méterenként), és ezen keresi a legrövidebb utat
// (A*). Tiszta logika, a játék nélkül is tesztelhető.

import type { RoadFeature } from './types';

/** Ezek nem „normál” utak: a GPS nem használja őket (ugyanaz a felosztás, mint a rajzolásnál). */
export const NAV_EXCLUDED = new Set(['path', 'footway', 'steps', 'cycleway', 'track', 'pedestrian', 'bridleway', 'corridor']);

/** Az élek legfeljebb ilyen hosszúak (m): így a vetítés és a játéktér szélén a vágás is pontos. */
const STEP = 8;
/** A zsákutca vége ennyin belül (m) hozzákapcsolódik egy másik úthoz (a térképen nem mindig közös a pont). */
const JOIN = 5;
/** A térbeli rács cellamérete (m). */
const CELL = 16;
/** A tank ennyin belül (m) „az úton van”: onnan indul; messzebbről a fő úthálózat legközelebbi pontjához megy. */
const ON_ROAD = 8;
/** Az ennél kisebb (csomópontszámú) úthálózat-darabok csak akkor számítanak, ha a tank éppen rajtuk áll. */
const SMALL_PART = 25;

export interface Area {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Pont az úthálózaton: az u–v él t arányú pontja. */
interface RoadPoint {
  u: number;
  v: number;
  t: number;
  x: number;
  y: number;
  d: number;
}

export interface Route {
  /** az útvonal pontjai sorban (x, y párok): a tanktól az úton át az utolsó útpontig */
  points: number[];
  /** az útvonal hossza (m) a tanktól az utolsó útpontig */
  length: number;
  /** az utolsó útpont (a célhoz legközelebbi pont az úton) */
  end: { x: number; y: number };
}

export class RoadNav {
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly adj: number[][] = [];
  /** az élek (csomópontpárok) és a térbeli rácsuk */
  private readonly edges: [number, number][] = [];
  private readonly grid = new Map<number, number[]>();
  private readonly cols: number;
  /** csomópontonként az úthálózat-darab (összefüggő komponens) sorszáma, és a darabok mérete */
  private readonly part: Int32Array;
  private readonly partSize: number[] = [];
  private readonly ids = new Map<string, number>();

  constructor(
    roads: readonly RoadFeature[],
    private readonly area: Area,
  ) {
    this.cols = Math.ceil((area.maxX - area.minX) / CELL) + 1;
    const inside = (x: number, y: number): boolean => x > area.minX + 1 && x < area.maxX - 1 && y > area.minY + 1 && y < area.maxY - 1;
    for (const road of roads) {
      if (NAV_EXCLUDED.has(road.kind)) continue;
      const p = road.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i];
        const ay = p[i + 1];
        const bx = p[i + 2];
        const by = p[i + 3];
        const len = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.ceil(len / STEP));
        for (let k = 0; k < n; k++) {
          const x1 = ax + ((bx - ax) * k) / n;
          const y1 = ay + ((by - ay) * k) / n;
          const x2 = ax + ((bx - ax) * (k + 1)) / n;
          const y2 = ay + ((by - ay) * (k + 1)) / n;
          // a játéktéren kívüli darab kimarad (a határ fal)
          if (!inside(x1, y1) || !inside(x2, y2)) continue;
          this.link(this.node(x1, y1), this.node(x2, y2));
        }
      }
    }
    this.joinDeadEnds();
    for (let e = 0; e < this.edges.length; e++) this.index(e);
    // összefüggő darabok
    this.part = new Int32Array(this.xs.length).fill(-1);
    for (let s = 0; s < this.xs.length; s++) {
      if (this.part[s] >= 0) continue;
      const id = this.partSize.length;
      let size = 0;
      const stack = [s];
      this.part[s] = id;
      while (stack.length) {
        const u = stack.pop()!;
        size++;
        for (const v of this.adj[u]) {
          if (this.part[v] < 0) {
            this.part[v] = id;
            stack.push(v);
          }
        }
      }
      this.partSize.push(size);
    }
  }

  /** A csomópontok száma (tesztekhez). */
  get size(): number {
    return this.xs.length;
  }

  private node(x: number, y: number): number {
    const key = `${Math.round(x * 20)},${Math.round(y * 20)}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.xs.length;
      this.ids.set(key, id);
      this.xs.push(x);
      this.ys.push(y);
      this.adj.push([]);
    }
    return id;
  }

  private link(a: number, b: number): void {
    if (a === b || this.adj[a].includes(b)) return;
    this.adj[a].push(b);
    this.adj[b].push(a);
    this.edges.push([a, b]);
  }

  /** A zsákutcák végét a közeli másik úthoz kapcsolja (ha a térképen nincs közös pontjuk). */
  private joinDeadEnds(): void {
    const near = new Map<number, number[]>();
    const key = (cx: number, cy: number): number => cy * 100000 + cx;
    for (let i = 0; i < this.xs.length; i++) {
      const k = key(Math.floor(this.xs[i] / JOIN), Math.floor(this.ys[i] / JOIN));
      let list = near.get(k);
      if (!list) near.set(k, (list = []));
      list.push(i);
    }
    const ends = this.adj.map((list, i) => (list.length === 1 ? i : -1)).filter((i) => i >= 0);
    for (const i of ends) {
      // a saját útszakaszának közeli pontjai (két lépésen belül) nem számítanak
      const own = new Set<number>([i, ...this.adj[i], ...this.adj[i].flatMap((j) => this.adj[j])]);
      const cx = Math.floor(this.xs[i] / JOIN);
      const cy = Math.floor(this.ys[i] / JOIN);
      let best = -1;
      let bestD = JOIN;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const j of near.get(key(cx + dx, cy + dy)) ?? []) {
            if (own.has(j)) continue;
            const d = Math.hypot(this.xs[j] - this.xs[i], this.ys[j] - this.ys[i]);
            if (d < bestD) {
              bestD = d;
              best = j;
            }
          }
        }
      }
      if (best >= 0) this.link(i, best);
    }
  }

  private index(e: number): void {
    const [a, b] = this.edges[e];
    const x0 = Math.floor((Math.min(this.xs[a], this.xs[b]) - this.area.minX) / CELL);
    const x1 = Math.floor((Math.max(this.xs[a], this.xs[b]) - this.area.minX) / CELL);
    const y0 = Math.floor((Math.min(this.ys[a], this.ys[b]) - this.area.minY) / CELL);
    const y1 = Math.floor((Math.max(this.ys[a], this.ys[b]) - this.area.minY) / CELL);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * this.cols + cx;
        let list = this.grid.get(c);
        if (!list) this.grid.set(c, (list = []));
        list.push(e);
      }
    }
  }

  /**
   * A ponthoz legközelebbi útpont. `accept`: csak az ilyen darabhoz tartozó élek számítanak.
   * Gyűrűnként keres kifelé; ha a legjobb találat közelebb van, mint a még meg nem nézett gyűrű, kész.
   */
  private nearest(x: number, y: number, accept: (part: number) => boolean): RoadPoint | null {
    const cx = Math.floor((x - this.area.minX) / CELL);
    const cy = Math.floor((y - this.area.minY) / CELL);
    const rows = Math.ceil((this.area.maxY - this.area.minY) / CELL) + 1;
    const maxRing = Math.max(this.cols, rows);
    let best: RoadPoint | null = null;
    const seen = new Set<number>();
    for (let r = 0; r <= maxRing; r++) {
      if (best && best.d < (r - 1) * CELL) break;
      for (let gy = cy - r; gy <= cy + r; gy++) {
        for (let gx = cx - r; gx <= cx + r; gx++) {
          if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== r || gx < 0 || gy < 0 || gx >= this.cols || gy >= rows) continue;
          for (const e of this.grid.get(gy * this.cols + gx) ?? []) {
            if (seen.has(e)) continue;
            seen.add(e);
            const [u, v] = this.edges[e];
            if (!accept(this.part[u])) continue;
            const ax = this.xs[u];
            const ay = this.ys[u];
            const dx = this.xs[v] - ax;
            const dy = this.ys[v] - ay;
            const len2 = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
            const px = ax + dx * t;
            const py = ay + dy * t;
            const d = Math.hypot(x - px, y - py);
            if (!best || d < best.d) best = { u, v, t, x: px, y: py, d };
          }
        }
      }
    }
    return best;
  }

  /** A legnagyobb úthálózat-darab sorszáma. */
  private mainPart(): number {
    let best = 0;
    for (let i = 1; i < this.partSize.length; i++) if (this.partSize[i] > this.partSize[best]) best = i;
    return best;
  }

  /**
   * Útvonal a tanktól (fx, fy) a célhoz (tx, ty) a normál utakon. A tank a legközelebbi útpontról
   * indul (ha messze van az úttól, a fő úthálózatéról), a cél a hozzá legközelebbi, ugyanarról a
   * hálózatról elérhető útpont. null: nincs út a játéktéren.
   */
  route(fx: number, fy: number, tx: number, ty: number): Route | null {
    if (this.edges.length === 0) return null;
    const close = this.nearest(fx, fy, () => true);
    if (!close) return null;
    const main = this.mainPart();
    const start = close.d <= ON_ROAD || this.partSize[this.part[close.u]] >= SMALL_PART ? close : (this.nearest(fx, fy, (p) => p === main) ?? close);
    const part = this.part[start.u];
    const goal = this.nearest(tx, ty, (p) => p === part);
    if (!goal) return null;
    const path = this.search(start, goal);
    if (!path) return null;
    const points = [fx, fy, ...path];
    let length = 0;
    for (let i = 2; i < points.length; i += 2) length += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
    return { points, length, end: { x: goal.x, y: goal.y } };
  }

  /** A* a két útpont között; az eredmény a pontok sora (x, y párok) a kezdőponttól a célpontig. */
  private search(start: RoadPoint, goal: RoadPoint): number[] | null {
    const sameEdge = (start.u === goal.u && start.v === goal.v) || (start.u === goal.v && start.v === goal.u);
    if (sameEdge) return [start.x, start.y, goal.x, goal.y];
    const n = this.xs.length;
    const S = n;
    const G = n + 1;
    const X = (i: number): number => (i === S ? start.x : i === G ? goal.x : this.xs[i]);
    const Y = (i: number): number => (i === S ? start.y : i === G ? goal.y : this.ys[i]);
    const dist = new Float64Array(n + 2).fill(Infinity);
    const from = new Int32Array(n + 2).fill(-1);
    const done = new Uint8Array(n + 2);
    const heap = new MinHeap();
    const h = (i: number): number => Math.hypot(X(i) - goal.x, Y(i) - goal.y);
    dist[S] = 0;
    heap.push(S, h(S));
    const neighbours = (u: number): number[] => {
      if (u === S) return [start.u, start.v];
      const list = this.adj[u];
      // a cél élének két végéről a célpont is elérhető
      return u === goal.u || u === goal.v ? [...list, G] : list;
    };
    while (heap.size) {
      const u = heap.pop();
      if (done[u]) continue;
      if (u === G) break;
      done[u] = 1;
      for (const v of neighbours(u)) {
        const w = Math.hypot(X(v) - X(u), Y(v) - Y(u));
        if (dist[u] + w < dist[v]) {
          dist[v] = dist[u] + w;
          from[v] = u;
          heap.push(v, dist[v] + h(v));
        }
      }
    }
    if (from[G] < 0) return null;
    const out: number[] = [];
    for (let i = G; i >= 0; i = from[i]) out.push(Y(i), X(i));
    return out.reverse();
  }
}

/** Egyszerű bináris kupac (A*-hoz): elem és prioritás. */
class MinHeap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p];
      keys[i] = keys[p];
      i = p;
    }
    items[i] = item;
    keys[i] = key;
  }

  pop(): number {
    const { items, keys } = this;
    const top = items[0];
    const item = items.pop()!;
    const key = keys.pop()!;
    if (items.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= items.length) break;
        const r = l + 1;
        const c = r < items.length && keys[r] < keys[l] ? r : l;
        if (keys[c] >= key) break;
        items[i] = items[c];
        keys[i] = keys[c];
        i = c;
      }
      items[i] = item;
      keys[i] = key;
    }
    return top;
  }
}
