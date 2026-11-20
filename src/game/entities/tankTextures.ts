// A tankok kódból rajzolt sprite-jai. A szintek hat osztályba (tier) tartoznak,
// mindegyiknek saját teste és tornya van: a felderítőtől a négy futóműves,
// tolólapos rombolón át az energiaágyús titánig. A rajzok a saját (zöld) tankot
// ábrázolják; a botoké (vörös) és a többi játékosé (kék) átszínezéssel készül,
// a roncsoké megfeketítéssel.
//
// A sprite-ok 12 pixel/méter felbontásra készülnek, a tank jobbra néz. A test
// rajza egy 68 × 42 pixeles alapméret köré épül (ez az 1. osztály teste); a
// nagyobb osztályok lánctalpai, tolólapjai ezen túlnyúlnak, ezért a vászon
// nagyobb. A torony forgáspontja és a cső vége (47 pixel a forgásponttól – a
// szimuláció innen indítja a lövedéket) minden osztálynál ugyanott van.

import Phaser from 'phaser';
import { CLASSIC_TANKS } from './classicTanks';

export const TANK_TIERS = 6;
export const TRACK_FRAMES = 3;
/** egy osztályon belül ennyi szintlépést jelez külön rajz (kilövésgyűrűk a csövön, csillagok) */
export const TANK_MARKS = 5;
/** a saját tank zöld, a botoké vörös, a többi játékosé kék */
export type TankPaint = 'own' | 'bot' | 'rival';

/** Az osztályok neve (a LEVEL.tiers sorrendjében). */
export const TIER_NAMES = ['Felderítő', 'Közepes harckocsi', 'Nehéz harckocsi', 'Ostromtank', 'Romboló', 'Titán'] as const;

export const HULL_SIZE = { w: 96, h: 68 };
/** az 1. osztály testének mérete: a rajzok ennek a téglalapnak a koordinátáit használják */
const BODY = { w: 68, h: 42 };
export const TURRET_SIZE = { w: 84, h: 48 };
/** a torony forgáspontja a textúrán belül (pixel) */
export const TURRET_PIVOT = { x: 26, y: 24 };

/** look: az alaptank fajtája (0 … TANK_LOOKS − 1); minden fajtának saját rajzai vannak osztályonként */
export const tankTex = {
  hull: (paint: TankPaint, tier: number, frame: number, look = 0): string => `tank${look}-${paint}-hull-${tier}-${frame}`,
  /** marks: hány szintet lépett a tank az osztályán belül (0 … TANK_MARKS − 1) */
  turret: (paint: TankPaint, tier: number, marks = 0, look = 0): string => `tank${look}-${paint}-turret-${tier}-${Math.max(0, Math.min(TANK_MARKS - 1, marks))}`,
  /** sérülésréteg a test, illetve a torony fölé (stage: 1 … DAMAGE_STAGES) */
  damageHull: (tier: number, stage: number, look = 0): string => `tank${look}-damage-hull-${tier}-${stage}`,
  damageTurret: (tier: number, stage: number, look = 0): string => `tank${look}-damage-turret-${tier}-${stage}`,
  wreckHull: (tier: number, look = 0): string => `wreck${look}-hull-${tier}`,
  wreckTurret: (tier: number, look = 0): string => `wreck${look}-turret-${tier}`,
} as const;

/** A sérülés fokozatai: 1 – karcos, lyuggatott; 2 – kormos, repedt; 3 – szétlőtt, izzó. */
export const DAMAGE_STAGES = 3;
/** A sérülés fokozata a megmaradt életerő arányából (0: ép). */
export const damageStage = (ratio: number): number => (ratio > 0.75 ? 0 : ratio > 0.5 ? 1 : ratio > 0.25 ? 2 : 3);

type Ctx = CanvasRenderingContext2D;

const INK = '#182c14';
const STEEL = '#8a9099';
const STEEL_L = '#c3c8d0';
const STEEL_D = '#4a4f58';
const STEEL_EDGE = '#1c1f24';
const GUN = '#2a2d33';
const GOLD = '#f0c040';
const GOLD_D = '#8a6a14';
const YELLOW = '#ffd23c';
const CYAN = '#5fe6ff';

function poly(ctx: Ctx, pts: number[], fill: string | null, stroke?: string, lineWidth = 2): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

