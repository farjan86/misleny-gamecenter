// A civil járművek és a telepíthető ágyú kódból rajzolt textúrái. A járművek
// jobbra néznek, 12 pixel/méter felbontásban. A személyautóknak hat formája és
// tíz színe van – minden párosításhoz külön kis textúra készül.

import Phaser from 'phaser';
import { BUS_LIVERIES, CAR_COLORS, CAR_SHAPES, VEHICLES, type VehicleKind } from '../sim/vehicles';

type Ctx = CanvasRenderingContext2D;

const PPM = 12;
/** a textúra széle a jármű körül (pixel) */
const PAD = 3;

/** A személyautók színei (a sorrend a `look` értékének része, ne változzon). */
export const CAR_PAINT = ['#e9e9e4', '#aab0b6', '#2b2d31', '#5b6068', '#b5302b', '#2c5aa6', '#2f6a48', '#d9b02c', '#cf6f2a', '#9a8468'] as const;

export const VTEX = {
  turretBase: 'turret-base',
  /** a fényszóró fénykúpja (jobbra néz, a csúcsa a bal szélén) */
  beam: 'fx-beam',
} as const;

/** A jármű textúrájának neve a fajtája és a megjelenése szerint. */
export function vehicleTexture(kind: VehicleKind, look: number): string {
  if (kind === 'car') return `car-${Math.max(0, Math.min(CAR_SHAPES.length * CAR_COLORS - 1, look))}`;
  if (kind === 'bus') return `bus-${Math.max(0, Math.min(BUS_LIVERIES - 1, look))}`;
  return 'truck';
}

function canvasTexture(scene: Phaser.Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void): void {
  const tex = scene.textures.createCanvas(key, w, h)!;
  draw(tex.context);
  tex.refresh();
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number): number => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

const GLASS = '#26303c';
const GLASS_SHINE = 'rgba(190,215,240,0.28)';

/** A formák méretei méterben: hossz, szélesség, motorháztető, csomagtartó (0: nincs), tető világosítása. */
const SHAPES: Record<(typeof CAR_SHAPES)[number], { length: number; width: number; hood: number; trunk: number; corner: number }> = {
  sedan: { length: 4.5, width: 1.8, hood: 1.15, trunk: 0.85, corner: 0.5 },
  hatchback: { length: 3.9, width: 1.75, hood: 0.95, trunk: 0, corner: 0.55 },
  estate: { length: 4.6, width: 1.8, hood: 1.15, trunk: 0, corner: 0.45 },
  suv: { length: 4.6, width: 1.95, hood: 1.25, trunk: 0, corner: 0.35 },
  van: { length: 5.0, width: 2.0, hood: 0.6, trunk: 0, corner: 0.3 },
  pickup: { length: 5.0, width: 1.9, hood: 1.25, trunk: 1.7, corner: 0.35 },
};

/** Fényszórók elöl, féklámpák hátul; a sarkokon. */
function lamps(ctx: Ctx, x0: number, y0: number, L: number, W: number): void {
  ctx.fillStyle = '#fff3c0';
  ctx.fillRect(x0 + L - 3, y0 + 2, 2.5, 4);
  ctx.fillRect(x0 + L - 3, y0 + W - 6, 2.5, 4);
  ctx.fillStyle = '#c6362c';
  ctx.fillRect(x0 + 0.5, y0 + 2, 2, 4);
  ctx.fillRect(x0 + 0.5, y0 + W - 6, 2, 4);
}

