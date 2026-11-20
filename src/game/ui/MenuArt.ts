// A menük díszítése: a háttérben Kozármisleny (a játék pályája) elmosott,
// lassan úszó térképe, a főképernyő tetején pedig egy animált utcakép, amelyen
// a hat tanktípus vonul végig a felderítőtől a titánig. Minden kódból készül,
// ugyanazokkal a rajzokkal, mint a játékban.

import { tankSprites, TURRET_PIVOT, type TankPaint } from '../entities/tankTextures';
import type { GameMap } from '../maps/GameMap';
import { renderMap } from '../maps/raster';
import { LEVEL, tankSize } from '../sim/world';

interface Roller {
  hull: HTMLCanvasElement[];
  turret: HTMLCanvasElement;
  size: number;
  /** a konvojon belüli hely (pixel, a nagyítás előtt) */
  offset: number;
  phase: number;
}

const PAINTS: TankPaint[] = ['own', 'rival', 'own', 'bot', 'rival', 'own'];
/** a fejléc magassága CSS pixelben, a konvoj sebessége (pixel/mp) és a tankok közötti hely */
const HEIGHT = 168;
const SPEED = 26;
const GAP = 54;
/** az úttest felső és alsó széle a fejlécben */
const ROAD_TOP = 30;
const ROAD_BOTTOM = HEIGHT - 20;

export class MenuArt {
  private readonly hero: HTMLCanvasElement | null;
  private readonly rollers: Roller[] = [];
  private convoy = 0;
  private active = false;
  private raf = 0;
  private started = performance.now();

  constructor(private readonly map: GameMap) {
    this.hero = document.getElementById('hero') as HTMLCanvasElement | null;
    // a rajzok elkészítése nem sürgős: az oldal megjelenése után jönnek
    window.setTimeout(() => {
      this.buildRollers();
      this.drawBackground();
      if (this.active) this.loop();
    }, 40);
    window.addEventListener('resize', () => this.frame(performance.now()));
  }

