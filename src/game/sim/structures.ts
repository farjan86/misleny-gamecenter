// Ledönthető épületek állapota: életerő és az, hogy összedőlt-e. Tiszta
// logika; a falak az ütközési rácsban az épület sorszámával vannak megjelölve,
// összedőléskor a World kapcsolja ki őket.

export const STRUCTURE = {
  /** az épület életereje: alap + négyzetméterenkénti érték, a két határ között */
  baseHp: 60,
  hpPerM2: 0.9,
  minHp: 80,
  maxHp: 600,
} as const;

export interface StructureSpec {
  /** alapterület m²-ben */
  area: number;
  /** a közepe (az összedőlés eseményéhez) */
  x: number;
  y: number;
  /** nem dönthető le (pl. a Polgármesteri Hivatal) */
  indestructible?: boolean;
}

export class Structures {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly maxHp: Float32Array;
  readonly hp: Float32Array;
  /** 1, ha az épület összedőlt */
  readonly collapsed: Uint8Array;

  constructor(specs: readonly StructureSpec[]) {
    this.count = specs.length;
    this.x = new Float32Array(this.count);
    this.y = new Float32Array(this.count);
    this.maxHp = new Float32Array(this.count);
    this.hp = new Float32Array(this.count);
    this.collapsed = new Uint8Array(this.count);
    specs.forEach((spec, i) => {
      this.x[i] = spec.x;
      this.y[i] = spec.y;
      this.maxHp[i] = spec.indestructible
        ? Infinity
        : Math.max(STRUCTURE.minHp, Math.min(STRUCTURE.maxHp, STRUCTURE.baseHp + spec.area * STRUCTURE.hpPerM2));
    });
    this.reset();
  }

  /** Sebzés; igazat ad, ha az épület ettől dőlt össze. */
  damage(index: number, amount: number): boolean {
    if (index < 0 || index >= this.count || this.collapsed[index]) return false;
    // a le nem dönthető épületet semmi nem sebzi (a végtelen sebzés sem)
    if (this.maxHp[index] === Infinity) return false;
    this.hp[index] -= amount;
    if (this.hp[index] > 0) return false;
    this.hp[index] = 0;
    this.collapsed[index] = 1;
    return true;
  }

  /** Új kör: minden épület újra áll. */
  reset(): void {
    this.hp.set(this.maxHp);
    this.collapsed.fill(0);
  }
}