function box(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string, lineWidth = 1.2): void {
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

function disc(ctx: Ctx, x: number, y: number, r: number, fill: string, stroke?: string, lineWidth = 1.2): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

/** Lánctalp: sötét szalag, rajta a láncszemek – a képkockával együtt „haladnak”. */
function track(ctx: Ctx, frame: number, x: number, y: number, w: number, h: number): void {
  box(ctx, x, y, w, h, 3, '#17171c', '#0c0c10', 1.5);
  ctx.fillStyle = '#3a3a44';
  for (let lx = x + 3 + frame * 2; lx < x + w - 2.5; lx += 6) ctx.fillRect(lx, y + 1.5, 2.5, h - 3);
}

/** Előre mutató fekete nyilak: ez jelzi a tank elejét. */
function arrows(ctx: Ctx, xs: number[], color = '#2a2006'): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const x of xs) {
    ctx.beginPath();
    ctx.moveTo(x, 15);
    ctx.lineTo(x + 5.5, 21);
    ctx.lineTo(x, 27);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

/** Sárga-fekete figyelmeztető csíkozás egy téglalapban. */
function hazard(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = YELLOW;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#1a1a14';
  ctx.lineWidth = 2.2;
  for (let d = -w; d < h + w; d += 5.5) {
    ctx.beginPath();
    ctx.moveTo(x - 1, y + d + w + 1);
    ctx.lineTo(x + w + 1, y + d - 1);
    ctx.stroke();
  }
  ctx.restore();
}

/** Motortér rácsa; `glow`: az izzó motor narancs fénye a rések között. */
function grille(ctx: Ctx, x: number, y: number, w: number, h: number, glow = false): void {
  box(ctx, x, y, w, h, 1.5, glow ? '#1c1f22' : '#27332a', glow ? '#0c0d10' : '#141c16', 1.5);
  for (let sx = x + 2.5; sx < x + w - 2; sx += 3.2) {
    if (glow) {
      ctx.fillStyle = '#ff7a1e';
      ctx.fillRect(sx - 0.3, y + 2, 2, h - 4);
      ctx.fillStyle = '#ffdc8c';
      ctx.fillRect(sx + 0.2, y + 3.5, 1, h - 7);
    } else {
      ctx.fillStyle = '#0f1611';
      ctx.fillRect(sx, y + 2, 1.4, h - 4);
    }
  }
}

function exhaust(ctx: Ctx, x: number, y: number, r: number, hot = false): void {
  disc(ctx, x, y, r, '#b05a2c', '#3c1c0c', 1.2);
  disc(ctx, x, y, r * 0.48, hot ? '#ffb040' : '#1a0c06');
}

function turretRing(ctx: Ctx, r: number, fill = '#325a2c', stroke = INK): void {
  disc(ctx, 34, 21, r, fill, stroke, 1.5);
}

function rivets(ctx: Ctx, x0: number, x1: number, y: number, step: number, color = STEEL_L): void {
  ctx.fillStyle = color;
  for (let x = x0; x <= x1; x += step) {
    ctx.beginPath();
    ctx.arc(x, y, 0.8, 0, Math.PI * 2);
    ctx.fill();
  }
}

// --- testek -----------------------------------------------------------------------

/** 1. osztály – felderítő: könnyű, hegyes orrú test. */
function hull0(ctx: Ctx, frame: number): void {
  track(ctx, frame, 1, 1, 58, 10);
  track(ctx, frame, 1, 31, 58, 10);
  // test: hátul szögletes, elöl hegyes
  poly(ctx, [5, 8, 46, 8, 66, 17, 66, 25, 46, 34, 5, 34], '#4c7c3c', INK, 2.5);
  poly(ctx, [7, 10, 45, 10, 45, 13, 7, 13], '#6fa558');
  poly(ctx, [7, 29, 45, 29, 45, 32, 7, 32], '#356330');
  // sárga orr – ez a tank eleje
  poly(ctx, [44, 9.5, 46.5, 9.5, 64.5, 17.5, 64.5, 24.5, 46.5, 32.5, 44, 32.5], YELLOW, '#3a2c06', 1.5);
  poly(ctx, [45, 11, 47, 11, 62, 18, 62, 20, 45, 13], '#fff0a0');
  arrows(ctx, [47, 53]);
  // motortér rácsokkal és kipufogókkal (hátul)
  grille(ctx, 8, 13, 13, 16);
  ctx.fillStyle = '#b05a2c';
  ctx.fillRect(2.5, 13, 4, 4.5);
  ctx.fillRect(2.5, 24.5, 4, 4.5);
  ctx.fillStyle = '#3c1c0c';
  ctx.fillRect(2.5, 14.5, 1.6, 1.6);
  ctx.fillRect(2.5, 26, 1.6, 1.6);
  turretRing(ctx, 11.5);
}

/** 2. osztály – közepes harckocsi: sárvédők, lökhárító, málhaládák, rangsávok. */
function hull1(ctx: Ctx, frame: number): void {
  track(ctx, frame, 0, 0, 62, 11);
  track(ctx, frame, 0, 31, 62, 11);
  // szegmentált sárvédő a lánctalp külső fele fölött
  for (const y of [-1, 37.5]) for (let i = 0; i < 5; i++) box(ctx, 2 + i * 12, y, 11, 5.5, 1.2, '#40703a', INK, 1.2);
  poly(ctx, [4, 7, 47, 7, 67, 16.5, 67, 25.5, 47, 35, 4, 35], '#4c7c3c', INK, 2.5);
  poly(ctx, [6, 9, 46, 9, 46, 12, 6, 12], '#6fa558');
  poly(ctx, [6, 30, 46, 30, 46, 33, 6, 33], '#356330');
  poly(ctx, [45, 8.5, 47.5, 8.5, 65.5, 17, 65.5, 25, 47.5, 33.5, 45, 33.5], YELLOW, '#3a2c06', 1.5);
  poly(ctx, [46, 10, 48, 10, 63, 17.5, 63, 19.5, 46, 12.5], '#fff0a0');
  arrows(ctx, [48, 54]);
  // acél lökhárító az orron
  box(ctx, 64.5, 13, 4.5, 16, 1.5, STEEL, STEEL_EDGE, 1.2);
  ctx.fillStyle = STEEL_L;
  ctx.fillRect(65.5, 14.5, 1.2, 13);
  grille(ctx, 7, 12, 14, 18);
  exhaust(ctx, 3.5, 13.5, 2.6);
  exhaust(ctx, 3.5, 28.5, 2.6);
  // málhaládák
  box(ctx, 23, 8.5, 10, 5, 1, '#7a6a48', '#2a2416', 1);
  box(ctx, 23, 28.5, 10, 5, 1, '#7a6a48', '#2a2416', 1);
  // két világos rangsáv a test közepén
  ctx.fillStyle = '#e9eedc';
  ctx.fillRect(36.5, 8.5, 2.2, 25);
  ctx.fillRect(40.5, 8.5, 2.2, 25);
  turretRing(ctx, 12.5);
}

/** 3. osztály – nehéz harckocsi: széles lánctalp, pótpáncél, acél törőék az orron. */
function hull2(ctx: Ctx, frame: number): void {
  track(ctx, frame, -3, -3, 67, 13);
  track(ctx, frame, -3, 32, 67, 13);
  poly(ctx, [1, 6, 44, 4, 58, 10, 58, 32, 44, 38, 1, 36], '#477639', INK, 2.5);
  poly(ctx, [3, 8, 43, 6.5, 43, 9.5, 3, 11], '#699f54');
  poly(ctx, [3, 31, 43, 32.5, 43, 35.5, 3, 34], '#315c2c');
  // oldalsó pótpáncél szegecsekkel
  for (const y of [11.5, 27]) {
    box(ctx, 21, y, 23, 3.5, 0.8, '#39652f', INK, 1);
    rivets(ctx, 23, 42, y + 1.75, 4.6);
  }
  // sárga homloklemez nyilakkal
  poly(ctx, [45, 8.5, 56.5, 11.5, 56.5, 30.5, 45, 33.5], YELLOW, '#3a2c06', 1.5);
  arrows(ctx, [46.5, 50.5]);
  // acél törőék
  poly(ctx, [57, 5, 66, 1.5, 72, 6, 72, 36, 66, 40.5, 57, 37], STEEL, STEEL_EDGE, 1.8);
  poly(ctx, [59, 6.5, 65.5, 3.8, 69, 6.6, 60, 9.5], STEEL_L);
  hazard(ctx, 66.5, 9, 4.5, 24);
  grille(ctx, 4, 12, 15, 18);
  exhaust(ctx, 4.5, 7.2, 3.3);
  exhaust(ctx, 4.5, 34.8, 3.3);
  turretRing(ctx, 13.5);
}

/** 4. osztály – ostromtank: láncvédő kötény, reaktív páncél, tüskés ék, izzó motor. */
function hull3(ctx: Ctx, frame: number): void {
  track(ctx, frame, -4, -4, 70, 14);
  track(ctx, frame, -4, 32, 70, 14);
  // láncvédő kötény csavarokkal
  for (const y of [-6, 42]) {
    box(ctx, -3, y, 66, 6, 1.5, '#365f30', INK, 1.3);
    rivets(ctx, 1, 59, y + 3, 8.3);
  }
  poly(ctx, [-1, 9, 7, 4, 46, 4, 62, 12, 62, 30, 46, 38, 7, 38, -1, 33], '#42703a', INK, 2.5);
  poly(ctx, [8, 6, 45, 6, 45, 9, 5, 9], '#63975a');
  poly(ctx, [5, 33, 45, 33, 45, 36, 8, 36], '#2c5429');
  // sárga jelzősáv a homlok előtt
  poly(ctx, [43, 5.5, 45.2, 5.5, 45.2, 36.5, 43, 36.5], YELLOW, '#3a2c06', 1);
  // reaktív páncélkockák a homlokon
  for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) box(ctx, 46.5 + c * 7, 11.2 + r * 5, 6, 4.1, 0.8, '#5d8f4c', INK, 0.9);
  // acél ék három tüskével
  poly(ctx, [61, 9, 67.5, 6.5, 67.5, 35.5, 61, 33], STEEL, STEEL_EDGE, 1.6);
  for (const y of [11, 21, 31]) poly(ctx, [66.8, y - 3.6, 78, y, 66.8, y + 3.6], STEEL_L, STEEL_EDGE, 1.2);
  grille(ctx, 2, 12, 15.5, 18, true);
  exhaust(ctx, 0.5, 8.5, 3, true);
  exhaust(ctx, 0.5, 33.5, 3, true);
  // üzemanyaghordók
  for (const y of [5.6, 30.4]) {
    box(ctx, 20, y, 12.5, 6, 2.6, STEEL, STEEL_EDGE, 1.2);
    ctx.fillStyle = STEEL_D;
    ctx.fillRect(23.8, y + 0.7, 1.2, 4.6);
    ctx.fillRect(27.6, y + 0.7, 1.2, 4.6);
  }
  turretRing(ctx, 14.5, '#2f5529');
}

/** 5. osztály – romboló: négy külön futómű, acéllemezek, hatalmas tolólap. */
function hull4(ctx: Ctx, frame: number): void {
  for (const x of [-9, 33]) {
    for (const y of [-9, 36]) {
      track(ctx, frame, x, y, 39, 15);
      // a futómű acél burkolata a külső oldalon
      box(ctx, x + 8, y < 0 ? y - 1.5 : y + 11.5, 23, 5, 1.6, STEEL, STEEL_EDGE, 1.2);
      rivets(ctx, x + 11, x + 28, y < 0 ? y + 1 : y + 14, 5.6, STEEL_EDGE);
    }
  }
  poly(ctx, [-3, 8, 9, 3, 50, 3, 65, 11, 65, 31, 50, 39, 9, 39, -3, 34], '#3d6b38', INK, 2.6);
  poly(ctx, [10, 5, 49, 5, 49, 8, 6, 8], '#5c9054');
  poly(ctx, [6, 34, 49, 34, 49, 37, 10, 37], '#274d27');
  // acél páncéllemezek a test két oldalán
  for (const y of [9.5, 28.5]) {
    box(ctx, 16, y, 31, 4, 1, STEEL, STEEL_EDGE, 1.1);
    rivets(ctx, 18.5, 45, y + 2, 5.2, STEEL_EDGE);
  }
  // sárga homloklemez nyilakkal és figyelmeztető sávval
  poly(ctx, [49, 5, 51.5, 5, 63, 12, 63, 30, 51.5, 37, 49, 37], YELLOW, '#3a2c06', 1.5);
  arrows(ctx, [51, 56]);
  // tolólap fogakkal
  poly(ctx, [64, 0, 72, -7, 77, -7, 79, 0, 79, 42, 77, 49, 72, 49, 64, 42], STEEL, STEEL_EDGE, 1.9);
  poly(ctx, [66.5, 1, 72.5, -4.2, 75.5, -3.6, 69, 4], STEEL_L);
  hazard(ctx, 68, 7, 5, 28);
  for (const y of [-1, 9, 21, 33, 43]) poly(ctx, [78.4, y - 3.2, 82, y, 78.4, y + 3.2], '#e8ebf0', STEEL_EDGE, 1.1);
  grille(ctx, 1, 11.5, 16.5, 19, true);
  for (const y of [6.5, 12.5, 29.5, 35.5]) exhaust(ctx, -2.2, y, 2.4, true);
  turretRing(ctx, 15.5, STEEL_D, STEEL_EDGE);
  disc(ctx, 34, 21, 12.5, '#2c5228', INK, 1.2);
}

