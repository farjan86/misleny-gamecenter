// Kidönthető tereptárgyak: fák és villanyoszlopok. Nem falak – a tank
// nekimenve kidönti őket, a lövedék eltalálva szintén, és utána nem akadályok.
// Tiszta logika (nincs Phaser-függés): a szimuláció állapotának része, a
// rajzoló csak olvassa.

export const FELLABLE = { tree: 0, pole: 1 } as const;

export interface FellableItem {
  x: number;
  y: number;
  /** a törzs (oszlop) sugara méterben */
  r: number;
  kind: number;
}

export interface PropHit {
  /** a találat helye a sugár mentén, 0..1 */
  t: number;
  index: number;
}

const CELL = 8;

export class Fellables {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly r: Float32Array;
  readonly kind: Uint8Array;
  /** 1 = kidőlt */
  readonly fallen: Uint8Array;
  /** a dőlés iránya radiánban (csak a kidőlteknél érvényes) */
  readonly angle: Float32Array;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: number[][];

  constructor(width: number, height: number, items: readonly FellableItem[]) {
    this.count = items.length;
    this.x = new Float32Array(this.count);
    this.y = new Float32Array(this.count);
    this.r = new Float32Array(this.count);
    this.kind = new Uint8Array(this.count);
    this.fallen = new Uint8Array(this.count);
    this.angle = new Float32Array(this.count);
    this.cols = Math.max(1, Math.ceil(width / CELL));
    this.rows = Math.max(1, Math.ceil(height / CELL));
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
    items.forEach((item, i) => {
      this.x[i] = item.x;
      this.y[i] = item.y;
      this.r[i] = item.r;
      this.kind[i] = item.kind;
      this.cells[this.row(item.y) * this.cols + this.col(item.x)].push(i);
    });
  }

  private col(x: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor(x / CELL)));
  }

  private row(y: number): number {
    return Math.max(0, Math.min(this.rows - 1, Math.floor(y / CELL)));
  }

  /** Kidönti a tárgyat a megadott irányba; false, ha már ki volt döntve. */
  fell(index: number, angle: number): boolean {
    if (index < 0 || index >= this.count || this.fallen[index]) return false;
    this.fallen[index] = 1;
    this.angle[index] = angle;
    return true;
  }

  /** Minden tárgy újra áll (új kör). */
  reset(): void {
    this.fallen.fill(0);
  }

  /** A körrel érintkező, még álló tárgyak. */
  forEachTouching(x: number, y: number, radius: number, fn: (index: number) => void): void {
    const c0 = this.col(x - radius - 1);
    const c1 = this.col(x + radius + 1);
    const r0 = this.row(y - radius - 1);
    const r1 = this.row(y + radius + 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = this.cells[r * this.cols + c];
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (this.fallen[i]) continue;
          const dx = this.x[i] - x;
          const dy = this.y[i] - y;
          const reach = radius + this.r[i];
          if (dx * dx + dy * dy <= reach * reach) fn(i);
        }
      }
    }
  }

  /** Az (ax,ay)→(bx,by) szakasz első találata egy még álló tárgy törzsén; `limit`: csak eddig a paraméterig keres. */
  raycast(ax: number, ay: number, bx: number, by: number, limit = 1): PropHit | null {
    const c0 = this.col(Math.min(ax, bx) - 1);
    const c1 = this.col(Math.max(ax, bx) + 1);
    const r0 = this.row(Math.min(ay, by) - 1);
    const r1 = this.row(Math.max(ay, by) + 1);
    const dx = bx - ax;
    const dy = by - ay;
    const a = dx * dx + dy * dy;
    if (a === 0) return null;
    let best = limit;
    let index = -1;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = this.cells[r * this.cols + c];
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (this.fallen[i]) continue;
          // szakasz–kör metszés
          const fx = ax - this.x[i];
          const fy = ay - this.y[i];
          const rad = this.r[i];
          const cc = fx * fx + fy * fy - rad * rad;
          const b = 2 * (fx * dx + fy * dy);
          const disc = b * b - 4 * a * cc;
          if (disc < 0) continue;
          const t = cc <= 0 ? 0 : (-b - Math.sqrt(disc)) / (2 * a);
          if (t >= 0 && t < best) {
            best = t;
            index = i;
          }
        }
      }
    }
    return index < 0 ? null : { t: best, index };
  }
}
