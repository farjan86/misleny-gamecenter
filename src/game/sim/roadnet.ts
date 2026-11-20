// Úthálózat a forgalom számára: a pálya közútjaiból (töröttvonalak) irányított
// élekből és csomópontokból álló gráf. A játéktéren kívüli részek levágódnak; ahol
// egy út átlépi a játéktér határát, ott „kapu” keletkezik – a járművek ezeken
// jönnek be és mennek ki. A zsákutcák kimaradnak, így a járműveknek sosem kell
// megfordulniuk az út végén. Tiszta logika, nincs Phaser- vagy DOM-függés.

/** Egy közút a pálya adataiból. */
export interface NetRoad {
  pts: ArrayLike<number>;
  width: number;
  /** főút (a busz csak ilyenen jár) */
  main: boolean;
}

export interface NetNode {
  x: number;
  y: number;
  /** a csomópontból induló élek sorszámai */
  out: number[];
  /** kapu: itt lép be és ki a forgalom a játéktér szélén */
  gate: boolean;
}

export interface NetEdge {
  id: number;
  from: number;
  to: number;
  /** az él pontjai a haladás irányában, lapítva */
  pts: number[];
  /** a pontokig megtett út (cum[0] = 0) */
  cum: number[];
  length: number;
  width: number;
  main: boolean;
  /** ugyanez az útszakasz az ellenkező irányban */
  reverse: number;
  /** az él kezdő és záró iránya (radián) */
  startAngle: number;
  endAngle: number;
  /** stopvonal az él végén: az él végétől ennyivel előbb kell megállni (0: nincs) */
  stop: number;
}

export interface NetPoint {
  x: number;
  y: number;
  angle: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const KEY = 4; // a csomópontok egyesítése negyed méteres rácson
const keyOf = (x: number, y: number): string => `${Math.round(x * KEY)},${Math.round(y * KEY)}`;

/** Töröttvonal levágása a téglalapra: a belül haladó darabok listája. */
function clipPolyline(pts: ArrayLike<number>, b: Bounds): { pts: number[]; cutStart: boolean; cutEnd: boolean }[] {
  const inside = (x: number, y: number): boolean => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
  // a szakasz és a téglalap metszete (Liang–Barsky): a belül eső rész paraméterei
  const clip = (ax: number, ay: number, bx: number, by: number): [number, number] | null => {
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    const edges: [number, number][] = [
      [-dx, ax - b.minX],
      [dx, b.maxX - ax],
      [-dy, ay - b.minY],
      [dy, b.maxY - ay],
    ];
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) return null;
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
    return [t0, t1];
  };
  const out: { pts: number[]; cutStart: boolean; cutEnd: boolean }[] = [];
  let current: { pts: number[]; cutStart: boolean; cutEnd: boolean } | null = null;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i];
    const ay = pts[i + 1];
    const bx = pts[i + 2];
    const by = pts[i + 3];
    const range = clip(ax, ay, bx, by);
    if (!range) {
      current = null;
      continue;
    }
    const [t0, t1] = range;
    const sx = ax + (bx - ax) * t0;
    const sy = ay + (by - ay) * t0;
    const ex = ax + (bx - ax) * t1;
    const ey = ay + (by - ay) * t1;
    if (!current || t0 > 0) {
      current = { pts: [sx, sy], cutStart: t0 > 0 || !inside(ax, ay), cutEnd: false };
      out.push(current);
    }
    current.pts.push(ex, ey);
    if (t1 < 1) {
      current.cutEnd = true;
      current = null;
    }
  }
  return out.filter((piece) => piece.pts.length >= 4);
}

export class RoadNet {
  readonly nodes: NetNode[] = [];
  readonly edges: NetEdge[] = [];
  /** a kapukból befelé induló élek */
  readonly entries: number[] = [];
  /** a hálózat teljes hossza (egy irányban), méterben */
  length = 0;