/** 6. osztály – titán: sötét páncél arany szegéllyel, energiamag, aranyfogú tolólap. */
function hull5(ctx: Ctx, frame: number): void {
  for (const x of [-10, 33]) {
    for (const y of [-10, 36]) {
      track(ctx, frame, x, y, 41, 16);
      box(ctx, x + 7, y < 0 ? y - 2 : y + 13, 27, 5, 2, GUN, GOLD, 1.2);
    }
  }
  poly(ctx, [-4, 8, 8, 2, 50, 2, 66, 11, 66, 31, 50, 40, 8, 40, -4, 34], '#2f5a34', '#0e1c10', 3);
  // páncélbordák
  poly(ctx, [12, 6.5, 47, 6.5, 47, 11, 12, 11], '#3f7244');
  poly(ctx, [12, 31, 47, 31, 47, 35.5, 12, 35.5], '#234a29');
  // arany szegély a test peremén
  poly(ctx, [-1, 9.6, 9, 4.7, 49.2, 4.7, 63.3, 12.6, 63.3, 29.4, 49.2, 37.3, 9, 37.3, -1, 32.4], null, GOLD, 1.3);
  // energiavezetékek a magtól a toronyig
  ctx.save();
  ctx.shadowColor = CYAN;
  ctx.shadowBlur = 5;
  ctx.strokeStyle = CYAN;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  for (const [x0, y0, x1, y1] of [[10, 21, 22, 21], [9, 15, 21, 11], [9, 27, 21, 31], [21, 11, 30, 9], [21, 31, 30, 33]]) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  // energiamag hátul
  const core = ctx.createRadialGradient(7, 21, 0, 7, 21, 7.5);
  core.addColorStop(0, '#ffffff');
  core.addColorStop(0.45, CYAN);
  core.addColorStop(1, '#16506e');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(7, 21, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(7, 21, 7.4, 0, Math.PI * 2);
  ctx.stroke();
  // arany homlokék nyilakkal
  poly(ctx, [48, 6.5, 51.5, 6.5, 63, 13.5, 63, 28.5, 51.5, 35.5, 48, 35.5], GOLD, GOLD_D, 1.5);
  poly(ctx, [49.5, 8, 51.5, 8, 60.5, 14, 60.5, 16, 49.5, 10.5], '#fff0b0');
  arrows(ctx, [50.5, 55.5], '#2a1c02');
  // sötét acél tolólap aranyfogakkal
  poly(ctx, [65, -1, 73, -8, 77, -8, 79, -1, 79, 43, 77, 50, 73, 50, 65, 43], '#3a3f48', '#0c0d10', 1.9);
  poly(ctx, [67.5, 0, 73.2, -5.2, 75.6, -4.8, 69.6, 3], STEEL);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(71.5, -3);
  ctx.lineTo(71.5, 45);
  ctx.stroke();
  for (const y of [-2, 7, 16, 26, 35, 44]) poly(ctx, [78.4, y - 3.3, 82, y, 78.4, y + 3.3], GOLD, GOLD_D, 1.1);
  for (const y of [5.5, 36.5]) exhaust(ctx, -3, y, 2.6, true);
  turretRing(ctx, 16.5, GUN, GOLD);
  disc(ctx, 34, 21, 13, '#244a2a', '#0e1c10', 1.2);
}

const HULLS = [hull0, hull1, hull2, hull3, hull4, hull5];

// --- tornyok (a forgáspont az origó, a cső jobbra néz) ---------------------------------

function barrel(ctx: Ctx, x: number, length: number, width: number, y = 0, fill = '#3a5634', light = '#5c8050'): void {
  box(ctx, x, y - width / 2, length, width, 1.5, fill, '#12200f', 1.5);
  ctx.fillStyle = light;
  ctx.fillRect(x + 2, y - width / 2 + 1, length - 4, Math.max(1.4, width * 0.26));
}

/** Csőszájfék: a cső végén, a vége mindig 47 pixelre van a forgásponttól. */
function muzzle(ctx: Ctx, length: number, height: number, y = 0): void {
  const x = 47 - length;
  box(ctx, x, y - height / 2, length, height, 1.5, '#1e1e22', '#0a0a0c', 1.2);
  ctx.fillStyle = '#4a4a52';
  for (let sx = x + 2; sx < 47 - 2; sx += 3.5) ctx.fillRect(sx, y - height / 2 + 1.5, 1.6, height - 3);
}

function hatch(ctx: Ctx, x: number, y: number, r: number, fill = '#2e5a2a', light = '#6aa256'): void {
  disc(ctx, x, y, r, fill, '#14240f', 1.2);
  ctx.fillStyle = light;
  ctx.fillRect(x - r * 0.5, y - r * 0.5, r * 0.75, 1.4);
}

/** Kilövésgyűrűk a csövön: az osztályon belül minden szintlépés egy újabb fehér gyűrű. */
function bands(ctx: Ctx, marks: number, x: number, step: number, height: number, y = 0): void {
  for (let i = 0; i < marks; i++) {
    ctx.fillStyle = '#101410';
    ctx.fillRect(x + i * step - 0.5, y - height / 2, 3, height);
    ctx.fillStyle = '#f4f6ea';
    ctx.fillRect(x + i * step, y - height / 2, 2, height);
  }
}

function star(ctx: Ctx, x: number, y: number, r: number): void {
  const pts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const d = i % 2 === 0 ? r : r * 0.42;
    pts.push(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  poly(ctx, pts, GOLD, GOLD_D, 0.8);
}

function turret0(ctx: Ctx, marks: number): void {
  barrel(ctx, 8, 36, 6);
  bands(ctx, marks, 14, 3.8, 5.2);
  muzzle(ctx, 9, 9);
  poly(ctx, [-10, -8, 5, -10, 11, -5, 11, 5, 5, 10, -10, 8, -13, 0], '#5c9448', '#14240f', 2.2);
  poly(ctx, [-9, -6.5, 4.5, -8.5, 8, -5.5, -8, -3.5], '#86be6a');
  poly(ctx, [-9, 6.5, 4.5, 8.5, 8, 5.5, -8, 3.5], '#3e7036');
  hatch(ctx, -3, 0.5, 4.2);
}

function turret1(ctx: Ctx, marks: number): void {
  barrel(ctx, 9, 34, 7.4);
  bands(ctx, marks, 14.5, 3.6, 6.6);
  // füstelszívó a cső közepén
  box(ctx, 23, -5.2, 9, 10.4, 2.2, '#33502e', '#12200f', 1.3);
  muzzle(ctx, 9.5, 10.5);
  // málharács a torony hátulján
  box(ctx, -19.5, -7.5, 7, 15, 1, STEEL_D, STEEL_EDGE, 1.1);
  ctx.fillStyle = STEEL_EDGE;
  for (const y of [-4.5, -1, 2.5]) ctx.fillRect(-18.5, y, 5, 1);
  poly(ctx, [-12, -9.5, 5, -11.5, 12.5, -6, 12.5, 6, 5, 11.5, -12, 9.5, -15, 0], '#5c9448', '#14240f', 2.2);
  poly(ctx, [-11, -8, 4.5, -10, 9.5, -6.5, -10, -4.5], '#86be6a');
  poly(ctx, [-11, 8, 4.5, 10, 9.5, 6.5, -10, 4.5], '#3e7036');
  // parancsnoki kupola géppuskával
  hatch(ctx, -4.5, 3.6, 4.6);
  ctx.strokeStyle = '#101214';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-4.5, 3.6);
  ctx.lineTo(5.5, 5.4);
  ctx.stroke();
  hatch(ctx, -3, -5, 2.8);
}

function turret2(ctx: Ctx, marks: number): void {
  barrel(ctx, 12, 30, 8.6);
  bands(ctx, marks, 18.5, 4, 7.8);
  muzzle(ctx, 12.5, 12.5);
  poly(ctx, [-15, -10, -6, -13, 6, -13, 13.5, -8, 13.5, 8, 6, 13, -6, 13, -15, 10, -17.5, 0], '#58904a', '#14240f', 2.3);
  poly(ctx, [-13.5, -8.5, -5.5, -11.3, 5.5, -11.3, 10.5, -8, -12, -5.5], '#82ba68');
  poly(ctx, [-13.5, 8.5, -5.5, 11.3, 5.5, 11.3, 10.5, 8, -12, 5.5], '#3a6a33');
  // acél csőpajzs
  box(ctx, 9, -7.5, 7, 15, 1.6, STEEL, STEEL_EDGE, 1.3);
  ctx.fillStyle = STEEL_L;
  ctx.fillRect(10.3, -6, 1.3, 12);
  // ködgránátvetők a torony két oldalán
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) disc(ctx, -3 + i * 4.4, s * 14.6, 1.9, STEEL_D, STEEL_EDGE, 1);
  hatch(ctx, -6.5, -3.5, 4.4);
  hatch(ctx, -5, 5.5, 3);
  box(ctx, 2, -3, 4, 6, 0.8, GUN, '#0a0a0c', 1);
}

