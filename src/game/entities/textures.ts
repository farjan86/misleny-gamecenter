// Futásidőben, kódból rajzolt sprite-ok (tank, lövedék, robbanás).
// Így a prototípusnak nincs külső képfájl-függősége; később az assets/sprites
// alá tett rajzolt sprite-okra cserélhetők.
//
// A sprite-ok 12 pixel/méter felbontásra készülnek (lásd GameScene.PPM).
// A tankok rajza külön fájlban van (tankTextures.ts).

import Phaser from 'phaser';
import { createTankTextures } from './tankTextures';

export const TEX = {
  shadow: 'tank-shadow',
  bullet: 'bullet',
  flash: 'muzzle-flash',
  explosion: 'explosion',
  marker: 'tank-marker',
} as const;

/** az árnyék mérete: az 1. osztályú tank teste */
const SHADOW_SIZE = { w: 68, h: 42 };
export const EXPLOSION_FRAMES = 10;
const EXPLOSION_SIZE = 112;

type Ctx = CanvasRenderingContext2D;

function canvasTexture(scene: Phaser.Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void): Phaser.Textures.CanvasTexture {
  const tex = scene.textures.createCanvas(key, w, h)!;
  draw(tex.context);
  tex.refresh();
  return tex;
}

function poly(ctx: Ctx, pts: number[], fill: string, stroke?: string, lineWidth = 2): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string, lineWidth = 2): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

/** Egyszerű, rögzített magú véletlen, hogy a robbanás minden betöltéskor ugyanolyan legyen. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawExplosion(ctx: Ctx): void {
  const size = EXPLOSION_SIZE;
  const rnd = seeded(42);
  const puffs = Array.from({ length: 9 }, () => ({ a: rnd() * Math.PI * 2, d: 0.25 + rnd() * 0.75, r: 0.5 + rnd() * 0.5 }));
  for (let f = 0; f < EXPLOSION_FRAMES; f++) {
    const age = f / (EXPLOSION_FRAMES - 1);
    const cx = f * size + size / 2;
    const cy = size / 2;
    const spread = 6 + 30 * Math.sqrt(age);
    ctx.save();
    ctx.beginPath();
    ctx.rect(f * size, 0, size, size);
    ctx.clip();
    // füst
    if (age > 0.25) {
      for (const p of puffs) {
        const r = (8 + 14 * age) * p.r;
        const x = cx + Math.cos(p.a) * spread * p.d * 1.15;
        const y = cy + Math.sin(p.a) * spread * p.d * 1.15;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const alpha = Math.max(0, 0.75 * (1 - (age - 0.25) / 0.75));
        g.addColorStop(0, `rgba(70,62,60,${alpha})`);
        g.addColorStop(1, 'rgba(50,46,44,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
    // tűzgömb
    if (age < 0.75) {
      const fade = 1 - age / 0.75;
      for (const p of puffs) {
        const r = (10 + 12 * age) * p.r * (0.6 + 0.4 * fade);
        const x = cx + Math.cos(p.a) * spread * p.d * 0.7;
        const y = cy + Math.sin(p.a) * spread * p.d * 0.7;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255,${Math.round(250 - 60 * age)},${Math.round(200 - 200 * age)},${fade})`);
        g.addColorStop(0.5, `rgba(255,${Math.round(170 - 80 * age)},40,${fade * 0.85})`);
        g.addColorStop(1, 'rgba(200,60,20,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      const core = (14 + 10 * age) * fade;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, core);
      g.addColorStop(0, `rgba(255,255,240,${fade})`);
      g.addColorStop(1, 'rgba(255,220,120,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - core, cy - core, core * 2, core * 2);
    }
    ctx.restore();
  }
}

export function createTextures(scene: Phaser.Scene): void {
  createTankTextures(scene);

  canvasTexture(scene, TEX.shadow, SHADOW_SIZE.w + 4, SHADOW_SIZE.h + 4, (ctx) => {
    roundRect(ctx, 2, 2, SHADOW_SIZE.w, SHADOW_SIZE.h, 8, '#000000');
  });

  canvasTexture(scene, TEX.bullet, 18, 8, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 18, 0);
    g.addColorStop(0, 'rgba(255,140,40,0)');
    g.addColorStop(0.6, 'rgba(255,200,80,0.9)');
    g.addColorStop(1, '#ffffff');
    roundRect(ctx, 0, 1.5, 18, 5, 2.5, '#000000');
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 18, 8);
    ctx.globalCompositeOperation = 'source-over';
  });

  canvasTexture(scene, TEX.flash, 34, 28, (ctx) => {
    const g = ctx.createRadialGradient(8, 14, 0, 12, 14, 20);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.35, 'rgba(255,230,110,0.95)');
    g.addColorStop(1, 'rgba(255,140,40,0)');
    poly(ctx, [0, 14, 10, 4, 14, 10, 34, 14, 14, 18, 10, 24], '#000000');
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 34, 28);
    ctx.globalCompositeOperation = 'source-over';
  });

  // jelölő a lombkorona alatt álló tankhoz: gyűrű és előre mutató nyíl
  canvasTexture(scene, TEX.marker, 96, 96, (ctx) => {
    for (const [color, width] of [['#1a1a10', 6], ['#ffd23c', 3]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.arc(48, 48, 36, 0.35, Math.PI * 2 - 0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(80, 38);
      ctx.lineTo(92, 48);
      ctx.lineTo(80, 58);
      ctx.stroke();
    }
  });

  const boom = canvasTexture(scene, TEX.explosion, EXPLOSION_SIZE * EXPLOSION_FRAMES, EXPLOSION_SIZE, drawExplosion);
  for (let f = 0; f < EXPLOSION_FRAMES; f++) boom.add(f, 0, f * EXPLOSION_SIZE, 0, EXPLOSION_SIZE, EXPLOSION_SIZE);
  scene.anims.create({
    key: 'boom',
    frames: Array.from({ length: EXPLOSION_FRAMES }, (_, f) => ({ key: TEX.explosion, frame: f })),
    frameRate: 24,
    hideOnComplete: true,
  });

}