  /** A főképernyőn fut az animáció; máshol (és játék közben) áll. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    window.cancelAnimationFrame(this.raf);
    if (active) this.loop();
  }

  private buildRollers(): void {
    let offset = 0;
    for (let tier = 0; tier < LEVEL.tiers.length; tier++) {
      const sprites = tankSprites(tier, PAINTS[tier % PAINTS.length], Math.min(2, tier));
      // a típus középső szintjének mérete, kicsit felnagyítva
      const size = tankSize({ level: LEVEL.tiers[tier] + 1 }) * 0.86;
      this.rollers.push({ ...sprites, size, offset, phase: tier * 1.7 });
      offset += 96 * size + GAP;
    }
    this.convoy = offset;
  }

  /** A háttér: a pálya egyszerűsített képe; az elmosást és a lassú úszást a stíluslap adja. */
  private drawBackground(): void {
    const canvas = document.getElementById('menu-bg') as HTMLCanvasElement | null;
    if (!canvas) return;
    const scale = 0.42;
    const w = Math.round(this.map.width * scale);
    const h = Math.round(this.map.height * scale);
    const buf = new Uint32Array(w * h);
    renderMap(this.map, { buf, w, h, ox: 0, oy: 0, scale, detail: false });
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer), w, h), 0, 0);
    canvas.classList.add('ready');
  }

  private loop(): void {
    this.raf = window.requestAnimationFrame((now) => {
      this.frame(now);
      if (this.active) this.loop();
    });
  }

  private frame(now: number): void {
    const canvas = this.hero;
    if (!canvas || canvas.clientWidth === 0) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    if (canvas.width !== Math.round(w * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(HEIGHT * ratio);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const t = (now - this.started) / 1000;
    this.street(ctx, w);
    this.tanks(ctx, w, t);
    // a két szélén a kép belesimul a panelbe
    for (const [x0, x1] of [[0, 70], [w, w - 70]]) {
      const fade = ctx.createLinearGradient(x0, 0, x1, 0);
      fade.addColorStop(0, 'rgba(16,20,28,1)');
      fade.addColorStop(1, 'rgba(16,20,28,0)');
      ctx.fillStyle = fade;
      ctx.fillRect(Math.min(x0, x1), 0, 70, HEIGHT);
    }
  }

  /** Utcakép felülről: fű, járda, úttest felezővonallal, fák és háztetők. */
  private street(ctx: CanvasRenderingContext2D, w: number): void {
    ctx.fillStyle = '#5a9a48';
    ctx.fillRect(0, 0, w, HEIGHT);
    // foltos fű
    for (let i = 0; i < Math.ceil(w / 34); i++) {
      ctx.fillStyle = i % 2 ? 'rgba(80,140,64,0.55)' : 'rgba(104,170,84,0.4)';
      ctx.beginPath();
      ctx.ellipse(i * 34 + ((i * 53) % 21), (i * 71) % 2 ? 14 : HEIGHT - 12, 26, 9, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // háztetők a felső szélen
    for (let x = 30; x < w; x += 210) {
      const rw = 92 + ((x * 7) % 38);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x + 5, -14, rw, 32);
      ctx.fillStyle = (x / 210) % 2 < 1 ? '#b8482e' : '#8a3a2a';
      ctx.fillRect(x, -18, rw, 32);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(x, -2, rw, 3);
    }
    // járda és úttest
    const top = ROAD_TOP;
    const bottom = ROAD_BOTTOM;
    ctx.fillStyle = '#b9b3a4';
    ctx.fillRect(0, top - 7, w, 7);
    ctx.fillRect(0, bottom, w, 7);
    const road = ctx.createLinearGradient(0, top, 0, bottom);
    road.addColorStop(0, '#4b4e56');
    road.addColorStop(0.5, '#565a63');
    road.addColorStop(1, '#474a52');
    ctx.fillStyle = road;
    ctx.fillRect(0, top, w, bottom - top);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(0, top + 3, w, 1.5);
    ctx.fillRect(0, bottom - 4.5, w, 1.5);
    for (let x = 12; x < w; x += 46) ctx.fillRect(x, (top + bottom) / 2 - 1, 24, 2);
    // fák az alsó szélen
    for (let x = 70; x < w; x += 132) {
      const r = 13 + ((x * 3) % 7);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.arc(x + 5, HEIGHT + 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2f6f3a';
      ctx.beginPath();
      ctx.arc(x, HEIGHT - 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#4a9550';
      ctx.beginPath();
      ctx.arc(x - 4, HEIGHT - 6, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** A konvoj: a hat tanktípus egymás után, lassan gurulva; a tornyok ide-oda fordulnak. */
  private tanks(ctx: CanvasRenderingContext2D, w: number, t: number): void {
    if (this.rollers.length === 0) return;
    const span = Math.max(w + 140, this.convoy + 40);
    const y = (ROAD_TOP + ROAD_BOTTOM) / 2;
    const lead = (t * SPEED) % span;
    // a legkisebb megy elöl (jobbra), mögötte egyre nagyobbak
    for (const r of this.rollers) {
      const x = ((lead - r.offset + this.convoy + span) % span) - 70;
      const half = 48 * r.size;
      if (x < -half * 2 || x > w + half * 2) continue;
      ctx.save();
      ctx.translate(x, y + Math.sin(t * 9 + r.phase) * 0.5);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.roundRect(-34 * r.size + 5, -21 * r.size + 6, 68 * r.size, 42 * r.size, 7);
      ctx.fill();
      ctx.scale(r.size, r.size);
      ctx.drawImage(r.hull[Math.floor(t * 9 + r.phase) % r.hull.length], -48, -34);
      ctx.rotate(Math.sin(t * 0.55 + r.phase) * 0.32);
      ctx.drawImage(r.turret, -TURRET_PIVOT.x, -TURRET_PIVOT.y);
      ctx.restore();
    }
  }
}