function turret3(ctx: Ctx, marks: number): void {
  // párhuzamos gépágyú a főlöveg mellett
  box(ctx, 9, 6.6, 25, 3.2, 1, GUN, '#0a0a0c', 1);
  barrel(ctx, 12, 29, 8.8);
  // hővédő köpeny acél bilincsekkel
  ctx.fillStyle = STEEL;
  for (const x of [17.5, 30]) ctx.fillRect(x, -5.2, 2.4, 10.4);
  bands(ctx, marks, 21, 3, 8);
  muzzle(ctx, 13.5, 13.5);
  // acél málhadoboz hátul, antenna
  box(ctx, -23, -8.5, 7.5, 17, 1.2, STEEL, STEEL_EDGE, 1.2);
  ctx.fillStyle = STEEL_D;
  ctx.fillRect(-21.5, -0.6, 4.5, 1.2);
  poly(ctx, [-17, -12, 8, -13.5, 15, -8, 15, 8, 8, 13.5, -17, 12, -19, 0], '#507f42', '#14240f', 2.3);
  poly(ctx, [-15.5, -10.3, 7.5, -11.8, 11.5, -8.5, -14, -7], '#79b060');
  poly(ctx, [-15.5, 10.3, 7.5, 11.8, 11.5, 8.5, -14, 7], '#335e2e');
  // reaktív páncélkockák a torony két oldalán
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) box(ctx, -5 + i * 5.6, s > 0 ? 7.6 : -11.8, 4.9, 4.2, 0.7, '#6a9c58', '#14240f', 0.8);
  box(ctx, 9.5, -6.5, 6.5, 13, 1.4, STEEL, STEEL_EDGE, 1.2);
  hatch(ctx, -8, -1.5, 4.8);
  // célzóoptika narancs lencsével
  box(ctx, 0.5, -5.2, 5.5, 4.6, 0.8, GUN, '#0a0a0c', 1);
  disc(ctx, 4.2, -2.9, 1.5, '#ff8a2a');
  ctx.strokeStyle = '#101214';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-13, 7.5);
  ctx.lineTo(-24.5, 14.5);
  ctx.stroke();
  disc(ctx, -24.5, 14.5, 1.3, STEEL_L);
}

function turret4(ctx: Ctx, marks: number): void {
  // ikerlöveg
  for (const y of [-5.2, 5.2]) {
    barrel(ctx, 12, 30, 6.6, y, '#34502f', '#557a4a');
    bands(ctx, marks, 18.5, 3.8, 5.8, y);
    muzzle(ctx, 10, 9.4, y);
  }
  // rakétavetők a torony két oldalán
  for (const s of [-1, 1]) {
    box(ctx, -13, s > 0 ? 14 : -21.5, 19, 7.5, 1.5, STEEL_D, STEEL_EDGE, 1.2);
    for (let i = 0; i < 3; i++) {
      disc(ctx, -8.5 + i * 5.2, s * 17.75, 2.1, '#0c0d10');
      disc(ctx, -8.5 + i * 5.2, s * 17.75, 1, '#d8322c');
    }
  }
  poly(ctx, [-18, -13, 6, -15, 14, -9.5, 14, 9.5, 6, 15, -18, 13, -21, 0], '#4a7a40', '#14240f', 2.4);
  poly(ctx, [-16.5, -11.2, 5.5, -13.2, 10.5, -9.8, -15, -8], '#74aa5e');
  poly(ctx, [-16.5, 11.2, 5.5, 13.2, 10.5, 9.8, -15, 8], '#2f582b');
  // acél csőpajzs és középső páncéllemez
  box(ctx, 9, -10.5, 7.5, 21, 2, STEEL, STEEL_EDGE, 1.3);
  ctx.fillStyle = STEEL_L;
  ctx.fillRect(10.4, -9, 1.3, 18);
  box(ctx, -4, -5, 11, 10, 1.2, STEEL_D, STEEL_EDGE, 1.1);
  rivets(ctx, -2, 5, -3, 3.5, STEEL_L);
  rivets(ctx, -2, 5, 3, 3.5, STEEL_L);
  // radar a torony hátulján
  disc(ctx, -13, 0, 5, STEEL_L, STEEL_EDGE, 1.2);
  disc(ctx, -13, 0, 1.6, '#d8322c');
  ctx.strokeStyle = STEEL_EDGE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-17.5, -2.2);
  ctx.lineTo(-8.5, 2.2);
  ctx.stroke();
}

