// A pálya rajzolt rétegei: a kamera körüli térképdarabokat igény szerint
// állítja elő, a távoliakat pedig eldobja, így a memóriahasználat a pálya
// méretétől függetlenül korlátos marad.
//
// A darabok kirajzolása háttérszálakon (Web Worker) történik, a fő szálon
// csak a kész pixelek kerülnek textúrába – menet közben így nem akad a kép.
// Darabonként két kép készülhet: a talaj (utak, épületek) a tank alatt, és a
// lombréteg (fák koronája, vezetékek) a tank fölött.

import Phaser from 'phaser';
import type { ChunkReply, ChunkRequest } from './chunkWorker';
import type { GameMap } from './GameMap';
import { renderCanopy, renderMap } from './raster';

const CHUNK = 256;
/** ennyi darabnyi szegély készül el előre a látómező körül */
const RING = 1;
/** a látómezőtől ennél messzebb került darabok törlődnek */
const KEEP = RING + 1;
/** képkockánként legfeljebb ennyi darab törlődik, hogy a törlés se okozzon megakadást */
const EVICT_PER_FRAME = 3;
const GROUND_DEPTH = 0;
const CANOPY_DEPTH = 14;
/** A lombok kissé áttetszők, hogy az alattuk álló tank látható maradjon. */
const CANOPY_ALPHA = 0.86;
const MAX_WORKERS = 3;

const keyOf = (cx: number, cy: number): number => cy * 4096 + cx;

interface Chunk {
  cx: number;
  cy: number;
  keys: string[];
  images: Phaser.GameObjects.Image[];
}

