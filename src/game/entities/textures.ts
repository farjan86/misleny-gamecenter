// Futásidőben, kódból rajzolt sprite-ok (tank, lövedék, robbanás).
// Így a prototípusnak nincs külső képfájl-függősége; később az assets/sprites
// alá tett rajzolt sprite-okra cserélhetők.
//
// A sprite-ok 12 pixel/méter felbontásra készülnek (lásd GameScene.PPM).
// A tank jobbra néz; az elejét sárga, hegyes orr és fekete nyilak jelölik.

import Phaser from 'phaser';

export const TEX = {
  hull: ['tank-hull-0', 'tank-hull-1', 'tank-hull-2'],
  turret: 'tank-turret',
  shadow: 'tank-shadow',
  bullet: 'bullet',
  flash: 'muzzle-flash',
  explosion: 'explosion',
  marker: 'tank-marker',
} as const;

export const HULL_SIZE = { w: 68, h: 42 };
export const TURRET_SIZE = { w: 64, h: 28 };
/** a torony forgáspontja a textúrán belül (pixel) */
export const TURRET_PIVOT = { x: 16, y: 14 };
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

function drawHull(ctx: Ctx, frame: number): void {
  // lánctalpak
  for (const y of [1, 31]) {
    roundRect(ctx, 1, y, 58, 10, 3, '#17171c', '#0c0c10', 1.5);
    ctx.fillStyle = '#3a3a44';
    for (let x = 4 + frame * 2; x < 57; x += 6) ctx.fillRect(x, y + 1.5, 2.5, 7);
  }

  // test: hátul szögletes, elöl hegyes
  const body = [5, 8, 46, 8, 66, 17, 66, 25, 46, 34, 5, 34];
  poly(ctx, body, '#4c7c3c', '#182c14', 2.5);
  // fény felül, árnyék alul
  poly(ctx, [7, 10, 45, 10, 45, 13, 7, 13], '#6fa558');
  poly(ctx, [7, 29, 45, 29, 45, 32, 7, 32], '#356330');

  // sárga orr – ez a tank eleje
  poly(ctx, [44, 9.5, 46.5, 9.5, 64.5, 17.5, 64.5, 24.5, 46.5, 32.5, 44, 32.5], '#ffd23c', '#3a2c06', 1.5);
  poly(ctx, [45, 11, 47, 11, 62, 18, 62, 20, 45, 13], '#fff0a0');
  // fekete nyilak előre
  ctx.strokeStyle = '#2a2006';
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const x of [47, 53]) {
    ctx.beginPath();
    ctx.moveTo(x, 15);
    ctx.lineTo(x + 5.5, 21);
    ctx.lineTo(x, 27);
    ctx.stroke();
  }

  // motortér rácsokkal és kipufogókkal (hátul)
  roundRect(ctx, 8, 13, 13, 16, 1.5, '#27332a', '#141c16', 1.5);
  ctx.fillStyle = '#0f1611';
  for (let x = 10.5; x < 20; x += 3) ctx.fillRect(x, 15, 1.4, 12);
  ctx.fillStyle = '#b05a2c';
  ctx.fillRect(2.5, 13, 4, 4.5);
  ctx.fillRect(2.5, 24.5, 4, 4.5);
  ctx.fillStyle = '#3c1c0c';
  ctx.fillRect(2.5, 14.5, 1.6, 1.6);
  ctx.fillRect(2.5, 26, 1.6, 1.6);

  // toronygyűrű
  ctx.beginPath();
  ctx.arc(34, 21, 11.5, 0, Math.PI * 2);
  ctx.fillStyle = '#325a2c';
  ctx.fill();
  ctx.strokeStyle = '#182c14';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawTurret(ctx: Ctx): void {
  const { x: px, y: py } = TURRET_PIVOT;
  // cső
  roundRect(ctx, px + 8, py - 3, 36, 6, 1.5, '#3a5634', '#12200f', 1.5);
  ctx.fillStyle = '#5c8050';
  ctx.fillRect(px + 10, py - 2, 32, 1.6);
  // csőszájfék
  roundRect(ctx, px + 38, py - 4.5, 9, 9, 1.5, '#1e1e22', '#0a0a0c', 1.2);
  ctx.fillStyle = '#4a4a52';
  ctx.fillRect(px + 40, py - 3, 1.6, 6);
  ctx.fillRect(px + 43.5, py - 3, 1.6, 6);
  // torony
  poly(ctx, [px - 10, py - 8, px + 5, py - 10, px + 11, py - 5, px + 11, py + 5, px + 5, py + 10, px - 10, py + 8, px - 13, py], '#5c9448', '#14240f', 2.2);
  poly(ctx, [px - 9, py - 6.5, px + 4.5, py - 8.5, px + 8, py - 5.5, px - 8, py - 3.5], '#86be6a');
  poly(ctx, [px - 9, py + 6.5, px + 4.5, py + 8.5, px + 8, py + 5.5, px - 8, py + 3.5], '#3e7036');
  // búvónyílás
  ctx.beginPath();
  ctx.arc(px - 3, py + 0.5, 4.2, 0, Math.PI * 2);
  ctx.fillStyle = '#2e5a2a';
  ctx.fill();
  ctx.strokeStyle = '#14240f';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = '#6aa256';
  ctx.fillRect(px - 5, py - 1.5, 3, 1.4);
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
  TEX.hull.forEach((key, frame) => canvasTexture(scene, key, HULL_SIZE.w, HULL_SIZE.h, (ctx) => drawHull(ctx, frame)));
  canvasTexture(scene, TEX.turret, TURRET_SIZE.w, TURRET_SIZE.h, drawTurret);

  canvasTexture(scene, TEX.shadow, HULL_SIZE.w + 4, HULL_SIZE.h + 4, (ctx) => {
    roundRect(ctx, 2, 2, HULL_SIZE.w, HULL_SIZE.h, 8, '#000000');
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