function turret5(ctx: Ctx, marks: number): void {
  // kiegészítő gépágyúk a torony két oldalán
  for (const y of [-12.8, 12.8]) box(ctx, 5, y - 1.7, 22, 3.4, 1, GUN, '#0a0a0c', 1);
  // energiaágyú: két sín között izzó sugárcsatorna, arany tekercsekkel
  ctx.save();
  ctx.shadowColor = CYAN;
  ctx.shadowBlur = 6;
  const beam = ctx.createLinearGradient(10, 0, 48, 0);
  beam.addColorStop(0, '#1a7fa8');
  beam.addColorStop(0.6, CYAN);
  beam.addColorStop(1, '#ffffff');
  ctx.fillStyle = beam;
  ctx.fillRect(11, -2.6, 36, 5.2);
  ctx.restore();
  for (const y of [-4.8, 4.8]) box(ctx, 10, y - 1.9, 37, 3.8, 1, GUN, '#0a0a0c', 1.1);
  for (const x of [15, 23, 31, 39]) box(ctx, x, -7.6, 3.4, 15.2, 1.1, GOLD, GOLD_D, 1);
  box(ctx, 44, -6.4, 3, 12.8, 1.1, STEEL_L, STEEL_EDGE, 1);
  // sötét torony arany szegéllyel
  poly(ctx, [-20, -13, -8, -16, 6, -16, 15, -9.5, 15, 9.5, 6, 16, -8, 16, -20, 13, -23, 0], '#2f5a34', '#0e1c10', 2.5);
  poly(ctx, [-18, -11, -7.5, -14, 5.5, -14, 10.5, -10.5, -16.5, -8], '#447a48');
  poly(ctx, [-18, 11, -7.5, 14, 5.5, 14, 10.5, 10.5, -16.5, 8], '#214526');
  poly(ctx, [-17.6, -11.4, -7.2, -13.6, 5.2, -13.6, 12.6, -8.3, 12.6, 8.3, 5.2, 13.6, -7.2, 13.6, -17.6, 11.4, -20.2, 0], null, GOLD, 1.2);
  box(ctx, 9.5, -8, 6.5, 16, 1.6, '#3a3f48', '#0c0d10', 1.2);
  // izzó mag a torony tetején
  ctx.save();
  ctx.shadowColor = CYAN;
  ctx.shadowBlur = 5;
  const core = ctx.createRadialGradient(-3, 0, 0, -3, 0, 6.5);
  core.addColorStop(0, '#ffffff');
  core.addColorStop(0.5, CYAN);
  core.addColorStop(1, '#16506e');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(-3, 0, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(-3, 0, 6.4, 0, Math.PI * 2);
  ctx.stroke();
  // arany csillagok hátul: szintenként eggyel több
  const count = 1 + marks;
  for (let i = 0; i < count; i++) star(ctx, -14.8, (i - (count - 1) / 2) * 5.3, count > 1 ? 2.7 : 3.6);
}

const TURRETS = [turret0, turret1, turret2, turret3, turret4, turret5];

// --- a 2. alaptank: Vadász – kerekes páncélvadász ---------------------------------------
// Lánctalp helyett kerekeken gurul; a teste hosszú, lapos, hegyes ék, a tornya alacsony és
// szögletes, a csöve nagyon hosszú és vékony. A fokozatokkal több tengely, pótpáncél,
// rakétacsövek, végül ikersínágyú kerül rá – de mindvégig ugyanaz a jármű marad.

/** Kerék felülről: gumiabroncs bordákkal; a képkockával a bordák „forognak”. */
function wheel(ctx: Ctx, frame: number, x: number, y: number, w: number, h: number): void {
  box(ctx, x, y, w, h, 2.6, '#141418', '#08080a', 1.4);
  ctx.fillStyle = '#383840';
  for (let lx = x + 1.6 + frame * 1.4; lx < x + w - 1.6; lx += 4.2) ctx.fillRect(lx, y + 1.2, 1.6, h - 2.4);
}

/** A rajz a test közepe körül megnő a fokozattal (a nagyobb osztály nagyobb jármű). */
function grown(ctx: Ctx, tier: number, draw: () => void): void {
  const k = 1 + tier * 0.044;
  ctx.save();
  ctx.translate(34, 21);
  ctx.scale(k, k);
  ctx.translate(-34, -21);
  draw();
  ctx.restore();
}

function hullB(ctx: Ctx, frame: number, tier: number): void {
  grown(ctx, tier, () => {
    // kerekek a test két oldalán: három tengely, a 3. osztálytól négy
    const axles = tier >= 2 ? 4 : 3;
    for (let i = 0; i < axles; i++) {
      const x = 4 + (i * 48) / (axles - 1) - 5.5;
      wheel(ctx, frame, x, -3, 12.5, 8.5);
      wheel(ctx, frame, x, 36.5, 12.5, 8.5);
    }
    // a 2. osztálytól páncélkötény a kerekek fölött, a 4.-től acélból, szegecselve
    if (tier >= 1) {
      for (const y of [0.5, 36.5]) {
        box(ctx, 0, y, 57, 5, 1.6, tier >= 3 ? STEEL_D : '#3a6a34', tier >= 3 ? STEEL_EDGE : INK, 1.2);
        if (tier >= 3) rivets(ctx, 4, 54, y + 2.5, 7);
      }
    }
    // test: hosszú, lapos ék – hátul levágott, elöl tűhegyes
    poly(ctx, [0, 11.5, 11, 6.5, 44, 6.5, 60, 12.5, 71, 21, 60, 29.5, 44, 35.5, 11, 35.5, 0, 30.5], '#4c7c3c', INK, 2.5);
    // lapolt páncél: világos felső lap, sötét alsó lap, közöttük éles gerinc
    poly(ctx, [3.5, 12.5, 12, 8.6, 43.5, 8.6, 57.5, 13.6, 65, 19.6, 3.5, 19.6], '#659c50');
    poly(ctx, [3.5, 22.4, 65, 22.4, 57.5, 28.4, 43.5, 33.4, 12, 33.4, 3.5, 29.5], '#356330');
    ctx.fillStyle = tier >= 5 ? GOLD : '#8cc470';
    ctx.fillRect(5, 20.3, 58, 1.4);
    // sárga ékek az orron: ez a tank eleje
    poly(ctx, [50.5, 9.8, 54.5, 11.4, 65, 21, 54.5, 30.6, 50.5, 32.2, 60, 21], tier >= 5 ? GOLD : YELLOW, '#3a2c06', 1.2);
    poly(ctx, [42.5, 8.4, 46.5, 8.8, 55.5, 21, 46.5, 33.2, 42.5, 33.6, 51.5, 21], '#e0a81c', '#3a2c06', 1);
    // hátul motorrács, két hosszú kipufogócső
    grille(ctx, 5.5, 13.5, 10, 15, tier >= 4);
    for (const y of [10.2, 28.2]) {
      box(ctx, -5, y, 8.5, 3.6, 1.4, '#b05a2c', '#3c1c0c', 1);
      ctx.fillStyle = tier >= 4 ? '#ffb040' : '#1a0c06';
      ctx.fillRect(-4.4, y + 1, 1.8, 1.6);
    }
    if (tier >= 1) {
      // málharács és tartalék kerék hátul
      box(ctx, 17.5, 9, 7, 5, 1, '#7a6a48', '#2a2416', 1);
      box(ctx, 17.5, 28, 7, 5, 1, '#7a6a48', '#2a2416', 1);
      // fényszórók az orr két oldalán
      for (const y of [13.2, 28.8]) disc(ctx, 57.5, y, 1.5, '#fff6c8', '#3a2c06', 0.8);
    }
    if (tier >= 2) {
      // szögletes pótpáncél a test két oldalán
      poly(ctx, [26, 4.4, 41, 4.4, 44, 7.6, 24, 7.6], STEEL, STEEL_EDGE, 1.2);
      poly(ctx, [26, 37.6, 41, 37.6, 44, 34.4, 24, 34.4], STEEL, STEEL_EDGE, 1.2);
      ctx.fillStyle = STEEL_L;
      ctx.fillRect(27, 5.1, 13, 1);
    }
    if (tier >= 3) {
      // acél törőél az orr hegyén, füstgránátvetők a két oldalon
      poly(ctx, [61, 13.5, 66, 15.5, 74.5, 21, 66, 26.5, 61, 28.5, 68, 21], STEEL_L, STEEL_EDGE, 1.3);
      for (const y of [9.6, 30.4]) for (let i = 0; i < 3; i++) box(ctx, 30 + i * 3.4, y, 2.6, 2, 0.6, GUN, '#000', 0.6);
    }
    if (tier >= 4) {
      // reaktív páncélcsempék a felső és az alsó lapon, figyelmeztető csík hátul
      for (let i = 0; i < 5; i++) {
        box(ctx, 20 + i * 5.4, 10.4, 4.6, 3.6, 0.6, '#40703a', INK, 0.9);
        box(ctx, 20 + i * 5.4, 28, 4.6, 3.6, 0.6, '#2c5a2c', INK, 0.9);
      }
      hazard(ctx, 0.8, 16, 3.6, 10);
    }
    if (tier >= 5) {
      // arany szegély, izzó energiagerinc, rakétatárolók hátul
      poly(ctx, [2.2, 12.6, 11.6, 8.3, 43.6, 8.3, 58.6, 13.8, 67.8, 21, 58.6, 28.2, 43.6, 33.7, 11.6, 33.7, 2.2, 29.4], null, GOLD, 1.2);
      ctx.save();
      ctx.shadowColor = CYAN;
      ctx.shadowBlur = 5;
      ctx.fillStyle = CYAN;
      ctx.fillRect(18, 20.4, 30, 1.2);
      ctx.restore();
      for (const y of [1.4, 35.4]) {
        box(ctx, 5, y, 14, 5.2, 1, GUN, GOLD, 1.1);
        for (let i = 0; i < 3; i++) disc(ctx, 8 + i * 4, y + 2.6, 1.3, '#c8301c', '#3a0c06', 0.6);
      }
    }
    turretRing(ctx, 10.5 + tier * 0.4, tier >= 5 ? GUN : '#325a2c', tier >= 5 ? GOLD : INK);
  });
}

function turretB(ctx: Ctx, marks: number, tier: number): void {
  const twin = tier >= 5;
  const w = 4.4 + tier * 0.3;
  // a 3. osztálytól párhuzamos gépágyú a cső mellett
  if (tier >= 2 && !twin) barrel(ctx, 6, 25, 2.8, -6.4 - tier * 0.25, '#2c3a30', '#58725c');
  if (twin) {
    // ikersínágyú: két hosszú sín, közöttük izzó csatorna
    ctx.save();
    ctx.shadowColor = CYAN;
    ctx.shadowBlur = 6;
    ctx.fillStyle = CYAN;
    ctx.fillRect(10, -1.3, 36, 2.6);
    ctx.restore();
    for (const y of [-3.6, 3.6]) barrel(ctx, 6, 41, 3.6, y, GUN, '#5a6068');
    for (const x of [16, 26, 36]) box(ctx, x, -6.6, 2.8, 13.2, 1, GOLD, GOLD_D, 0.9);
    bands(ctx, marks, 20.4, 3.2, 3, -3.6);
  } else {
    // nagyon hosszú, vékony cső hőköpennyel és szögletes csőszájfékkel
    barrel(ctx, 6, 38, w);
    box(ctx, 15, -w / 2 - 1.1, 13, w + 2.2, 1.4, '#33502e', '#12200f', 1.1);
    bands(ctx, marks, 30, 3.2, w - 0.6);
    muzzle(ctx, 7.5 + tier * 0.4, w + 4.2 + tier * 0.5);
  }
  const k = 1 + tier * 0.05;
  ctx.save();
  ctx.scale(k, k);
  if (tier >= 3) {
    // rakétacsövek a torony két oldalán (a 5. osztályon három-három)
    const tubes = tier >= 4 ? 3 : 2;
    for (const side of [-1, 1]) {
      const y = side * 13.2;
      box(ctx, -12, y - (tubes * 1.7) / 2 - 0.9, 15, tubes * 1.7 + 1.8, 1, GUN, tier >= 5 ? GOLD : '#0a0a0c', 1);
      for (let i = 0; i < tubes; i++) disc(ctx, 2, y + (i - (tubes - 1) / 2) * 1.75, 0.75, '#c8301c');
    }
  }
  // lapos, szögletes ék-torony, hátrafelé megnyúlva
  poly(ctx, [-16, -8, -3, -10.5, 8, -6.5, 13, 0, 8, 6.5, -3, 10.5, -16, 8], tier >= 5 ? '#2f5a34' : '#5c9448', '#14240f', 2.2);
  poly(ctx, [-14.5, -6.8, -3.4, -8.8, 6.6, -5.4, 10, -1.2, -14.5, -1.2], tier >= 5 ? '#447a48' : '#86be6a');
  poly(ctx, [-14.5, 6.8, -3.4, 8.8, 6.6, 5.4, 10, 1.2, -14.5, 1.2], tier >= 5 ? '#214526' : '#3e7036');
  // irányzó optika elöl: sötét doboz kék lencsével
  box(ctx, 1.5, -4.4, 5.5, 3.2, 0.8, '#0e1820', '#000', 0.8);
  ctx.fillStyle = CYAN;
  ctx.fillRect(2.6, -3.6, 3.2, 1.3);
  hatch(ctx, -8.5, 3.2, 3.4);
  if (tier >= 1) {
    // rádióantenna és hátsó tárolóláda
    box(ctx, -21, -5, 5.5, 10, 1, STEEL_D, STEEL_EDGE, 1);
    ctx.strokeStyle = '#101214';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-12.5, -5.5);
    ctx.lineTo(-22, -11);
    ctx.stroke();
  }
  if (tier >= 4) {
    // forgó radar a torony tetején
    disc(ctx, -3, -3.6, 3.3, STEEL, STEEL_EDGE, 1);
    ctx.strokeStyle = STEEL_EDGE;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-5.6, -5);
    ctx.lineTo(-0.4, -2.2);
    ctx.stroke();
  }
  if (tier >= 5) {
    poly(ctx, [-14.6, -7, -3.2, -9.2, 7, -5.6, 10.8, 0, 7, 5.6, -3.2, 9.2, -14.6, 7], null, GOLD, 1.1);
    const count = 1 + marks;
    for (let i = 0; i < count; i++) star(ctx, -11.5, (i - (count - 1) / 2) * 3.4, count > 1 ? 1.8 : 2.6);
  }
  ctx.restore();
}

