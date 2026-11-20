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

export const TANK_TIERS = 6;
export const TRACK_FRAMES = 3;
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

export const tankTex = {
  hull: (paint: TankPaint, tier: number, frame: number): string => `tank-${paint}-hull-${tier}-${frame}`,
  turret: (paint: TankPaint, tier: number): string => `tank-${paint}-turret-${tier}`,
  wreckHull: (tier: number): string => `wreck-hull-${tier}`,
  wreckTurret: (tier: number): string => `wreck-turret-${tier}`,
} as const;

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

function turret0(ctx: Ctx): void {
  barrel(ctx, 8, 36, 6);
  muzzle(ctx, 9, 9);
  poly(ctx, [-10, -8, 5, -10, 11, -5, 11, 5, 5, 10, -10, 8, -13, 0], '#5c9448', '#14240f', 2.2);
  poly(ctx, [-9, -6.5, 4.5, -8.5, 8, -5.5, -8, -3.5], '#86be6a');
  poly(ctx, [-9, 6.5, 4.5, 8.5, 8, 5.5, -8, 3.5], '#3e7036');
  hatch(ctx, -3, 0.5, 4.2);
}

function turret1(ctx: Ctx): void {
  barrel(ctx, 9, 34, 7.4);
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

function turret2(ctx: Ctx): void {
  barrel(ctx, 12, 30, 8.6);
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

function turret3(ctx: Ctx): void {
  // párhuzamos gépágyú a főlöveg mellett
  box(ctx, 9, 6.6, 25, 3.2, 1, GUN, '#0a0a0c', 1);
  barrel(ctx, 12, 29, 8.8);
  // hővédő köpeny acél bilincsekkel
  ctx.fillStyle = STEEL;
  for (const x of [18.5, 26.5]) ctx.fillRect(x, -5.2, 2.4, 10.4);
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

function turret4(ctx: Ctx): void {
  // ikerlöveg
  for (const y of [-5.2, 5.2]) {
    barrel(ctx, 12, 30, 6.6, y, '#34502f', '#557a4a');
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

function turret5(ctx: Ctx): void {
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
  // arany csillag hátul
  const star: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 3.6 : 1.5;
    star.push(-14.5 + Math.cos(a) * r, Math.sin(a) * r);
  }
  poly(ctx, star, GOLD, GOLD_D, 0.8);
}

const TURRETS = [turret0, turret1, turret2, turret3, turret4, turret5];

// --- textúrák ---------------------------------------------------------------------

function canvasTexture(scene: Phaser.Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void): HTMLCanvasElement {
  const tex = scene.textures.createCanvas(key, w, h)!;
  draw(tex.context);
  tex.refresh();
  return tex.canvas;
}

/** A zöld árnyalatok átszínezése vörösre (botok) vagy kékre (más játékosok); az acél, az arany és a fények maradnak. */
function recolor(ctx: Ctx, w: number, h: number, hue: 'red' | 'blue'): void {
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    if (g > r * 1.08 && g > b) {
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

export function createTankTextures(scene: Phaser.Scene): void {
  const ox = (HULL_SIZE.w - BODY.w) / 2;
  const oy = (HULL_SIZE.h - BODY.h) / 2;
  const variant = (key: string, source: HTMLCanvasElement, change: (ctx: Ctx, w: number, h: number) => void): void => {
    canvasTexture(scene, key, source.width, source.height, (ctx) => {
      ctx.drawImage(source, 0, 0);
      change(ctx, source.width, source.height);
    });
  };
  for (let tier = 0; tier < TANK_TIERS; tier++) {
    for (let frame = 0; frame < TRACK_FRAMES; frame++) {
      const own = canvasTexture(scene, tankTex.hull('own', tier, frame), HULL_SIZE.w, HULL_SIZE.h, (ctx) => {
        ctx.translate(ox, oy);
        HULLS[tier](ctx, frame);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      });
      variant(tankTex.hull('bot', tier, frame), own, (ctx, w, h) => recolor(ctx, w, h, 'red'));
      variant(tankTex.hull('rival', tier, frame), own, (ctx, w, h) => recolor(ctx, w, h, 'blue'));
      if (frame === 0) variant(tankTex.wreckHull(tier), own, char);
    }
    const own = canvasTexture(scene, tankTex.turret('own', tier), TURRET_SIZE.w, TURRET_SIZE.h, (ctx) => {
      ctx.translate(TURRET_PIVOT.x, TURRET_PIVOT.y);
      TURRETS[tier](ctx);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    });
    variant(tankTex.turret('bot', tier), own, (ctx, w, h) => recolor(ctx, w, h, 'red'));
    variant(tankTex.turret('rival', tier), own, (ctx, w, h) => recolor(ctx, w, h, 'blue'));
    variant(tankTex.wreckTurret(tier), own, char);
  }
}