function drawCar(ctx: Ctx, shape: (typeof CAR_SHAPES)[number], paint: string, w: number, h: number): void {
  const s = SHAPES[shape];
  const L = s.length * PPM;
  const W = s.width * PPM;
  const x0 = (w - L) / 2;
  const y0 = (h - W) / 2;
  // karosszéria sötét kontúrral
  rect(ctx, x0 - 0.8, y0 - 0.8, L + 1.6, W + 1.6, s.corner * PPM + 0.8, shade(paint, 0.42));
  rect(ctx, x0, y0, L, W, s.corner * PPM, paint);
  // a motorháztető és a far kissé sötétebb, középen fényes csík
  const cabinFront = x0 + L - s.hood * PPM;
  const cabinBack = x0 + (shape === 'pickup' ? s.trunk * PPM : s.trunk * PPM + 2);
  ctx.fillStyle = shade(paint, 0.88);
  ctx.fillRect(cabinFront, y0 + 2, s.hood * PPM - 3, W - 4);
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(cabinFront + 2, y0 + W / 2 - 3, s.hood * PPM - 7, 6);

  if (shape === 'pickup') {
    // nyitott plató: sötét belső, peremmel
    rect(ctx, x0 + 2, y0 + 2.5, s.trunk * PPM - 2, W - 5, 1.5, shade(paint, 0.55));
    rect(ctx, x0 + 3.5, y0 + 4, s.trunk * PPM - 5, W - 8, 1, '#2c2a28');
  } else if (s.trunk > 0) {
    ctx.fillStyle = shade(paint, 0.9);
    ctx.fillRect(x0 + 2, y0 + 2, s.trunk * PPM - 1, W - 4);
  }

  // üvegek: szélvédő, hátsó ablak, oldalablakok – köztük a tető
  const glassFront = cabinFront - 1;
  const cabin = glassFront - cabinBack;
  const wind = shape === 'van' ? 7 : 8;
  const rear = shape === 'van' ? 0 : shape === 'pickup' ? 4 : 6;
  rect(ctx, cabinBack, y0 + 2, cabin, W - 4, 3, GLASS);
  // tető
  const roofX = cabinBack + rear;
  const roofW = cabin - rear - wind;
  rect(ctx, roofX, y0 + (shape === 'van' ? 2 : 3.6), roofW, W - (shape === 'van' ? 4 : 7.2), 2, shade(paint, shape === 'van' ? 0.97 : 1.06));
  ctx.fillStyle = GLASS_SHINE;
  ctx.fillRect(glassFront - wind + 1.5, y0 + 4, 2, W - 8);
  if (shape === 'suv' || shape === 'estate') {
    // tetősínek
    ctx.fillStyle = shade(paint, 0.6);
    ctx.fillRect(roofX + 2, y0 + 4.6, roofW - 4, 1);
    ctx.fillRect(roofX + 2, y0 + W - 5.6, roofW - 4, 1);
  }
  if (shape === 'van') {
    // a raktér bordái
    ctx.fillStyle = shade(paint, 0.84);
    for (let x = roofX + 6; x < roofX + roofW - 4; x += 9) ctx.fillRect(x, y0 + 3, 1, W - 6);
  }
  // ajtóoszlop és visszapillantók
  if (shape !== 'van') {
    ctx.fillStyle = shade(paint, 0.8);
    ctx.fillRect(roofX + roofW * 0.5 - 0.5, y0 + 2, 1.2, W - 4);
  }
  ctx.fillStyle = shade(paint, 0.5);
  ctx.fillRect(glassFront - wind + 1, y0 - 1.6, 2.4, 2);
  ctx.fillRect(glassFront - wind + 1, y0 + W - 0.4, 2.4, 2);
  lamps(ctx, x0, y0, L, W);
}

const LIVERIES: [body: string, stripe: string, roof: string][] = [
  ['#e8c22a', '#2a2c30', '#f1d560'],
  ['#e9ecee', '#2c62b0', '#f6f7f8'],
  ['#3a78c2', '#f0f0ea', '#5a94d6'],
];

function drawBus(ctx: Ctx, livery: number, w: number, h: number): void {
  const [body, stripe, roof] = LIVERIES[livery] ?? LIVERIES[0];
  const spec = VEHICLES.bus;
  const L = spec.length * PPM;
  const W = spec.width * PPM;
  const x0 = (w - L) / 2;
  const y0 = (h - W) / 2;
  rect(ctx, x0 - 0.8, y0 - 0.8, L + 1.6, W + 1.6, 4.8, shade(body, 0.4));
  rect(ctx, x0, y0, L, W, 4, body);
  // oldalablak-sor a két szélén, alatta színes csík
  ctx.fillStyle = GLASS;
  ctx.fillRect(x0 + 6, y0 + 1.6, L - 20, 2.6);
  ctx.fillRect(x0 + 6, y0 + W - 4.2, L - 20, 2.6);
  ctx.fillStyle = stripe;
  ctx.fillRect(x0 + 4, y0 + 4.6, L - 14, 1.6);
  ctx.fillRect(x0 + 4, y0 + W - 6.2, L - 14, 1.6);
  // tető: világosabb lap, szellőzők és klíma
  rect(ctx, x0 + 5, y0 + 7, L - 18, W - 14, 2, roof);
  ctx.fillStyle = shade(body, 0.7);
  for (const at of [0.2, 0.5, 0.78]) {
    ctx.fillRect(x0 + L * at - 6, y0 + W / 2 - 5, 12, 10);
    ctx.fillStyle = shade(body, 0.86);
    ctx.fillRect(x0 + L * at - 4.5, y0 + W / 2 - 3.5, 9, 7);
    ctx.fillStyle = shade(body, 0.7);
  }
  // szélvédő elöl, hátsó ablak
  rect(ctx, x0 + L - 10, y0 + 2.5, 7, W - 5, 2, GLASS);
  ctx.fillStyle = GLASS_SHINE;
  ctx.fillRect(x0 + L - 8.5, y0 + 5, 2, W - 10);
  rect(ctx, x0 + 1.5, y0 + 4, 3, W - 8, 1, GLASS);
  // visszapillantók
  ctx.fillStyle = '#22242a';
  ctx.fillRect(x0 + L - 6, y0 - 2.4, 3, 2.4);
  ctx.fillRect(x0 + L - 6, y0 + W, 3, 2.4);
  lamps(ctx, x0, y0, L, W);
}