// --- a 3. alaptank: Cirkáló – légpárnás harcjármű --------------------------------------
// Se lánctalp, se kerék: gumiszoknyás légpárnán siklik, hátul emelőventilátorok hajtják.
// A teste csepp alakú, a tornya kerek kupola rövid, vastag ágyúval. A fokozatokkal
// stabilizáló szárnyak, páncél, harmadik turbina, oldalgondolák, végül forgócsöves ágyú jön.

/** Ventilátor felülről: a lapátok a képkockával forognak. */
function fan(ctx: Ctx, frame: number, x: number, y: number, r: number, hot = false): void {
  disc(ctx, x, y, r, '#101216', '#050608', 1.4);
  disc(ctx, x, y, r - 1.5, hot ? '#3a1c0c' : '#242830');
  ctx.strokeStyle = hot ? '#ff9a3c' : STEEL_L;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + frame * 0.52;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * (r - 2), y + Math.sin(a) * (r - 2));
    ctx.stroke();
  }
  disc(ctx, x, y, 1.4, STEEL, STEEL_EDGE, 0.8);
}

function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, fill: string | null, stroke?: string, lineWidth = 1.2): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function hullC(ctx: Ctx, frame: number, tier: number): void {
  grown(ctx, tier, () => {
    if (tier >= 4) {
      // oldalgondolák saját ventilátorral, merevítőkkel a testhez kötve
      for (const y of [-1.2, 43.2]) {
        ctx.fillStyle = STEEL_D;
        ctx.fillRect(22, Math.min(y, 21), 3, Math.abs(21 - y));
        ctx.fillRect(40, Math.min(y, 21), 3, Math.abs(21 - y));
        ellipse(ctx, 32, y, 15, 5, '#3a6a34', INK, 1.6);
        fan(ctx, frame, 26, y, 3.6);
        box(ctx, 34, y - 1.6, 13, 3.2, 1, GUN, tier >= 5 ? GOLD : '#0a0a0c', 1);
      }
    }
    // légpárna-szoknya: sötét gumi, a bordái a képkockával körbefutnak
    ellipse(ctx, 34, 21, 36, 22.5, '#17171c', '#08080a', 1.6);
    ctx.strokeStyle = '#3c3c46';
    ctx.lineWidth = 1.7;
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2 + frame * 0.07;
      ctx.beginPath();
      ctx.moveTo(34 + Math.cos(a) * 31, 21 + Math.sin(a) * 19.2);
      ctx.lineTo(34 + Math.cos(a) * 35, 21 + Math.sin(a) * 21.8);
      ctx.stroke();
    }
    if (tier >= 2) {
      // páncéllemezek a szoknyán
      for (const a of [0.55, 1.15, 1.99, 2.59, -0.55, -1.15, -1.99, -2.59]) {
        ctx.save();
        ctx.translate(34 + Math.cos(a) * 33, 21 + Math.sin(a) * 20.6);
        ctx.rotate(Math.atan2(Math.sin(a) * 36, Math.cos(a) * 22.5) + Math.PI / 2);
        box(ctx, -5, -2, 10, 4, 1, tier >= 5 ? GUN : STEEL, tier >= 5 ? GOLD : STEEL_EDGE, 1);
        ctx.restore();
      }
    }
    if (tier >= 1) {
      // stabilizáló szárnyak a test két oldalán
      poly(ctx, [20, 4, 40, 0.5, 44, 4.5, 26, 8.5], '#40703a', INK, 1.5);
      poly(ctx, [20, 38, 40, 41.5, 44, 37.5, 26, 33.5], '#2c5a2c', INK, 1.5);
    }
    // test: csepp alak – hátul kerek, elöl hegyesedik
    const body = (): void => {
      ctx.beginPath();
      ctx.moveTo(4, 21);
      ctx.bezierCurveTo(4, 7, 26, 4, 46, 7);
      ctx.bezierCurveTo(58, 9, 67, 16, 68.5, 21);
      ctx.bezierCurveTo(67, 26, 58, 33, 46, 35);
      ctx.bezierCurveTo(26, 38, 4, 35, 4, 21);
      ctx.closePath();
    };
    body();
    ctx.fillStyle = '#4c7c3c';
    ctx.fill();
    // fény felül, árnyék alul: ettől domború a test
    ctx.save();
    body();
    ctx.clip();
    ctx.fillStyle = '#6fa558';
    ctx.beginPath();
    ctx.ellipse(34, 9, 30, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#356330';
    ctx.beginPath();
    ctx.ellipse(34, 34.5, 30, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    // sárga orr: ez a tank eleje
    ctx.fillStyle = tier >= 5 ? GOLD : YELLOW;
    ctx.beginPath();
    ctx.ellipse(72, 21, 21, 19, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    body();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    arrows(ctx, [53, 58.5]);
    // két hátsó emelőventilátor
    fan(ctx, frame, 14, 13, 5.6, tier >= 4);
    fan(ctx, frame, 14, 29, 5.6, tier >= 4);
    if (tier >= 2) {
      // acél orrvédő ív
      ctx.strokeStyle = STEEL_L;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.ellipse(52, 21, 19, 15.5, 0, -0.62, 0.62);
      ctx.stroke();
      ctx.strokeStyle = STEEL_EDGE;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.ellipse(52, 21, 20.4, 16.8, 0, -0.62, 0.62);
      ctx.stroke();
    }
    if (tier >= 3) {
      // harmadik, nagy tolóturbina hátul középen, izzó fúvókával
      box(ctx, -4, 15, 10, 12, 2.5, STEEL_D, STEEL_EDGE, 1.4);
      const hot = ctx.createLinearGradient(-4, 0, 3, 0);
      hot.addColorStop(0, '#fff0b0');
      hot.addColorStop(1, '#ff7a1e');
      ctx.fillStyle = hot;
      ctx.fillRect(-3, 17, 4.5, 8);
      // szellőzőrések a test hátán
      for (const y of [17, 21, 25]) box(ctx, 21, y - 0.8, 6, 1.6, 0.6, '#0f1611');
    }
    if (tier >= 4) hazard(ctx, 7, 18.2, 3.4, 5.6);
    if (tier >= 5) {
      // arany perem, izzó energiacsíkok, két farokuszony
      ctx.save();
      body();
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = 1.2;
      ctx.translate(34, 21);
      ctx.scale(0.93, 0.9);
      ctx.translate(-34, -21);
      body();
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.shadowColor = CYAN;
      ctx.shadowBlur = 5;
      ctx.strokeStyle = CYAN;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      for (const y of [11.5, 30.5]) {
        ctx.beginPath();
        ctx.moveTo(22, y);
        ctx.lineTo(46, y + (y < 21 ? 1.5 : -1.5));
        ctx.stroke();
      }
      ctx.restore();
      poly(ctx, [-3, 6, 9, 9.5, 9, 12, -3, 10], GUN, GOLD, 1);
      poly(ctx, [-3, 36, 9, 32.5, 9, 30, -3, 32], GUN, GOLD, 1);
    }
    turretRing(ctx, 11 + tier * 0.45, tier >= 5 ? GUN : '#325a2c', tier >= 5 ? GOLD : INK);
  });
}

function turretC(ctx: Ctx, marks: number, tier: number): void {
  const fat = 7.6 + tier * 0.45;
  if (tier >= 5) {
    // forgócsöves ágyú: három cső közös abroncsban, izzó torkolattal
    for (const y of [-5.4, 0, 5.4]) barrel(ctx, 8, 37, 4, y, GUN, '#5a6068');
    for (const x of [18, 30]) box(ctx, x, -9, 3.4, 18, 1.4, GOLD, GOLD_D, 1);
    ctx.save();
    ctx.shadowColor = CYAN;
    ctx.shadowBlur = 6;
    ctx.fillStyle = CYAN;
    for (const y of [-5.4, 0, 5.4]) ctx.fillRect(44.4, y - 1.2, 2.6, 2.4);
    ctx.restore();
    bands(ctx, marks, 36, 2.8, 3.2);
  } else if (tier >= 4) {
    // ikerágyú
    for (const y of [-5.2, 5.2]) {
      barrel(ctx, 8, 32, 6.4, y);
      muzzle(ctx, 8.5, 9, y);
    }
    bands(ctx, marks, 24, 3.2, 5.6, -5.2);
  } else {
    // rövid, vastag ágyú széles, tölcséres csőszájjal
    barrel(ctx, 8, 31, fat);
    box(ctx, 16, -fat / 2 - 1.3, 6.5, fat + 2.6, 1.6, '#33502e', '#12200f', 1.2);
    bands(ctx, marks, 25, 3.2, fat - 0.8);
    muzzle(ctx, 9.5, fat + 5.5);
  }
  // a 3. osztálytól kis gépágyú a kupola oldalán
  if (tier >= 2 && tier < 5) barrel(ctx, 2, 19, 2.6, 10.2 + tier * 0.3, '#2c3a30', '#58725c');
  const k = 1 + tier * 0.05;
  ctx.save();
  ctx.scale(k, k);
  if (tier >= 3) {
    // páncélgallér a kupola körül
    disc(ctx, 0, 0, 14.2, tier >= 5 ? GUN : STEEL_D, tier >= 5 ? GOLD : STEEL_EDGE, 1.3);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.3;
      disc(ctx, Math.cos(a) * 12.9, Math.sin(a) * 12.9, 0.7, STEEL_L);
    }
  }
  // kerek kupola: fény balra fent, árnyék jobbra lent
  disc(ctx, 0, 0, 11.6, tier >= 5 ? '#2f5a34' : '#5c9448', '#14240f', 2.2);
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, 10.4, 0, Math.PI * 2);
  ctx.clip();
  disc(ctx, -3, -4.5, 8.5, tier >= 5 ? '#447a48' : '#86be6a');
  disc(ctx, 4.5, 6.5, 7, tier >= 5 ? '#214526' : '#3e7036');
  ctx.restore();
  disc(ctx, 0, 0, 5.6, tier >= 5 ? '#244a2a' : '#4c7c3c', '#14240f', 1.1);
  // kilátórés elöl: sötét üveg kék csíkkal
  box(ctx, 4.4, -2.4, 6, 4.8, 2, '#0e1a24', '#000', 0.9);
  ctx.fillStyle = CYAN;
  ctx.fillRect(6, -1.4, 3, 1.1);
  hatch(ctx, -3.5, 0, 2.8);
  if (tier >= 1) {
    // érzékelőárboc a kupola oldalán
    disc(ctx, -6.5, -9.6, 2.5, STEEL, STEEL_EDGE, 1);
    disc(ctx, -6.5, -9.6, 1, '#c8301c');
  }
  if (tier >= 5) {
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, 9.7, 0, Math.PI * 2);
    ctx.stroke();
    const count = 1 + marks;
    for (let i = 0; i < count; i++) star(ctx, -8.4 + (count > 3 ? 0.6 : 0), (i - (count - 1) / 2) * 3.2, count > 1 ? 1.6 : 2.4);
  }
  ctx.restore();
}

