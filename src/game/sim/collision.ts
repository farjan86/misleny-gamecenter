// Statikus ütközési geometria: szakaszok egyenletes rácsban.
// Tiszta logika (nincs Phaser-függés), hogy később a szerver is futtathassa.

export interface RayHit {
  /** a találat helye a sugár mentén, 0..1 */
  t: number;
  x: number;
  y: number;
  /** az eltalált fal egységnyi normálisa, a sugár kiindulási oldala felé mutat */
  nx: number;
  ny: number;
}

export class SegmentGrid {
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: number[][];
  private readonly segs: number[] = [];
  private stamp = 0;
  private readonly seen: number[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell = 16,
  ) {
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(height / cell);
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  get segmentCount(): number {
    return this.segs.length / 4;
  }

  addSegment(ax: number, ay: number, bx: number, by: number): void {
    const idx = this.segs.length / 4;
    this.segs.push(ax, ay, bx, by);
    this.seen.push(0);
    const [c0, c1] = this.range(Math.min(ax, bx), Math.max(ax, bx), this.cols);
    const [r0, r1] = this.range(Math.min(ay, by), Math.max(ay, by), this.rows);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) this.cells[r * this.cols + c].push(idx);
    }
  }

  /** Zárt sokszög élei; a pontlista lapított [x0,y0,x1,y1,...]. */
  addPolygon(pts: ArrayLike<number>): void {
    const n = pts.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      this.addSegment(pts[j * 2], pts[j * 2 + 1], pts[i * 2], pts[i * 2 + 1]);
    }
  }

  addPolyline(pts: ArrayLike<number>): void {
    for (let i = 0; i + 3 < pts.length; i += 2) {
      this.addSegment(pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
    }
  }

  addCircle(x: number, y: number, r: number, sides = 8): void {
    const pts: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    this.addPolygon(pts);
  }

  private range(min: number, max: number, count: number): [number, number] {
    const a = Math.max(0, Math.min(count - 1, Math.floor(min / this.cell)));
    const b = Math.max(0, Math.min(count - 1, Math.floor(max / this.cell)));
    return [a, b];
  }

  private forEachNear(minX: number, minY: number, maxX: number, maxY: number, fn: (i: number) => void): void {
    const stamp = ++this.stamp;
    const [c0, c1] = this.range(minX, maxX, this.cols);
    const [r0, r1] = this.range(minY, maxY, this.rows);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = this.cells[r * this.cols + c];
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (this.seen[i] !== stamp) {
            this.seen[i] = stamp;
            fn(i);
          }
        }
      }
    }
  }

  /**
   * Kör kitolása a falakból. Visszaadja a korrigált középpontot és azt,
   * hogy volt-e érintkezés.
   */
  resolveCircle(x: number, y: number, r: number): { x: number; y: number; hit: boolean } {
    let hit = false;
    const s = this.segs;
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      this.forEachNear(x - r, y - r, x + r, y + r, (i) => {
        const ax = s[i * 4];
        const ay = s[i * 4 + 1];
        const dx = s[i * 4 + 2] - ax;
        const dy = s[i * 4 + 3] - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
        const px = ax + t * dx;
        const py = ay + t * dy;
        let nx = x - px;
        let ny = y - py;
        const d2 = nx * nx + ny * ny;
        if (d2 >= r * r) return;
        let d = Math.sqrt(d2);
        if (d < 1e-6) {
          // a középpont pont a szakaszon van: a szakasz normálisa mentén toljuk ki
          const len = Math.sqrt(len2) || 1;
          nx = -dy / len;
          ny = dx / len;
          d = 0;
        } else {
          nx /= d;
          ny /= d;
        }
        x += nx * (r - d);
        y += ny * (r - d);
        hit = true;
        moved = true;
      });
      if (!moved) break;
    }
    return { x, y, hit };
  }

  /** Az (ax,ay)→(bx,by) szakasz első metszése a falakkal. */
  raycast(ax: number, ay: number, bx: number, by: number): RayHit | null {
    const s = this.segs;
    const rx = bx - ax;
    const ry = by - ay;
    let best = Infinity;
    let bestSeg = -1;
    this.forEachNear(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), (i) => {
      const cx = s[i * 4];
      const cy = s[i * 4 + 1];
      const sx = s[i * 4 + 2] - cx;
      const sy = s[i * 4 + 3] - cy;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-9) return;
      const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
      const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < best) {
        best = t;
        bestSeg = i;
      }
    });
    if (bestSeg < 0) return null;
    // a fal normálisa, a sugár érkezési oldala felé fordítva
    const sx = s[bestSeg * 4 + 2] - s[bestSeg * 4];
    const sy = s[bestSeg * 4 + 3] - s[bestSeg * 4 + 1];
    const len = Math.hypot(sx, sy) || 1;
    let nx = -sy / len;
    let ny = sx / len;
    if (nx * rx + ny * ry > 0) {
      nx = -nx;
      ny = -ny;
    }
    return { t: best, x: ax + rx * best, y: ay + ry * best, nx, ny };
  }
}