/** Ellátó teherautó: zöld fülke, feltűnő sárga-fekete csíkos ponyva, rajta ládajel. */
function drawTruck(ctx: Ctx, w: number, h: number): void {
  const spec = VEHICLES.truck;
  const L = spec.length * PPM;
  const W = spec.width * PPM;
  const x0 = (w - L) / 2;
  const y0 = (h - W) / 2;
  const cab = 1.9 * PPM;
  const green = '#3f5a36';
  // alváz és fülke
  rect(ctx, x0 - 0.8, y0 + 1.2, L + 1.6, W - 2.4, 3, '#1c1e1c');
  rect(ctx, x0 + L - cab, y0 + 1.5, cab, W - 3, 3, green);
  rect(ctx, x0 + L - cab + 9, y0 + 3, 7.5, W - 6, 2, GLASS);
  ctx.fillStyle = GLASS_SHINE;
  ctx.fillRect(x0 + L - cab + 13, y0 + 5, 2, W - 10);
  ctx.fillStyle = shade(green, 1.25);
  ctx.fillRect(x0 + L - cab + 2, y0 + 4, 6, W - 8);
  // rakfelület: sárga ponyva fekete ferde csíkokkal
  const boxL = L - cab - 2;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x0, y0, boxL, W, 2.5);
  ctx.clip();
  ctx.fillStyle = '#f0b81e';
  ctx.fillRect(x0, y0, boxL, W);
  ctx.fillStyle = '#1e1e1e';
  for (let x = -W; x < boxL + W; x += 13) {
    ctx.beginPath();
    ctx.moveTo(x0 + x, y0);
    ctx.lineTo(x0 + x + 5, y0);
    ctx.lineTo(x0 + x + 5 - W * 0.45, y0 + 4.5);
    ctx.lineTo(x0 + x - W * 0.45, y0 + 4.5);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x0 + x, y0 + W - 4.5);
    ctx.lineTo(x0 + x + 5, y0 + W - 4.5);
    ctx.lineTo(x0 + x + 5 - W * 0.45, y0 + W);
    ctx.lineTo(x0 + x - W * 0.45, y0 + W);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = '#6a4e08';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(x0 + 0.6, y0 + 0.6, boxL - 1.2, W - 1.2, 2.5);
  ctx.stroke();
  // ládajel: fehér négyzet, benne kereszt alakú pántok
  const cx = x0 + boxL / 2;
  const cy = y0 + W / 2;
  rect(ctx, cx - 8, cy - 7, 16, 14, 1.5, '#fff8e0');
  ctx.strokeStyle = '#3a2c08';
  ctx.lineWidth = 1.6;
  ctx.strokeRect(cx - 8, cy - 7, 16, 14);
  ctx.beginPath();
  ctx.moveTo(cx, cy - 7);
  ctx.lineTo(cx, cy + 7);
  ctx.moveTo(cx - 8, cy);
  ctx.lineTo(cx + 8, cy);
  ctx.stroke();
  lamps(ctx, x0, y0 + 1, L, W - 2);
}

export function createVehicleTextures(scene: Phaser.Scene): void {
  if (scene.textures.exists('truck')) return;
  CAR_SHAPES.forEach((shape, si) => {
    const s = SHAPES[shape];
    const w = Math.ceil(s.length * PPM) + PAD * 2;
    const h = Math.ceil(s.width * PPM) + PAD * 2;
    CAR_PAINT.forEach((paint, ci) => canvasTexture(scene, `car-${si * CAR_COLORS + ci}`, w, h, (ctx) => drawCar(ctx, shape, paint, w, h)));
  });
  {
    const w = Math.ceil(VEHICLES.bus.length * PPM) + PAD * 2;
    const h = Math.ceil(VEHICLES.bus.width * PPM) + PAD * 2;
    for (let i = 0; i < BUS_LIVERIES; i++) canvasTexture(scene, `bus-${i}`, w, h, (ctx) => drawBus(ctx, i, w, h));
  }
  {
    const w = Math.ceil(VEHICLES.truck.length * PPM) + PAD * 2;
    const h = Math.ceil(VEHICLES.truck.width * PPM) + PAD * 2;
    canvasTexture(scene, 'truck', w, h, (ctx) => drawTruck(ctx, w, h));
  }

  // az ágyú talpa: homokzsák-gyűrű, benne acéllap (a csöve a tank tornyának képe)
  canvasTexture(scene, VTEX.turretBase, 44, 44, (ctx) => {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      ctx.save();
      ctx.translate(22 + Math.cos(a) * 15, 22 + Math.sin(a) * 15);
      ctx.rotate(a + Math.PI / 2);
      rect(ctx, -6, -3.6, 12, 7.2, 3, i % 2 ? '#a89468' : '#b8a478');
      ctx.strokeStyle = '#5c4f34';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(22, 22, 10.5, 0, Math.PI * 2);
    ctx.fillStyle = '#3c4248';
    ctx.fill();
    ctx.strokeStyle = '#1c1f24';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // fénykúp: a csúcsától kifelé szélesedő, elhalványuló fény
  canvasTexture(scene, VTEX.beam, 96, 64, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 96, 0);
    g.addColorStop(0, 'rgba(255,244,200,0.85)');
    g.addColorStop(1, 'rgba(255,244,200,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 28);
    ctx.lineTo(96, 4);
    ctx.lineTo(96, 60);
    ctx.lineTo(0, 36);
    ctx.closePath();
    ctx.fill();
  });
}