/**
 * Az alaptankok: a név, egy rövid jellemzés, és az osztályok neve fokozatonként. Az első
 * három a játék saját, modern tankja; utána a három klasszikus, II. világháborús tank
 * (classicTanks.ts) – ezek korhű festést kapnak, a csapatszínt csak az azonosító lapjuk mutatja.
 */
export const CLASSIC_FROM = 3;
export const isClassicLook = (look: number): boolean => look >= CLASSIC_FROM;
export const TANK_LOOK_NAMES: readonly string[] = ['Harckocsi', 'Vadász', 'Cirkáló', ...CLASSIC_TANKS.map((t) => t.name)];
export const TANK_LOOK_HINT: readonly string[] = [
  'Lánctalpas harckocsi: hegyes orr, zömök torony – a végén tolólapos, négy futóműves titán.',
  'Kerekes páncélvadász: hosszú, lapos ék-test, alacsony torony, nagyon hosszú cső – a végén ikersínágyú és rakéták.',
  'Légpárnás cirkáló: csepp alakú test, ventilátorok, kerek kupola vastag ágyúval – a végén forgócsöves ágyú.',
  ...CLASSIC_TANKS.map((t) => t.hint),
];
export const LOOK_TIER_NAMES: readonly (readonly string[])[] = [
  TIER_NAMES,
  ['Portyázó', 'Vadász', 'Páncélvadász', 'Ragadozó', 'Végrehajtó', 'Fantom'],
  ['Sikló', 'Cirkáló', 'Fregatt', 'Csatahajó', 'Rettegett', 'Leviatán'],
  ...CLASSIC_TANKS.map((t) => t.tierNames),
];

const tiers = <T>(make: (tier: number) => T): T[] => Array.from({ length: TANK_TIERS }, (_, tier) => make(tier));
/** A testek és a tornyok rajzai alaptankonként, osztályonként. */
const HULL_SETS: ((ctx: Ctx, frame: number) => void)[][] = [
  HULLS,
  tiers((tier) => (ctx, frame) => hullB(ctx, frame, tier)),
  tiers((tier) => (ctx, frame) => hullC(ctx, frame, tier)),
  ...CLASSIC_TANKS.map((t) => tiers((tier) => (ctx: Ctx, frame: number) => t.hull(ctx, frame, tier))),
];
const TURRET_SETS: ((ctx: Ctx, marks: number) => void)[][] = [
  TURRETS,
  tiers((tier) => (ctx, marks) => turretB(ctx, marks, tier)),
  tiers((tier) => (ctx, marks) => turretC(ctx, marks, tier)),
  ...CLASSIC_TANKS.map((t) => tiers((tier) => (ctx: Ctx, marks: number) => t.turret(ctx, marks, tier))),
];

// --- textúrák ---------------------------------------------------------------------

function canvasTexture(scene: Phaser.Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void): HTMLCanvasElement {
  const tex = scene.textures.createCanvas(key, w, h)!;
  draw(tex.context);
  tex.refresh();
  return tex.canvas;
}

/**
 * A zöld árnyalatok átszínezése vörösre (botok) vagy kékre (más játékosok); az acél, az arany
 * és a fények maradnak. `markOnly`: a klasszikus tankoknál csak az erős, telített zöld
 * azonosító lap vált színt, a korhű (tompa) festés megmarad.
 */
function recolor(ctx: Ctx, w: number, h: number, hue: 'red' | 'blue', markOnly = false): void {
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    if (markOnly ? g > 120 && g - r > 70 && g - b > 45 : g > r * 1.08 && g > b) {
      if (hue === 'red') {
        d[i] = Math.min(255, g * 1.15);
        d[i + 1] = r * 0.7;
        d[i + 2] = b * 0.7;
      } else {
        d[i] = r * 0.55;
        d[i + 1] = g * 0.72;
        d[i + 2] = Math.min(255, g * 1.35);
      }
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** Kiégett roncs: a rajz megfeketedve, rozsdás foltokkal. */
function char(ctx: Ctx, w: number, h: number): void {
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const px = (i / 4) % w;
    const py = Math.floor(i / 4 / w);
    const lum = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) * 0.42;
    // szabálytalan rozsdafoltok
    const rust = Math.sin(px * 0.9) + Math.sin(py * 1.3 + px * 0.4) > 1.1 ? 22 : 0;
    d[i] = Math.min(255, lum + 14 + rust);
    d[i + 1] = lum + 6 + rust * 0.4;
    d[i + 2] = lum;
  }
  ctx.putImageData(image, 0, 0);
}

/** Rögzített magú véletlen: a sérülések minden betöltéskor ugyanoda kerülnek. */
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

/**
 * Sérülések rajza egy téglalapba (cx, cy közép, rx, ry félméret): karcok,
 * belövések, koromfoltok, repedések, a legsúlyosabb fokozatnál kiszakadt,
 * belül izzó lyukak. A fokozatok egymásra épülnek: ami az 1. fokozatban
 * megvan, az a 2.-ban és a 3.-ban is ugyanott látszik.
 */