  /**
   * `roads`: a pálya közútjai; `bounds`: a játéktér; `stopLines`: a stopvonalak
   * lapítva (x, y, irány, fél hossz), ahogy a pálya megadja.
   */
  constructor(roads: readonly NetRoad[], bounds: Bounds, stopLines: readonly number[] = []) {
    // 1. levágás a játéktérre
    const pieces: { pts: number[]; width: number; main: boolean; cutStart: boolean; cutEnd: boolean }[] = [];
    for (const road of roads) {
      for (const piece of clipPolyline(road.pts, bounds)) pieces.push({ ...piece, width: road.width, main: road.main });
    }

    // 2. csomópontok: az utak végei, és azok a pontok, amelyeken több út is áthalad
    const uses = new Map<string, number>();
    for (const piece of pieces) {
      const seen = new Set<string>();
      for (let i = 0; i < piece.pts.length; i += 2) {
        const key = keyOf(piece.pts[i], piece.pts[i + 1]);
        if (seen.has(key)) continue;
        seen.add(key);
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    }
    const nodeOf = new Map<string, number>();
    const node = (x: number, y: number, gate: boolean): number => {
      const key = keyOf(x, y);
      let id = nodeOf.get(key);
      if (id === undefined) {
        id = this.nodes.length;
        this.nodes.push({ x, y, out: [], gate });
        nodeOf.set(key, id);
      } else if (gate) this.nodes[id].gate = true;
      return id;
    };
    // a pálya szélén véget érő út vége is kapu (a pályafájlban az utak a pálya szélén vannak levágva)
    const atBorder = (x: number, y: number): boolean => x < bounds.minX + 6 || y < bounds.minY + 6 || x > bounds.maxX - 6 || y > bounds.maxY - 6;

    // 3. élek: az utak a csomópontoknál feldarabolva, mindkét irányban
    const addEdge = (from: number, to: number, pts: number[], width: number, main: boolean): number => {
      const cum = [0];
      for (let i = 0; i + 3 < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]));
      const n = pts.length;
      const id = this.edges.length;
      this.edges.push({
        id,
        from,
        to,
        pts,
        cum,
        length: cum[cum.length - 1],
        width,
        main,
        reverse: -1,
        startAngle: Math.atan2(pts[3] - pts[1], pts[2] - pts[0]),
        endAngle: Math.atan2(pts[n - 1] - pts[n - 3], pts[n - 2] - pts[n - 4]),
        stop: 0,
      });
      return id;
    };
    for (const piece of pieces) {
      const p = piece.pts;
      const last = p.length - 2;
      let start = 0;
      for (let i = 2; i <= last; i += 2) {
        const end = i === last;
        if (!end && (uses.get(keyOf(p[i], p[i + 1])) ?? 0) < 2) continue;
        const pts = p.slice(start, i + 2);
        let length = 0;
        for (let k = 0; k + 3 < pts.length; k += 2) length += Math.hypot(pts[k + 2] - pts[k], pts[k + 3] - pts[k + 1]);
        if (length >= 0.5) {
          const a = node(p[start], p[start + 1], start === 0 && (piece.cutStart || atBorder(p[0], p[1])));
          const b = node(p[i], p[i + 1], end && (piece.cutEnd || atBorder(p[i], p[i + 1])));
          if (a !== b) {
            const back: number[] = [];
            for (let k = pts.length - 2; k >= 0; k -= 2) back.push(pts[k], pts[k + 1]);
            const fwd = addEdge(a, b, pts, piece.width, piece.main);
            const rev = addEdge(b, a, back, piece.width, piece.main);
            this.edges[fwd].reverse = rev;
            this.edges[rev].reverse = fwd;
          }
        }
        start = i;
      }
    }

    // 4. a zsákutcák lenyesése: ami csak visszafordulással hagyható el, arra nem megy forgalom
    const alive = new Array<boolean>(this.edges.length).fill(true);
    const degree = this.nodes.map(() => 0);
    for (const e of this.edges) degree[e.from]++;
    const queue: number[] = [];
    this.nodes.forEach((n, i) => {
      if (degree[i] === 1 && !n.gate) queue.push(i);
    });
    const outOf = this.nodes.map(() => [] as number[]);
    for (const e of this.edges) outOf[e.from].push(e.id);
    while (queue.length) {
      const n = queue.pop()!;
      for (const id of outOf[n]) {
        if (!alive[id]) continue;
        const e = this.edges[id];
        alive[id] = false;
        alive[e.reverse] = false;
        degree[n]--;
        degree[e.to]--;
        if (degree[e.to] === 1 && !this.nodes[e.to].gate) queue.push(e.to);
      }
    }
    for (const e of this.edges) {
      if (!alive[e.id]) continue;
      this.nodes[e.from].out.push(e.id);
      this.length += e.length / 2;
      if (this.nodes[e.from].gate && degree[e.from] === 1) this.entries.push(e.id);
    }

    // 5. stopvonalak: annak az élnek a végén, amelyik a vonal irányában érkezik oda
    for (let i = 0; i + 3 < stopLines.length; i += 4) {
      const sx = stopLines[i];
      const sy = stopLines[i + 1];
      const angle = stopLines[i + 2];
      for (const e of this.edges) {
        if (!alive[e.id]) continue;
        const end = this.nodes[e.to];
        const dist = Math.hypot(end.x - sx, end.y - sy);
        if (dist > 22) continue;
        let d = (e.endAngle - angle) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        if (Math.abs(d) > 0.5) continue;
        // a vonal az él vége előtt van, az él tengelye mentén mérve
        const back = (end.x - sx) * Math.cos(e.endAngle) + (end.y - sy) * Math.sin(e.endAngle);
        if (back > 0 && back < e.length) e.stop = Math.max(e.stop, back);
      }
    }
  }

  /** Van-e használható él (forgalom csak akkor indulhat). */
  get usable(): boolean {
    return this.length > 0;
  }

  /** Az élek, amelyeken jármű közlekedhet. */
  drivable(): NetEdge[] {
    const list: NetEdge[] = [];
    for (const node of this.nodes) for (const id of node.out) list.push(this.edges[id]);
    return list;
  }

  /**
   * Az él `s` méternél lévő pontja, a haladási irány jobb oldalára `lane`
   * méterrel eltolva (a képernyőn y lefelé nő). `s` az él hosszára szorul.
   */
  pointAt(edge: NetEdge, s: number, lane: number, out: NetPoint): NetPoint {
    const { pts, cum } = edge;
    const d = Math.max(0, Math.min(edge.length, s));
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < d) i++;
    const ax = pts[i * 2];
    const ay = pts[i * 2 + 1];
    const dx = pts[i * 2 + 2] - ax;
    const dy = pts[i * 2 + 3] - ay;
    const len = cum[i + 1] - cum[i] || 1;
    const t = (d - cum[i]) / len;
    const ux = dx / len;
    const uy = dy / len;
    out.x = ax + dx * t - uy * lane;
    out.y = ay + dy * t + ux * lane;
    out.angle = Math.atan2(dy, dx);
    return out;
  }
}