export class ChunkLayer {
  private readonly chunks = new Map<number, Chunk>();
  /** már kiadott, de még el nem készült darabok */
  private readonly pending = new Set<number>();
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly jobs = new Map<Worker, number>();
  /** a háttérszálakról megérkezett, textúrába még nem töltött darabok */
  private readonly arrived: ChunkReply[] = [];
  private readonly cols: number;
  private readonly rows: number;
  private readonly webgl: boolean;
  /** üres pixeltömb: feltöltés után ezt hagyjuk a textúra forrásaként, hogy a pixelek ne maradjanak kétszer a memóriában */
  private readonly blank = new Uint8Array(CHUNK * CHUNK * 4);
  private generation = 0;
  private serial = 0;
  /** a megváltozott (újrarajzolandó) darabok */
  private readonly dirty = new Set<number>();
  /** a legutóbb elkészült darab rajzolási ideje a háttérszálon, ms (diagnosztika) */
  lastRenderMs = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly map: GameMap,
    private readonly ppm: number,
  ) {
    this.cols = Math.ceil((map.width * ppm) / CHUNK);
    this.rows = Math.ceil((map.height * ppm) / CHUNK);
    this.webgl = scene.sys.game.renderer.type === Phaser.WEBGL;
    this.startWorkers();

    // Ha a böngésző elveszti, majd visszakapja a grafikus környezetet, a
    // textúrák tartalma elvész: mindent újrarajzolunk.
    scene.sys.game.renderer.on(Phaser.Renderer.Events.RESTORE_WEBGL, () => this.flush());
  }

  get workerCount(): number {
    return this.workers.length;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  private startWorkers(): void {
    if (typeof Worker === 'undefined') return;
    const count = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1));
    for (let i = 0; i < count; i++) {
      try {
        const worker = new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (ev: MessageEvent<ChunkReply>) => this.onReply(worker, ev.data);
        worker.onerror = () => this.dropWorker(worker);
        const init: ChunkRequest = { type: 'init', data: this.map.data, ppm: this.ppm, size: CHUNK, weather: this.map.weather, area: this.map.bounds };
        worker.postMessage(init);
        this.workers.push(worker);
        this.idle.push(worker);
      } catch {
        break; // háttérszál nélkül a fő szálon rajzolunk (lásd update)
      }
    }
  }

  /** Hibás háttérszál leállítása; a rá bízott darab újra kiadható lesz. */
  private dropWorker(worker: Worker): void {
    const job = this.jobs.get(worker);
    if (job !== undefined) this.pending.delete(job);
    this.jobs.delete(worker);
    const at = this.workers.indexOf(worker);
    if (at >= 0) this.workers.splice(at, 1);
    const idleAt = this.idle.indexOf(worker);
    if (idleAt >= 0) this.idle.splice(idleAt, 1);
    worker.terminate();
  }

  /** Igaz, ha a látómező minden darabja elkészült. */
  isReady(view: Phaser.Geom.Rectangle): boolean {
    const c0 = Math.max(0, Math.floor(view.x / CHUNK));
    const c1 = Math.min(this.cols - 1, Math.floor((view.right - 1) / CHUNK));
    const r0 = Math.max(0, Math.floor(view.y / CHUNK));
    const r1 = Math.min(this.rows - 1, Math.floor((view.bottom - 1) / CHUNK));
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) if (!this.chunks.has(keyOf(cx, cy))) return false;
    }
    return true;
  }

  /**
   * Képkockánként hívandó: kiadja a hiányzó darabokat (a képernyőn lévőket
   * előre véve), elrejti a látómezőn kívülieket, és törli a messzire kerülteket.
   */
  update(view: Phaser.Geom.Rectangle, integrateBudgetMs = 3): void {
    this.integrate(view, integrateBudgetMs);
    this.redrawDirty();

    const c0 = Math.max(0, Math.floor(view.x / CHUNK) - RING);
    const c1 = Math.min(this.cols - 1, Math.floor(view.right / CHUNK) + RING);
    const r0 = Math.max(0, Math.floor(view.y / CHUNK) - RING);
    const r1 = Math.min(this.rows - 1, Math.floor(view.bottom / CHUNK) + RING);

    const canDispatch = this.workers.length === 0 || this.idle.length > 0;
    if (canDispatch) {
      // a legsürgősebb hiányzó darabok: előbb a képernyőn lévők, a középponthoz közelebbiek
      let missing: { cx: number; cy: number; rank: number }[] | null = null;
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const key = keyOf(cx, cy);
          if (this.chunks.has(key) || this.pending.has(key)) continue;
          const x = cx * CHUNK;
          const y = cy * CHUNK;
          const onScreen = x < view.right && x + CHUNK > view.x && y < view.bottom && y + CHUNK > view.y;
          const dist = Math.hypot(x + CHUNK / 2 - view.centerX, y + CHUNK / 2 - view.centerY);
          (missing ??= []).push({ cx, cy, rank: dist + (onScreen ? 0 : 1e6) });
        }
      }
      if (missing) {
        missing.sort((a, b) => a.rank - b.rank);
        if (this.workers.length === 0) {
          // tartalék: háttérszál nélkül képkockánként egy darab a fő szálon
          this.renderOnMainThread(missing[0].cx, missing[0].cy);
        } else {
          for (const m of missing) {
            const worker = this.idle.pop();
            if (!worker) break;
            const key = keyOf(m.cx, m.cy);
            this.pending.add(key);
            this.jobs.set(worker, key);
            const request: ChunkRequest = { type: 'render', key, cx: m.cx, cy: m.cy };
            worker.postMessage(request);
          }
        }
      }
    }

    // láthatóság és törlés
    let evicted = 0;
    for (const [key, chunk] of this.chunks) {
      const x = chunk.cx * CHUNK;
      const y = chunk.cy * CHUNK;
      const visible = x < view.right && x + CHUNK > view.x && y < view.bottom && y + CHUNK > view.y;
      if (chunk.images[0].visible !== visible) for (const image of chunk.images) image.setVisible(visible);
      const far = chunk.cx < c0 - (KEEP - RING) || chunk.cx > c1 + (KEEP - RING) || chunk.cy < r0 - (KEEP - RING) || chunk.cy > r1 + (KEEP - RING);
      if (far && evicted < EVICT_PER_FRAME) {
        this.destroyChunk(chunk);
        this.chunks.delete(key);
        this.dirty.delete(key);
        evicted++;
      }
    }
  }

  private onReply(worker: Worker, reply: ChunkReply): void {
    this.jobs.delete(worker);
    this.idle.push(worker);
    // a kész darab nem azonnal, hanem a következő update()-ben, időkerettel kerül textúrába
    if (this.pending.has(reply.key)) this.arrived.push(reply);
  }

  /**
   * Az elkészült darabok átvétele (textúra feltöltése). Képkockánként legalább
   * egy, de legfeljebb annyi, amennyi az időkeretbe belefér – lassú gépen így
   * akkor sem akad meg a kép, ha egyszerre több darab érkezik.
   */
  private integrate(view: Phaser.Geom.Rectangle, budgetMs: number): void {
    if (this.arrived.length === 0) return;
    const started = performance.now();
    do {
      // előbb a képernyőn látható darabok
      let pick = 0;
      for (let i = 0; i < this.arrived.length; i++) {
        const r = this.arrived[i];
        const x = r.cx * CHUNK;
        const y = r.cy * CHUNK;
        if (x < view.right && x + CHUNK > view.x && y < view.bottom && y + CHUNK > view.y) {
          pick = i;
          break;
        }
      }
      const reply = this.arrived.splice(pick, 1)[0];
      if (!this.pending.delete(reply.key)) continue; // időközben érvénytelenné vált (pl. flush)
      this.lastRenderMs = reply.ms;
      this.addChunk(reply.cx, reply.cy, new Uint8Array(reply.ground), reply.canopy ? new Uint8Array(reply.canopy) : null);
    } while (this.arrived.length > 0 && performance.now() - started < budgetMs);
  }

  private renderOnMainThread(cx: number, cy: number): void {
    const started = performance.now();
    const target = { w: CHUNK, h: CHUNK, ox: cx * CHUNK, oy: cy * CHUNK, scale: this.ppm, detail: true };
    const ground = new Uint32Array(CHUNK * CHUNK);
    renderMap(this.map, { ...target, buf: ground });
    const canopy = new Uint32Array(CHUNK * CHUNK);
    const hasCanopy = renderCanopy(this.map, { ...target, buf: canopy });
    this.lastRenderMs = performance.now() - started;
    this.addChunk(cx, cy, new Uint8Array(ground.buffer), hasCanopy ? new Uint8Array(canopy.buffer) : null);
  }

  private addChunk(cx: number, cy: number, ground: Uint8Array, canopy: Uint8Array | null): void {
    const chunk: Chunk = { cx, cy, keys: [], images: [] };
    const tag = `${cx}-${cy}-${this.generation}-${this.serial++}`;
    this.addImage(chunk, `map-ground-${tag}`, ground, GROUND_DEPTH, 1);
    if (canopy) this.addImage(chunk, `map-canopy-${tag}`, canopy, CANOPY_DEPTH, CANOPY_ALPHA);
    if (!chunk.images.length) return;
    // újrarajzolásnál az új kép ugyanabban a képkockában váltja a régit (nincs villanás)
    const key = keyOf(cx, cy);
    const old = this.chunks.get(key);
    this.chunks.set(key, chunk);
    if (old) this.destroyChunk(old);
  }

  /** A pálya állapotának változását (kidőlt fa, lövésnyom, új kör) minden háttérszál megkapja. */
  notify(message: ChunkRequest): void {
    for (const worker of this.workers) worker.postMessage(message);
  }

  /** A megadott (méterben adott) területet érintő, már kirajzolt darabok újrarajzolását kéri. */
  invalidate(minX: number, minY: number, maxX: number, maxY: number): void {
    const c0 = Math.max(0, Math.floor((minX * this.ppm) / CHUNK));
    const c1 = Math.min(this.cols - 1, Math.floor((maxX * this.ppm) / CHUNK));
    const r0 = Math.max(0, Math.floor((minY * this.ppm) / CHUNK));
    const r1 = Math.min(this.rows - 1, Math.floor((maxY * this.ppm) / CHUNK));
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const key = keyOf(cx, cy);
        // a még ki nem rajzolt darab úgyis az új állapottal készül el
        if (this.chunks.has(key) || this.pending.has(key)) this.dirty.add(key);
      }
    }
  }

  /** A megváltozott darabok újrarajzolása; a régi kép addig kint marad, amíg az új el nem készül. */
  private redrawDirty(): void {
    if (this.dirty.size === 0) return;
    for (const key of this.dirty) {
      // éppen készül: lehet, hogy még a régi állapottal – megérkezése után újra sorra kerül
      if (this.pending.has(key)) continue;
      const chunk = this.chunks.get(key);
      if (!chunk) {
        this.dirty.delete(key);
        continue;
      }
      if (this.workers.length === 0) {
        this.dirty.delete(key);
        this.renderOnMainThread(chunk.cx, chunk.cy);
        return; // háttérszál nélkül képkockánként egy
      }
      const worker = this.idle.pop();
      if (!worker) return;
      this.dirty.delete(key);
      this.pending.add(key);
      this.jobs.set(worker, key);
      const request: ChunkRequest = { type: 'render', key, cx: chunk.cx, cy: chunk.cy };
      worker.postMessage(request);
    }
  }

  /** Új kör: a pálya sérülései eltűnnek, minden darab újrarajzolódik. */
  reset(): void {
    this.notify({ type: 'reset' });
    this.dirty.clear();
    this.flush();
  }

  private addImage(chunk: Chunk, key: string, pixels: Uint8Array, depth: number, alpha: number): void {
    const textures = this.scene.textures;
    if (this.webgl) {
      // közvetlenül a pixelekből készül a textúra, vászon nélkül
      const tex = textures.addUint8Array(key, pixels, CHUNK, CHUNK);
      if (!tex) return;
      // a pixelek már a videokártyán vannak; a másolatot elengedjük
      tex.source[0].image = this.blank as unknown as HTMLCanvasElement;
    } else {
      const tex = textures.createCanvas(key, CHUNK, CHUNK);
      if (!tex) return;
      tex.context.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), CHUNK, CHUNK), 0, 0);
      tex.refresh();
    }
    const image = this.scene.add.image(chunk.cx * CHUNK, chunk.cy * CHUNK, key).setOrigin(0).setDepth(depth).setAlpha(alpha);
    chunk.keys.push(key);
    chunk.images.push(image);
  }

  private destroyChunk(chunk: Chunk): void {
    for (const image of chunk.images) image.destroy();
    for (const key of chunk.keys) this.scene.textures.remove(key);
  }

  /** Minden darab eldobása; a következő update() újra kiadja a szükségeseket. */
  flush(): void {
    for (const chunk of this.chunks.values()) this.destroyChunk(chunk);
    this.chunks.clear();
    this.pending.clear();
    this.arrived.length = 0;
    this.generation++;
  }
}