function drawDamage(ctx: Ctx, stage: number, seed: number, cx: number, cy: number, rx: number, ry: number): void {
  const rnd = seeded(seed);
  const at = (): [number, number] => [cx + (rnd() * 2 - 1) * rx, cy + (rnd() * 2 - 1) * ry];
  // minden fajtából a legtöbbet sorsoljuk ki, és a fokozat szerinti első néhányat rajzoljuk meg
  const scorches = Array.from({ length: 7 }, () => ({ p: at(), r: 5 + rnd() * 6 }));
  const cracks = Array.from({ length: 5 }, () => {
    let [x, y] = at();
    let angle = rnd() * Math.PI * 2;
    const pts = [x, y];
    for (let i = 0; i < 5; i++) {
      angle += (rnd() - 0.5) * 1.6;
      const len = 2.5 + rnd() * 3.5;
      x += Math.cos(angle) * len;
      y += Math.sin(angle) * len;
      pts.push(x, y);
    }
    return pts;
  });
  const scratches = Array.from({ length: 16 }, () => ({ p: at(), a: rnd() * Math.PI, len: 3 + rnd() * 7 }));
  const holes = Array.from({ length: 9 }, () => ({ p: at(), r: 1.4 + rnd() * 1.3 }));
  const tears = Array.from({ length: 3 }, () => ({ p: at(), r: 3.2 + rnd() * 2.2, a: rnd() * Math.PI * 2 }));

  // a súlyosan sérült tank egésze megfeketedik
  if (stage >= 2) {
    ctx.fillStyle = stage === 3 ? 'rgba(12,10,8,0.34)' : 'rgba(12,10,8,0.15)';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  for (const s of scorches.slice(0, [0, 2, 4, 7][stage])) {
    const r = s.r * (stage === 3 ? 1.35 : 1);
    const g = ctx.createRadialGradient(s.p[0], s.p[1], 0, s.p[0], s.p[1], r);
    g.addColorStop(0, `rgba(8,7,6,${[0, 0.55, 0.7, 0.85][stage]})`);
    g.addColorStop(0.6, `rgba(14,12,10,${[0, 0.3, 0.42, 0.55][stage]})`);
    g.addColorStop(1, 'rgba(14,12,10,0)');
    ctx.fillStyle = g;
    ctx.fillRect(s.p[0] - r, s.p[1] - r, r * 2, r * 2);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pts of cracks.slice(0, [0, 0, 3, 5][stage])) {
    for (const [color, width, shift] of [['rgba(225,228,232,0.55)', 0.8, 0.8], ['#0b0b0d', 1.5, 0]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(pts[0] + shift, pts[1] + shift);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] + shift, pts[i + 1] + shift);
      ctx.stroke();
    }
  }
  for (const s of scratches.slice(0, [0, 7, 11, 16][stage])) {
    const dx = Math.cos(s.a) * s.len;
    const dy = Math.sin(s.a) * s.len;
    for (const [color, shift] of [['rgba(10,10,12,0.6)', 0.7], ['rgba(222,226,230,0.8)', 0]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(s.p[0] + shift, s.p[1] + shift);
      ctx.lineTo(s.p[0] + dx + shift, s.p[1] + dy + shift);
      ctx.stroke();
    }
  }
  for (const h of holes.slice(0, [0, 3, 6, 9][stage])) {
    disc(ctx, h.p[0], h.p[1], h.r + 0.9, 'rgba(200,205,210,0.75)');
    disc(ctx, h.p[0], h.p[1], h.r, '#08080a');
  }
  if (stage === 3) {
    // kiszakadt páncél: szabálytalan, belül izzó lyukak
    for (const t of tears) {
      const pts: number[] = [];
      for (let i = 0; i < 7; i++) {
        const a = t.a + (i / 7) * Math.PI * 2;
        const r = t.r * (0.6 + rnd() * 0.6);
        pts.push(t.p[0] + Math.cos(a) * r, t.p[1] + Math.sin(a) * r);
      }
      poly(ctx, pts, '#070608', 'rgba(205,210,214,0.7)', 0.9);
      const g = ctx.createRadialGradient(t.p[0], t.p[1], 0, t.p[0], t.p[1], t.r * 0.7);
      g.addColorStop(0, 'rgba(255,214,120,0.95)');
      g.addColorStop(0.5, 'rgba(255,110,30,0.75)');
      g.addColorStop(1, 'rgba(160,30,10,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(t.p[0], t.p[1], t.r * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function createTankTextures(scene: Phaser.Scene): void {
  const ox = (HULL_SIZE.w - BODY.w) / 2;
  const oy = (HULL_SIZE.h - BODY.h) / 2;
  const variant = (key: string, source: HTMLCanvasElement, change: (ctx: Ctx, w: number, h: number) => void): void => {
    canvasTexture(scene, key, source.width, source.height, (ctx) => {
      ctx.drawImage(source, 0, 0);
      change(ctx, source.width, source.height);
    });
  };
  for (let look = 0; look < HULL_SETS.length; look++) {
    for (let tier = 0; tier < TANK_TIERS; tier++) {
      for (let frame = 0; frame < TRACK_FRAMES; frame++) {
        const own = canvasTexture(scene, tankTex.hull('own', tier, frame, look), HULL_SIZE.w, HULL_SIZE.h, (ctx) => {
          ctx.translate(ox, oy);
          HULL_SETS[look][tier](ctx, frame);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        });
        variant(tankTex.hull('bot', tier, frame, look), own, (ctx, w, h) => recolor(ctx, w, h, 'red', isClassicLook(look)));
        variant(tankTex.hull('rival', tier, frame, look), own, (ctx, w, h) => recolor(ctx, w, h, 'blue', isClassicLook(look)));
        if (frame === 0) {
          variant(tankTex.wreckHull(tier, look), own, char);
          // sérülésrétegek: a rajz csak ott látszik, ahol a tank teste van
          for (let stage = 1; stage <= DAMAGE_STAGES; stage++) {
            canvasTexture(scene, tankTex.damageHull(tier, stage, look), HULL_SIZE.w, HULL_SIZE.h, (ctx) => {
              drawDamage(ctx, stage, 101 + tier * 17 + look * 7, HULL_SIZE.w / 2, HULL_SIZE.h / 2, 27 + tier * 2.2, 16 + tier * 2.6);
              ctx.globalCompositeOperation = 'destination-in';
              ctx.drawImage(own, 0, 0);
              ctx.globalCompositeOperation = 'source-over';
            });
          }
        }
      }
      for (let marks = 0; marks < TANK_MARKS; marks++) {
        const own = canvasTexture(scene, tankTex.turret('own', tier, marks, look), TURRET_SIZE.w, TURRET_SIZE.h, (ctx) => {
          ctx.translate(TURRET_PIVOT.x, TURRET_PIVOT.y);
          TURRET_SETS[look][tier](ctx, marks);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        });
        variant(tankTex.turret('bot', tier, marks, look), own, (ctx, w, h) => recolor(ctx, w, h, 'red', isClassicLook(look)));
        variant(tankTex.turret('rival', tier, marks, look), own, (ctx, w, h) => recolor(ctx, w, h, 'blue', isClassicLook(look)));
        if (marks === 0) {
          variant(tankTex.wreckTurret(tier, look), own, char);
          for (let stage = 1; stage <= DAMAGE_STAGES; stage++) {
            canvasTexture(scene, tankTex.damageTurret(tier, stage, look), TURRET_SIZE.w, TURRET_SIZE.h, (ctx) => {
              drawDamage(ctx, stage, 503 + tier * 29 + look * 11, TURRET_PIVOT.x + 8, TURRET_PIVOT.y, 26, 9 + tier * 1.2);
              ctx.globalCompositeOperation = 'destination-in';
              ctx.drawImage(own, 0, 0);
              ctx.globalCompositeOperation = 'source-over';
            });
          }
        }
      }
    }
  }
}

/**
 * A tank rajza önálló vásznakra, a játékjelenettől függetlenül (a menü
 * díszítéséhez): a test három lánctalp-képkockája és a torony.
 */
export function tankSprites(tier: number, paint: TankPaint, marks = 0, look = 0): { hull: HTMLCanvasElement[]; turret: HTMLCanvasElement } {
  const make = (w: number, h: number, draw: (ctx: Ctx) => void): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    draw(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (paint !== 'own') recolor(ctx, w, h, paint === 'bot' ? 'red' : 'blue', isClassicLook(look));
    return canvas;
  };
  const hull = Array.from({ length: TRACK_FRAMES }, (_, frame) =>
    make(HULL_SIZE.w, HULL_SIZE.h, (ctx) => {
      ctx.translate((HULL_SIZE.w - BODY.w) / 2, (HULL_SIZE.h - BODY.h) / 2);
      HULL_SETS[look][tier](ctx, frame);
    }),
  );
  const turret = make(TURRET_SIZE.w, TURRET_SIZE.h, (ctx) => {
    ctx.translate(TURRET_PIVOT.x, TURRET_PIVOT.y);
    TURRET_SETS[look][tier](ctx, marks);
  });
  return { hull, turret };
}
