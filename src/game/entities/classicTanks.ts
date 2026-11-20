// A három klasszikus, II. világháborús alaptank kódból rajzolt képe (felülnézet, a tank
// jobbra néz): T-34, Tigris, Sherman. Mindegyik korhű festést kap, és az osztályokkal a
// valódi típusfejlődést követi (T-34/76 → T-34-85, Tiger I → Királytigris, M4 → Firefly).
//
// A csapat jelölése: a modern tankokat a játék egészében átszínezi (zöld/vörös/kék), a
// klasszikusak viszont megtartják a korhű színüket – náluk csak a légi azonosító lap (a
// motortéren és a torony tetején) vált színt. Ezt a lapot MARK színnel kell rajzolni:
// az átszínezés csak ezt az erős, telített zöldet keresi (a festés tompa zöldjeit nem).
//
// A koordináták a tankTextures.ts-ével egyeznek: a test 68 × 42 pixeles alapmérete köré
// rajzolunk (12 pixel/méter), a torony forgáspontja a (34, 21) pont; a torony rajza a
// forgáspontból indul, a cső a +x irányba néz.

type Ctx = CanvasRenderingContext2D;

/** a légi azonosító lap színe (a saját tanké); az átszínezés ezt cseréli vörösre/kékre */
export const MARK = '#36d65a';
const MARK_EDGE = '#1a1a16';

// --- alapformák ---------------------------------------------------------------------

function path(ctx: Ctx, pts: number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
}

function poly(ctx: Ctx, pts: number[], fill: string | CanvasGradient | null, stroke?: string, lineWidth = 1.2): void {
  path(ctx, pts);
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

function box(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient, stroke?: string, lineWidth = 1): void {
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

function disc(ctx: Ctx, x: number, y: number, r: number, fill: string | CanvasGradient, stroke?: string, lineWidth = 1): void {
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

function line(ctx: Ctx, pts: number[], color: string, width: number): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';
}

/** Festék felülnézetben: a fény északnyugatról jön, a felső oldal világosabb, az alsó sötétebb. */
interface Paint {
  light: string;
  base: string;
  dark: string;
  edge: string;
}
function shade(ctx: Ctx, y0: number, y1: number, p: Paint): CanvasGradient {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, p.light);
  g.addColorStop(0.45, p.base);
  g.addColorStop(1, p.dark);
  return g;
}

/** Terepminta-foltok egy alakzaton belül (a vágóútvonalat a `clip` rajzolja). */
function camo(ctx: Ctx, clip: () => void, spots: number[], color: string): void {
  ctx.save();
  clip();
  ctx.clip();
  ctx.fillStyle = color;
  for (let i = 0; i + 4 < spots.length + 1; i += 5) {
    ctx.beginPath();
    ctx.ellipse(spots[i], spots[i + 1], spots[i + 2], spots[i + 3], spots[i + 4], 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Lánctalp felülről: keresztirányú láncszemek, középen vezetőfogak; a képkockával haladnak. */
function tread(ctx: Ctx, frame: number, x: number, y: number, w: number, h: number, pitch = 3.6, guides = true): void {
  box(ctx, x, y, w, h, 1.6, '#24231f', '#0b0b0a', 1.2);
  const shift = (frame * pitch) / 3;
  for (let lx = x + 0.8 + shift; lx < x + w - 1; lx += pitch) {
    ctx.fillStyle = '#4a4740';
    ctx.fillRect(lx, y + 0.9, pitch * 0.55, h - 1.8);
    ctx.fillStyle = '#16150f';
    ctx.fillRect(lx + pitch * 0.55, y + 0.9, 0.5, h - 1.8);
  }
  if (guides) {
    ctx.fillStyle = '#6b675c';
    for (let lx = x + 1.5 + shift; lx < x + w - 2; lx += pitch * 2) ctx.fillRect(lx, y + h / 2 - 0.7, 1.4, 1.4);
  }
}

/** Kerek búvónyílás zsanérral és fogantyúval. */
function hatch(ctx: Ctx, x: number, y: number, r: number, p: Paint, hinge = -1): void {
  disc(ctx, x + 0.5, y + 0.6, r, 'rgba(0,0,0,0.35)');
  const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, 0, x, y, r);
  g.addColorStop(0, p.light);
  g.addColorStop(1, p.dark);
  disc(ctx, x, y, r, g, p.edge, 0.9);
  box(ctx, x + hinge * r - 1, y - 1.6, 2, 3.2, 0.5, p.dark, p.edge, 0.6);
  line(ctx, [x - r * 0.35, y + r * 0.35, x + r * 0.35, y + r * 0.35], p.edge, 0.7);
}

/** Szellőzőrács lamellákkal. */
function louvres(ctx: Ctx, x: number, y: number, w: number, h: number, p: Paint, vertical = true, step = 1.7): void {
  box(ctx, x, y, w, h, 0.8, p.dark, p.edge, 0.9);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  if (vertical) for (let sx = x + 1.2; sx < x + w - 0.8; sx += step) ctx.fillRect(sx, y + 1, step * 0.45, h - 2);
  else for (let sy = y + 1.2; sy < y + h - 0.8; sy += step) ctx.fillRect(x + 1, sy, w - 2, step * 0.45);
}

/** Kerek ventilátorrács (hálóval). */
function fanGrille(ctx: Ctx, x: number, y: number, r: number, p: Paint): void {
  disc(ctx, x, y, r, '#1c1c18', p.edge, 1);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r - 0.6, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = 'rgba(150,150,140,0.55)';
  ctx.lineWidth = 0.5;
  for (let d = -r; d <= r; d += 1.3) {
    ctx.beginPath();
    ctx.moveTo(x + d, y - r);
    ctx.lineTo(x + d, y + r);
    ctx.moveTo(x - r, y + d);
    ctx.lineTo(x + r, y + d);
    ctx.stroke();
  }
  ctx.restore();
  disc(ctx, x, y, r * 0.3, p.dark, p.edge, 0.6);
}

/** Vontatókötél: hullámos szürke vonal. */
function cable(ctx: Ctx, x0: number, x1: number, y: number): void {
  ctx.beginPath();
  for (let x = x0; x <= x1; x += 1) ctx.lineTo(x, y + Math.sin(x * 1.3) * 0.45);
  ctx.strokeStyle = '#2b2a26';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.beginPath();
  for (let x = x0; x <= x1; x += 1) ctx.lineTo(x, y - 0.3 + Math.sin(x * 1.3) * 0.45);
  ctx.strokeStyle = '#8a8679';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  disc(ctx, x0, y, 1.1, '#3a3832');
  disc(ctx, x1, y, 1.1, '#3a3832');
}

/** Ásó (nyél + lap). */
function shovel(ctx: Ctx, x: number, y: number, len: number): void {
  line(ctx, [x, y, x + len, y], '#7a5a32', 1.1);
  box(ctx, x + len - 0.4, y - 1.4, 3.4, 2.8, 0.8, '#55544e', '#1d1c19', 0.5);
}

/** Pót lánctalpszemek (egymás mellett, keresztben). */
function spareLinks(ctx: Ctx, x: number, y: number, count: number, w = 2.2, h = 6, vertical = true): void {
  for (let i = 0; i < count; i++) {
    const bx = vertical ? x + i * (w + 0.4) : x;
    const by = vertical ? y : y + i * (h + 0.4);
    box(ctx, bx, by, vertical ? w : h, vertical ? h : w, 0.4, '#3b3933', '#121210', 0.5);
    ctx.fillStyle = '#5c5a52';
    if (vertical) ctx.fillRect(bx + 0.5, by + h / 2 - 0.4, w - 1, 0.8);
    else ctx.fillRect(bx + h / 2 - 0.4, by + 0.5, 0.8, w - 1);
  }
}

/** A légi azonosító lap (csapatszín): kifeszített ponyva, a sarkain kötéssel. */
function recognition(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  box(ctx, x + 0.5, y + 0.6, w, h, 0.6, 'rgba(0,0,0,0.3)');
  box(ctx, x, y, w, h, 0.6, MARK, MARK_EDGE, 0.8);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x + 1, y + 1, w - 2, 1.1);
  for (const [cx, cy] of [
    [x + 0.9, y + 0.9],
    [x + w - 0.9, y + 0.9],
    [x + 0.9, y + h - 0.9],
    [x + w - 0.9, y + h - 0.9],
  ]) disc(ctx, cx, cy, 0.55, MARK_EDGE);
}

/** Ágyúcső hossz mentén árnyalva; `rings`: fehér kilövésgyűrűk a cső végén (a szintlépések jele). */
function gun(ctx: Ctx, x0: number, x1: number, w: number, p: Paint, rings = 0, taper = 0.85): void {
  const g = ctx.createLinearGradient(0, -w / 2, 0, w / 2);
  g.addColorStop(0, p.light);
  g.addColorStop(0.5, p.base);
  g.addColorStop(1, p.dark);
  poly(ctx, [x0, -w / 2, x1, (-w / 2) * taper, x1, (w / 2) * taper, x0, w / 2], g, p.edge, 0.9);
  for (let i = 0; i < rings; i++) {
    const rx = x1 - 6 - i * 2.1;
    ctx.fillStyle = '#f2efe4';
    ctx.fillRect(rx, (-w / 2) * 0.92, 1.1, w * 0.92);
  }
}

/** Kétkamrás csőszájfék (német 8,8-as, amerikai 76-os). */
function muzzleBrake(ctx: Ctx, x: number, w: number, h: number, p: Paint): void {
  box(ctx, x, -h / 2, w, h, 0.8, p.base, p.edge, 0.9);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x + w * 0.28, -h / 2 + 0.6, w * 0.16, h - 1.2);
  ctx.fillRect(x + w * 0.62, -h / 2 + 0.6, w * 0.16, h - 1.2);
}

/**
 * A rajz a test közepe körül megnő a fokozattal (mint a többi alaptanknál). A klasszikus
 * tankok hosszabbak a modern alapformánál, ezért egy kicsit kisebb léptékkel rajzolódnak,
 * hogy a legnagyobb fokozat is elférjen a vásznon.
 */
function grown(ctx: Ctx, tier: number, draw: () => void): void {
  const k = (1 + tier * 0.044) * 0.9;
  ctx.save();
  ctx.translate(34, 21);
  ctx.scale(k, k);
  ctx.translate(-34, -21);
  draw();
  ctx.restore();
}
/** A torony teste is nő (a cső hossza nem: a lövedék mindig ugyanonnan indul). */
function grownTurret(ctx: Ctx, tier: number, draw: () => void): void {
  const k = 1 + tier * 0.04;
  ctx.save();
  ctx.scale(k, k);
  draw();
  ctx.restore();
}

/** Árnyék a test alatt (a földre vetül, délkeletre). */
function dropShadow(ctx: Ctx, pts: number[]): void {
  ctx.save();
  ctx.translate(1.2, 1.4);
  poly(ctx, pts, 'rgba(0,0,0,0.28)');
  ctx.restore();
}

// --- T-34 ---------------------------------------------------------------------------
// 4BO szovjet védőzöld. Fejlődés: T-34/76 (1940, hengerelt torony, egy nagy búvónyílás) →
// 1942-es (öntött torony, hengeres póttartályok hátul) → „hatszög” torony két kerek
// búvónyílással és parancsnoki kupolával → T-34-85 (nagy öntött torony, hosszú 85 mm-es
// ágyú) → rácspáncél („ágyrugó”) a páncéltörő gránátok ellen → T-34-100 (100 mm, csőszájfék).

const T34: Paint = { light: '#7a8a48', base: '#5d6c35', dark: '#3c4723', edge: '#1b2010' };
const T34_TIER_NAMES = ['T-34/76 (1940)', 'T-34/76 (1942)', 'T-34/76 „hatszög”', 'T-34-85', 'T-34-85 rácspáncéllal', 'T-34-100'] as const;

function hullT34(ctx: Ctx, frame: number, tier: number): void {
  grown(ctx, tier, () => {
    const outline = [-5, 2, 53, 2, 66, 4.6, 66, 37.4, 53, 40, -5, 40, -7, 37, -7, 5];
    dropShadow(ctx, [-8, 0, 69, 0, 69, 42, -8, 42]);
    // széles (500 mm-es) lánctalpak: elöl és hátul kilátszanak a test alól
    tread(ctx, frame, -9, -0.6, 78, 9.6, 3.4);
    tread(ctx, frame, -9, 33, 78, 9.6, 3.4);
    poly(ctx, outline, shade(ctx, 2, 40, T34), T34.edge, 1.6);
    // a felépítmény széle (a lánctalp fölötti sárvédőpolc és a tetőlemez határa)
    line(ctx, [-4, 7, 52, 7], 'rgba(0,0,0,0.35)', 0.8);
    line(ctx, [-4, 35, 52, 35], 'rgba(0,0,0,0.35)', 0.8);
    line(ctx, [-4, 6.4, 52, 6.4], 'rgba(255,255,255,0.12)', 0.6);
    // ferde homloklemez (felülről rövidülve látszik), rajta a vezető búvónyílása és a géppuska
    poly(ctx, [53, 2.6, 65.4, 5, 65.4, 37, 53, 39.4], shade(ctx, 2, 40, { ...T34, light: '#8a9a56', base: '#6c7b40' }), T34.edge, 0.9);
    box(ctx, 56.4, 9, 6.6, 10, 1, T34.dark, T34.edge, 0.9);
    ctx.fillStyle = '#10140a';
    ctx.fillRect(61.6, 10.6, 0.9, 2.6);
    ctx.fillRect(61.6, 14.8, 0.9, 2.6);
    disc(ctx, 59.5, 30, 2.3, T34.dark, T34.edge, 0.9);
    disc(ctx, 60.6, 30, 0.9, '#0c0e08');
    // fényszóró a bal első sarkon, vonóhorgok
    disc(ctx, 63.2, 6.8, 1.2, '#d8d4b8', T34.edge, 0.6);
    for (const y of [3.4, 38.6]) box(ctx, 64.6, y - 1, 2.6, 2, 0.6, '#2a2c22', '#0e0f0a', 0.5);
    // motortér: hosszanti szellőzőrács, középen a motor fedele, hátul a nagy kerek sebességváltó-nyílás
    louvres(ctx, -3, 9.6, 13, 22.8, T34, true, 1.6);
    box(ctx, 11, 12.6, 9, 16.8, 1, T34.base, T34.edge, 0.9);
    for (const y of [14.4, 27.6]) disc(ctx, 15.5, y, 0.7, '#2a3018');
    ctx.save();
    ctx.beginPath();
    ctx.rect(-8, 0, 3.4, 42);
    ctx.clip();
    disc(ctx, -5.6, 21, 6.2, T34.dark, T34.edge, 0.9);
    ctx.restore();
    // kipufogók a hátsó lemezen
    for (const y of [11.6, 30.4]) box(ctx, -8.2, y - 1.4, 2.2, 2.8, 0.8, '#2b241c', '#0c0a08', 0.6);
    // vontatókötél és szerszámok a sárvédőn
    cable(ctx, 22, 48, 3.9);
    shovel(ctx, 24, 38.2, 12);
    // hengeres póttartályok a hátsó oldalakon (1942-től)
    if (tier >= 1) {
      for (const y of [-0.4, 37.8]) {
        for (const x of [-4, 8.4]) {
          const g = ctx.createLinearGradient(0, y, 0, y + 4.6);
          g.addColorStop(0, '#8a9a56');
          g.addColorStop(1, '#3c4723');
          box(ctx, x, y, 11.4, 4.6, 2.3, g, T34.edge, 0.8);
          line(ctx, [x + 3.2, y + 0.3, x + 3.2, y + 4.3], 'rgba(0,0,0,0.5)', 0.6);
          line(ctx, [x + 8.2, y + 0.3, x + 8.2, y + 4.3], 'rgba(0,0,0,0.5)', 0.6);
        }
      }
    }
    // pót lánctalpszemek a homloklemezen (a hatszög-tornyos változattól)
    if (tier >= 2) spareLinks(ctx, 56.6, 22.4, 3, 2.1, 5.2);
    // összegöngyölt ponyva a motortér előtt (T-34-85)
    if (tier >= 3) {
      const g = ctx.createLinearGradient(20.6, 0, 24.4, 0);
      g.addColorStop(0, '#7a7258');
      g.addColorStop(1, '#4a4432');
      box(ctx, 20.6, 8.4, 3.8, 25.2, 1.8, g, '#1e1c14', 0.8);
      for (const y of [12, 21, 30]) line(ctx, [20.6, y, 24.4, y], '#2a2418', 0.6);
    }
    // rácspáncél („ágyrugó”) a sárvédők fölött
    if (tier >= 4) {
      for (const y of [-2.2, 39]) {
        ctx.strokeStyle = 'rgba(40,40,34,0.9)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(14, y, 40, 5.2);
        for (let x = 14; x <= 54; x += 1.6) line(ctx, [x, y, x, y + 5.2], 'rgba(40,40,34,0.75)', 0.35);
        line(ctx, [14, y + 2.6, 54, y + 2.6], 'rgba(40,40,34,0.75)', 0.35);
      }
    }
    // légi azonosító lap a motortéren
    recognition(ctx, 0, 16.2, 7.6, 9.6);
    // a torony helye
    disc(ctx, 34, 21, 11.6, T34.dark, T34.edge, 1);
  });
}

function turretT34(ctx: Ctx, marks: number, tier: number): void {
  const p = T34;
  const rings = Math.min(4, marks);
  // a cső (a toronnyal együtt nem nő)
  if (tier >= 5) {
    gun(ctx, 12, 48, 4.4, p, rings, 0.9);
    muzzleBrake(ctx, 47, 6, 6, p);
  } else if (tier >= 3) gun(ctx, 12, 52, 3.8, p, rings, 0.88);
  else gun(ctx, 11, 41 + tier, 3.4, p, rings, 0.85);
  grownTurret(ctx, tier, () => {
    let body: number[];
    if (tier <= 1) {
      // hengerelt (1940), illetve öntött (1942) torony: elöl keskeny, hátrafelé szélesedik
      body = tier === 0 ? [-14, -9.4, 5, -10.4, 10.6, -6.6, 10.6, 6.6, 5, 10.4, -14, 9.4, -16.8, 5.4, -16.8, -5.4] : [-14.5, -9.8, 4, -10.8, 9.6, -7.8, 11.2, -3, 11.2, 3, 9.6, 7.8, 4, 10.8, -14.5, 9.8, -17.4, 4.8, -17.4, -4.8];
    } else if (tier === 2) {
      // „hatszög” torony
      body = [-13, -10.8, 4.4, -11.4, 11.2, -6.2, 11.2, 6.2, 4.4, 11.4, -13, 10.8, -17, 0];
    } else {
      // T-34-85: nagy, hosszúkás öntött torony
      body = [-18.5, -10.6, 1.6, -12.2, 10, -9.4, 13.2, -5, 13.2, 5, 10, 9.4, 1.6, 12.2, -18.5, 10.6, -21, 6, -21, -6];
    }
    dropShadow(ctx, body);
    poly(ctx, body, shade(ctx, -12, 12, p), p.edge, 1.4);
    // ágyúpajzs
    const front = tier >= 3 ? 12.6 : tier === 2 ? 10.6 : 10;
    box(ctx, front - 1.6, -4.6, 5.2, 9.2, 1.6, shade(ctx, -4.6, 4.6, p), p.edge, 0.9);
    if (tier === 0) {
      // egyetlen nagy búvónyílás a torony hátsó részén
      box(ctx, -13.4, -6.4, 12.4, 12.8, 1.4, shade(ctx, -6.4, 6.4, p), p.edge, 0.9);
      box(ctx, -2.6, -2, 1.8, 4, 0.5, p.dark, p.edge, 0.5);
      disc(ctx, 3, -5.2, 1.4, '#14180c');
    } else if (tier === 1) {
      box(ctx, -14, -6.8, 12.8, 13.6, 2.2, shade(ctx, -6.8, 6.8, p), p.edge, 0.9);
      disc(ctx, 3.4, -5.4, 1.4, '#14180c');
      disc(ctx, 3.4, 5.4, 1.4, '#14180c');
    } else if (tier === 2) {
      // két kerek búvónyílás („Miki egér fülek”) és parancsnoki kupola
      hatch(ctx, -6.4, 5.2, 3.6, p, -1);
      ctx.save();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        box(ctx, -7.4 + Math.cos(a) * 4.6 - 0.7, -5.2 + Math.sin(a) * 4.6 - 0.7, 1.4, 1.4, 0.3, '#14180c');
      }
      ctx.restore();
      hatch(ctx, -7.4, -5.2, 4.2, p, -1);
    } else {
      // parancsnoki kupola hátul balra (figyelőrésekkel), töltőkezelő búvónyílás jobbra, két szellőzőkupola
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        box(ctx, -11.6 + Math.cos(a) * 5.4 - 0.7, -5.6 + Math.sin(a) * 5.4 - 0.7, 1.4, 1.4, 0.3, '#14180c');
      }
      hatch(ctx, -11.6, -5.6, 4.8, p, -1);
      hatch(ctx, -8.4, 6.2, 3.4, p, -1);
      disc(ctx, -16.6, -1.6, 1.6, p.light, p.edge, 0.6);
      disc(ctx, -16.6, 2.6, 1.6, p.light, p.edge, 0.6);
      disc(ctx, 4.8, -6.6, 1.2, '#14180c');
    }
    // rácspáncél a torony körül
    if (tier >= 4) {
      ctx.strokeStyle = 'rgba(40,40,34,0.9)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.roundRect(-23.4, -14.2, 34, 28.4, 4);
      ctx.stroke();
      for (let x = -22; x <= 9; x += 1.8) {
        line(ctx, [x, -14.2, x, -12.4], 'rgba(40,40,34,0.85)', 0.35);
        line(ctx, [x, 12.4, x, 14.2], 'rgba(40,40,34,0.85)', 0.35);
      }
    }
    // kézi kapaszkodók a torony oldalán
    line(ctx, [-10, -10.6, -2, -11.2], p.edge, 0.7);
    line(ctx, [-10, 10.6, -2, 11.2], p.edge, 0.7);
    // azonosító lap a torony tetején
    recognition(ctx, tier >= 3 ? -18 : -13.4, tier >= 2 ? -2.2 : 7.6, tier >= 3 ? 4.4 : 9, tier >= 2 ? 4.4 : 2.6);
  });
}

// --- Tigris ---------------------------------------------------------------------------
// Sötétsárga (Dunkelgelb) alap, olívzöld és vörösbarna terepfoltokkal. Fejlődés: Tiger I
// korai (Feifel-légszűrők, ködgránátvetők) → Zimmerit-bevonattal, pótláncszemekkel → késői
// (öntött parancsnoki kupola) → Királytigris Porsche-toronnyal → Henschel-toronnyal →
// 10,5 cm-es ágyúval, „rejtőzködő” (pöttyös) terepmintával.

const TIGER: Paint = { light: '#d8bd7c', base: '#bf9f5c', dark: '#8a6e3a', edge: '#2c2416' };
const TIGER_OLIVE = 'rgba(86,100,52,0.92)';
const TIGER_BROWN = 'rgba(122,62,36,0.9)';
const TIGER_TIER_NAMES = ['Tiger I (korai)', 'Tiger I Zimmerittel', 'Tiger I (késői)', 'Királytigris (Porsche)', 'Királytigris (Henschel)', 'Királytigris 10,5 cm'] as const;

/** Zimmerit: a mágneses aknák ellen felhordott, bordázott bevonat. */
function zimmerit(ctx: Ctx, clip: () => void, x0: number, x1: number, y0: number, y1: number): void {
  ctx.save();
  clip();
  ctx.clip();
  ctx.strokeStyle = 'rgba(60,44,20,0.32)';
  ctx.lineWidth = 0.55;
  for (let x = x0; x < x1; x += 1.25) {
    ctx.beginPath();
    ctx.moveTo(x, y0);
    for (let y = y0; y < y1; y += 2.4) ctx.lineTo(x + ((y / 2.4) % 2 === 0 ? 0.35 : -0.35), y);
    ctx.stroke();
  }
  ctx.restore();
}

function tigerCamo(ctx: Ctx, clip: () => void, tier: number, seed: number): void {
  // foltok (x, y, rx, ry, szög) – a test és a torony saját mintát kap
  const s = seed;
  const olive = [6 + s, 6, 9, 3.2, 0.4, 26 + s, 34, 10, 3, -0.3, 44 - s, 9, 7, 2.6, 0.7, 16, 22, 5, 2.2, 1.2, 54, 27, 6, 2.4, -0.5, -2, 30, 6, 2.6, 0.2];
  const brown = [18 - s, 11, 7, 2.2, -0.6, 38, 22, 6.5, 2.2, 0.5, 8, 35, 6, 2, 0.1, 50 + s, 35, 6, 2, -0.2, 30, 5, 5, 1.8, 0.2];
  if (tier === 0) {
    // a korai gépek gyakran egyszínűek voltak, legfeljebb néhány folttal
    camo(ctx, clip, olive.slice(0, 10), TIGER_OLIVE);
    return;
  }
  camo(ctx, clip, olive, TIGER_OLIVE);
  camo(ctx, clip, brown, TIGER_BROWN);
  if (tier >= 5) {
    // „Hinterhalt” (rejtőzködő) minta: sárga pöttyök a sötét foltokon, sötétek a sárgán
    const dots: number[] = [];
    for (let i = 0; i < 26; i++) dots.push(-4 + ((i * 37) % 70), 3 + ((i * 23) % 36), 0.9, 0.9, 0);
    camo(ctx, clip, dots, 'rgba(216,189,124,0.9)');
  }
}

function hullTiger(ctx: Ctx, frame: number, tier: number): void {
  grown(ctx, tier, () => {
    const king = tier >= 3;
    // Tiger I: dobozszerű felépítmény, amely a lánctalpak fölé nyúlik; elöl rövid orrlemez.
    // Királytigris: hosszú, ferde homloklemez, oldalt végig láncvédő kötény.
    const outline = king ? [-4, 1.6, 49, 1.6, 66, 6.4, 66, 35.6, 49, 40.4, -4, 40.4, -6, 38, -6, 4] : [-3, 1.2, 58, 1.2, 58, 40.8, -3, 40.8, -5, 38.6, -5, 3.4];
    const nose = king ? null : [58, 8.6, 66, 10, 66, 32, 58, 33.4];
    dropShadow(ctx, [-7, -1, 69, -1, 69, 43, -7, 43]);
    // széles (725 mm-es) harci lánctalp, elöl a hajtókerékkel kilátszik
    tread(ctx, frame, -7, -1.4, 75, 11, 3.2);
    tread(ctx, frame, -7, 32.4, 75, 11, 3.2);
    const clip = (): void => {
      path(ctx, outline);
      if (nose) {
        ctx.moveTo(nose[0], nose[1]);
        for (let i = 2; i < nose.length; i += 2) ctx.lineTo(nose[i], nose[i + 1]);
        ctx.closePath();
      }
    };
    if (nose) poly(ctx, nose, shade(ctx, 8, 34, { ...TIGER, light: '#e2c88a' }), TIGER.edge, 1);
    poly(ctx, outline, shade(ctx, 1, 41, TIGER), TIGER.edge, 1.6);
    if (king) poly(ctx, [49, 2.2, 65.4, 6.8, 65.4, 35.2, 49, 39.8], shade(ctx, 2, 40, { ...TIGER, light: '#e6cc90', base: '#c9aa66' }), TIGER.edge, 0.9);
    tigerCamo(ctx, clip, tier, 0);
    if (tier === 1 || tier === 2) zimmerit(ctx, clip, -5, 67, 0, 42);
    // első sárvédők a lánctalp fölött (Tiger I)
    if (!king) for (const y of [-1.8, 32.6]) box(ctx, 58.4, y, 8.4, 11.2, 0.8, shade(ctx, y, y + 11.2, TIGER), TIGER.edge, 0.8);
    // oldalsó láncvédő kötény (Királytigris)
    if (king) for (const y of [-1.8, 39.2]) for (let i = 0; i < 6; i++) box(ctx, -3 + i * 9, y, 8.8, 4.6, 0.4, shade(ctx, y, y + 4.6, TIGER), TIGER.edge, 0.6);
    // vezető és rádiós búvónyílása, a vezető figyelőnyílása, a géppuska gömbcsuklója
    const hx = king ? 45 : 50.4;
    hatch(ctx, hx, 10.6, 3.8, TIGER, -1);
    hatch(ctx, hx, 31.4, 3.8, TIGER, -1);
    if (king) {
      box(ctx, 54, 9, 3.4, 5, 0.6, '#1e1a10', TIGER.edge, 0.5);
      disc(ctx, 58, 30.4, 2.2, TIGER.dark, TIGER.edge, 0.8);
    } else {
      box(ctx, 56.4, 9.4, 2.6, 7.2, 0.6, '#1e1a10', TIGER.edge, 0.5);
      disc(ctx, 57.8, 29.6, 2.3, TIGER.dark, TIGER.edge, 0.8);
    }
    // motortér: két kerek ventilátorrács oldalanként, középen a motor fedele, mellette a hűtők rácsai
    box(ctx, 3, 13, 13, 16, 1, shade(ctx, 13, 29, TIGER), TIGER.edge, 0.9);
    for (const [x, y] of [[4.6, 14.4], [14.4, 14.4], [4.6, 27.6], [14.4, 27.6]]) disc(ctx, x, y, 0.6, '#3a2e18');
    if (king) {
      for (const y of [5.8, 36.2]) fanGrille(ctx, 9.4, y, 3.8, TIGER);
      louvres(ctx, -3.6, 3, 6, 10, TIGER, false, 1.5);
      louvres(ctx, -3.6, 29, 6, 10, TIGER, false, 1.5);
    } else {
      for (const y of [6.4, 35.6]) for (const x of [1.6, 11.4]) fanGrille(ctx, x, y, 3.6, TIGER);
      louvres(ctx, 17.6, 3, 5, 8.6, TIGER, false, 1.4);
      louvres(ctx, 17.6, 30.4, 5, 8.6, TIGER, false, 1.4);
    }
    // kipufogók a hátsó lemezen (lemezburkolattal), korai gépen Feifel-légszűrők
    for (const y of [12.6, 29.4]) box(ctx, -8.4, y - 2, 4, 4, 1, '#3a3026', '#100c08', 0.7);
    if (tier === 0) for (const y of [4.6, 37.4]) box(ctx, -9.4, y - 2.6, 4.4, 5.2, 2.2, shade(ctx, y - 2.6, y + 2.6, TIGER), TIGER.edge, 0.7);
    // vontatókötelek és szerszámok az oldalakon
    cable(ctx, 22, 54, 3.4);
    cable(ctx, 22, 54, 38.6);
    shovel(ctx, 26, 6.4, 10);
    // pót lánctalpszemek az orrlemezen (Tiger I késői)
    if (tier === 2) spareLinks(ctx, 59.6, 12.4, 2, 2.6, 7, false);
    // légi azonosító lap: kifeszítve a motortéren
    recognition(ctx, 5.6, 17.2, 7.8, 7.6);
    disc(ctx, 34, 21, 12.4, TIGER.dark, TIGER.edge, 1);
  });
}

function turretTiger(ctx: Ctx, marks: number, tier: number): void {
  const p = TIGER;
  const rings = Math.min(4, marks);
  const king = tier >= 3;
  // 8,8 cm KwK 36 L/56 (Tiger I), KwK 43 L/71 (Királytigris), 10,5 cm (a legfelső fokozat)
  if (tier >= 5) {
    gun(ctx, 14, 50, 4.6, p, rings, 0.88);
    muzzleBrake(ctx, 49.4, 6.4, 6.8, p);
  } else if (king) {
    gun(ctx, 14, 51, 3.6, p, rings, 0.86);
    muzzleBrake(ctx, 50.4, 5.6, 5.4, p);
  } else {
    gun(ctx, 15, 46, 3.6, p, rings, 0.86);
    muzzleBrake(ctx, 45.6, 5.6, 5.6, p);
  }
  grownTurret(ctx, tier, () => {
    let clip: () => void;
    if (!king) {
      // patkó alakú torony: elöl egyenes homlok a széles ágyúpajzzsal, hátul ívben körbeér
      clip = (): void => {
        ctx.beginPath();
        ctx.moveTo(10.4, -12.4);
        ctx.lineTo(10.4, 12.4);
        ctx.lineTo(-4, 12.9);
        ctx.ellipse(-4, 0, 14.6, 12.9, 0, Math.PI / 2, (Math.PI * 3) / 2);
        ctx.closePath();
      };
    } else if (tier === 3) {
      // Porsche-torony: elöl lekerekített, ívelt homlok
      clip = (): void => {
        ctx.beginPath();
        ctx.moveTo(-20, -10.4);
        ctx.lineTo(2, -11.6);
        ctx.quadraticCurveTo(13.6, -10.4, 13.6, 0);
        ctx.quadraticCurveTo(13.6, 10.4, 2, 11.6);
        ctx.lineTo(-20, 10.4);
        ctx.closePath();
      };
    } else {
      // Henschel-torony: szögletes, keskeny ferde homlok, hosszú egyenes oldalak
      clip = (): void => path(ctx, [-21.4, -10.8, 4, -12, 11.6, -7.2, 13.4, -4.6, 13.4, 4.6, 11.6, 7.2, 4, 12, -21.4, 10.8]);
    }
    ctx.save();
    ctx.translate(1.2, 1.4);
    clip();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fill();
    ctx.restore();
    clip();
    ctx.fillStyle = shade(ctx, -13, 13, p);
    ctx.fill();
    ctx.strokeStyle = p.edge;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // terepminta a tornyon
    const spots = [-8, -7, 7, 2.6, 0.5, 2, 6, 6, 2.2, -0.4, -14, 4, 4, 2, 1.1];
    camo(ctx, clip, spots, TIGER_OLIVE);
    if (tier >= 1) camo(ctx, clip, [-2, -9, 5, 1.8, 0.2, -12, -2, 3.4, 1.6, 0.9, 6, 9.4, 4, 1.6, 0], TIGER_BROWN);
    if (tier >= 5) {
      const dots: number[] = [];
      for (let i = 0; i < 12; i++) dots.push(-18 + ((i * 29) % 30), -9 + ((i * 17) % 18), 0.8, 0.8, 0);
      camo(ctx, clip, dots, 'rgba(216,189,124,0.9)');
    }
    if (tier === 1 || tier === 2) zimmerit(ctx, clip, -22, 14, -14, 14);
    // ágyúpajzs
    if (!king) box(ctx, 9.4, -8.6, 6.8, 17.2, 1.8, shade(ctx, -8.6, 8.6, p), p.edge, 1);
    else box(ctx, 12.4, -4.2, 4.2, 8.4, 1.6, shade(ctx, -4.2, 4.2, p), p.edge, 0.9);
    // parancsnoki kupola hátul balra: korai dob alakú (figyelőrésekkel), később öntött periszkópos
    const cx = king ? -12 : -8.6;
    const cy = -6.4;
    disc(ctx, cx, cy, 5, shade(ctx, cy - 5, cy + 5, p), p.edge, 0.9);
    for (let i = 0; i < (tier >= 2 ? 7 : 5); i++) {
      const a = (i / (tier >= 2 ? 7 : 5)) * Math.PI * 2 + 0.3;
      box(ctx, cx + Math.cos(a) * 4.2 - 0.6, cy + Math.sin(a) * 4.2 - 0.6, 1.2, 1.2, 0.3, '#1a160c');
    }
    hatch(ctx, cx, cy, 3.2, p, -1);
    // töltőkezelő búvónyílása, ventilátor a tetőn
    if (tier >= 2 || king) hatch(ctx, king ? -4 : -2.6, 6.2, 3.4, p, -1);
    else box(ctx, -5.6, 3.6, 6, 5, 1, shade(ctx, 3.6, 8.6, p), p.edge, 0.8);
    disc(ctx, king ? 3.6 : 3.2, -1.2, 1.4, p.dark, p.edge, 0.6);
    // ködgránátvetők a homlok két szélén (korai Tiger I)
    if (tier === 0) for (const side of [-1, 1]) for (let i = 0; i < 3; i++) disc(ctx, 3 + i * 2.2, side * 12.8, 0.9, '#2a241a', '#0e0c08', 0.4);
    // málhaláda a torony hátán („Rommel-láda”), pótláncszemek a torony oldalán
    if (tier >= 1 && !king) box(ctx, -23.8, -7.4, 5.6, 14.8, 1, shade(ctx, -7.4, 7.4, p), p.edge, 0.9);
    if (tier >= 1 && !king) {
      spareLinks(ctx, -10, -14.6, 3, 2.2, 2.4);
      spareLinks(ctx, -10, 12.2, 3, 2.2, 2.4);
    }
    if (king) {
      spareLinks(ctx, -16, -13.4, 4, 2.2, 2.6);
      spareLinks(ctx, -16, 10.8, 4, 2.2, 2.6);
    }
    recognition(ctx, king ? -20 : -17.2, -2.4, 4.6, 4.8);
  });
}

// --- Sherman ---------------------------------------------------------------------------
// Olívbarna (olive drab), a motortéren fehér csillaggal körben (légi felismerő jel).
// Fejlődés: M4 (hegesztett test, rövid 75 mm-es ágyú) → M4A1 (öntött, lekerekített test) →
// M4A3 76 mm-es ágyúval, nagyobb toronnyal → „Easy Eight” (szélesebb, HVSS futómű,
// csőszájfék) → „Jumbo” (rohamváltozat vastag pótpáncéllal, homokzsákokkal) → Firefly
// (brit átépítés: nagyon hosszú 17 fontos ágyú, rádióláda a torony hátán).

const SHERMAN: Paint = { light: '#7a7a50', base: '#5c5d39', dark: '#3b3c24', edge: '#191a10' };
const SHERMAN_TIER_NAMES = ['M4 Sherman', 'M4A1 Sherman', 'M4A3 (76) Sherman', 'Sherman „Easy Eight”', 'Sherman „Jumbo”', 'Sherman Firefly'] as const;

/** Fehér ötágú csillag körben. */
function whiteStar(ctx: Ctx, x: number, y: number, r: number, ring = true): void {
  if (ring) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#ece8da';
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }
  const pts: number[] = [];
  const rr = ring ? r * 0.86 : r;
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const k = i % 2 === 0 ? rr : rr * 0.4;
    pts.push(x + Math.cos(a) * k, y + Math.sin(a) * k);
  }
  poly(ctx, pts, '#ece8da');
}

function hullSherman(ctx: Ctx, frame: number, tier: number): void {
  grown(ctx, tier, () => {
    const hvss = tier >= 3;
    const cast = tier === 1;
    // a test keskenyebb és magasabb: a lánctalp felülről is jól látszik mellette
    const outline = cast ? [-2, 6, 46, 5.2, 56, 6.6, 60, 9, 60, 33, 56, 35.4, 46, 36.8, -2, 36, -4, 33, -4, 9] : [-2, 5.6, 47, 5.6, 57, 7.2, 60, 9.4, 60, 32.6, 57, 34.8, 47, 36.4, -2, 36.4, -4, 33.4, -4, 8.6];
    dropShadow(ctx, [-6, 0, 68, 0, 68, 42, -6, 42]);
    // VVSS futómű: keskeny lánc; HVSS: szélesebb, kiálló „kacsacsőr” végtagokkal
    const tw = hvss ? 9.6 : 7.4;
    tread(ctx, frame, -6, hvss ? -0.8 : 0.6, 72, tw, 3.4);
    tread(ctx, frame, -6, hvss ? 33.2 : 34, 72, tw, 3.4);
    if (!hvss) {
      // a forgóváz-felfüggesztés karjai a lánc fölött
      for (const x of [6, 24, 42]) {
        box(ctx, x, 4.6, 8, 2.4, 0.6, SHERMAN.dark, SHERMAN.edge, 0.6);
        box(ctx, x, 35, 8, 2.4, 0.6, SHERMAN.dark, SHERMAN.edge, 0.6);
      }
    }
    poly(ctx, outline, shade(ctx, 5, 37, SHERMAN), SHERMAN.edge, 1.6);
    // a sebességváltó lekerekített, háromrészes orrburkolata
    ctx.beginPath();
    ctx.moveTo(57, 8.6);
    ctx.quadraticCurveTo(67.6, 9.2, 67.6, 21);
    ctx.quadraticCurveTo(67.6, 32.8, 57, 33.4);
    ctx.closePath();
    ctx.fillStyle = shade(ctx, 8.6, 33.4, { ...SHERMAN, light: '#8a8a5c' });
    ctx.fill();
    ctx.strokeStyle = SHERMAN.edge;
    ctx.lineWidth = 1.1;
    ctx.stroke();
    if (!cast) for (const y of [15, 27]) line(ctx, [58, y, 66.6, y + (y - 21) * 0.25], 'rgba(0,0,0,0.45)', 0.8);
    // ferde homloklemez a vezető és a segédvezető búvónyílásával, köztük a géppuska
    poly(ctx, [45.6, 6.4, 56.4, 7.8, 56.4, 34.2, 45.6, 35.6], shade(ctx, 6, 36, { ...SHERMAN, light: '#86865a' }), SHERMAN.edge, 0.8);
    const big = tier >= 2;
    for (const y of [12.6, 29.4]) {
      if (big) hatch(ctx, 50.6, y, 4, SHERMAN, -1);
      else box(ctx, 47.4, y - 3.4, 6.4, 6.8, 1.6, shade(ctx, y - 3.4, y + 3.4, SHERMAN), SHERMAN.edge, 0.8);
      box(ctx, 54.2, y - 1.4, 1.4, 2.8, 0.3, '#12130a');
    }
    disc(ctx, 54.6, 22.6, 1.8, SHERMAN.dark, SHERMAN.edge, 0.7);
    // motortér: két nagy fedőlap zsanérokkal, hátul a légbeömlő rács, tanksapkák
    box(ctx, -1.6, 8.6, 20, 24.8, 1, shade(ctx, 8.6, 33.4, SHERMAN), SHERMAN.edge, 0.9);
    line(ctx, [-1.6, 21, 18.4, 21], SHERMAN.edge, 0.7);
    for (const y of [10.4, 31.6]) for (const x of [2, 14]) box(ctx, x, y - 0.8, 2.6, 1.6, 0.4, SHERMAN.dark);
    louvres(ctx, -4.2, 9.6, 2.6, 22.8, SHERMAN, false, 1.4);
    for (const [x, y] of [[21.4, 8], [21.4, 34]]) disc(ctx, x, y, 1.1, SHERMAN.dark, SHERMAN.edge, 0.5);
    // fehér csillag körben a motortéren (légi felismerő jel)
    whiteStar(ctx, 9.6, 21, 6.4);
    // szerszámok a hátsó sárvédőkön, vontatókötél
    shovel(ctx, 22, 6.6, 9);
    cable(ctx, 22, 42, 35.6);
    // pótpáncél a homlokon és az oldalakon (M4A3-tól), „Jumbo”: vastag lemezek és homokzsákok
    if (tier >= 2) {
      for (const y of [6.2, 32.6]) box(ctx, 26, y, 10, 3.2, 0.4, shade(ctx, y, y + 3.2, SHERMAN), SHERMAN.edge, 0.7);
    }
    if (tier === 4) {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
        const g = ctx.createLinearGradient(0, 15 + j * 6, 0, 20.4 + j * 6);
        g.addColorStop(0, '#a49a72');
        g.addColorStop(1, '#6a6246');
        box(ctx, 46.4 + (j % 2) * 1.6 + i * 0.1, 13.8 + j * 6 + i * 0, 4.4, 5.6, 2, g, '#2a2618', 0.6);
      }
      for (const y of [9.4, 32.6]) spareLinks(ctx, 57.4, y - 3, 3, 2, 4.8);
    }
    // légi azonosító lap a homloklemezen, a két búvónyílás között
    recognition(ctx, tier === 4 ? 47 : 47.8, tier === 4 ? 26 : 17.4, tier === 4 ? 7.6 : 6, tier === 4 ? 4.4 : 7.2);
    disc(ctx, 30, 21, 11.4, SHERMAN.dark, SHERMAN.edge, 1);
    disc(ctx, 34, 21, 11.4, SHERMAN.dark, SHERMAN.edge, 1);
  });
}

function turretSherman(ctx: Ctx, marks: number, tier: number): void {
  const p = SHERMAN;
  const rings = Math.min(4, marks);
  // 75 mm M3 (rövid), 76 mm M1 (hosszú, az „Easy Eight”-től csőszájfékkel), 17 fontos (Firefly)
  if (tier >= 5) {
    gun(ctx, 13, 52, 3.4, p, rings, 0.86);
    muzzleBrake(ctx, 51.6, 4.6, 5, p);
  } else if (tier === 2) gun(ctx, 12, 47, 3.2, p, rings, 0.86);
  else if (tier >= 3) {
    gun(ctx, 12, 46, 3.2, p, rings, 0.86);
    muzzleBrake(ctx, 45.6, 4.2, 4.6, p);
  } else gun(ctx, 11, 38, 3.4, p, rings, 0.86);
  grownTurret(ctx, tier, () => {
    const t23 = tier >= 2;
    const rx = t23 ? 14.4 : 13;
    const ry = t23 ? 12.2 : 11;
    const clip = (): void => {
      ctx.beginPath();
      ctx.ellipse(-1, 0, rx, ry, 0, 0, Math.PI * 2);
      // a T23-as toronynak hátul nagyobb a túlnyúlása
      if (t23) ctx.ellipse(-8, 0, 9, 9.4, 0, 0, Math.PI * 2);
    };
    ctx.save();
    ctx.translate(1.2, 1.4);
    clip();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fill();
    ctx.restore();
    clip();
    const g = ctx.createRadialGradient(-5, -5, 1, -1, 0, rx + 2);
    g.addColorStop(0, p.light);
    g.addColorStop(0.55, p.base);
    g.addColorStop(1, p.dark);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = p.edge;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // „Jumbo”: vastagabb, szögletesebb homlok
    if (tier === 4) box(ctx, 6, -11, 6, 22, 2, shade(ctx, -11, 11, p), p.edge, 0.9);
    // ágyúpajzs (a rövid ágyúnál keskeny, a 76-osnál szélesebb öntvény)
    box(ctx, rx - 3.4, -5.6, 5.4, 11.2, 1.8, shade(ctx, -5.6, 5.6, p), p.edge, 0.9);
    // parancsnoki kupola jobbra hátul (a T23-on periszkópos figyelőkupola), töltőkezelő búvónyílás balra
    if (t23) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        box(ctx, -6 + Math.cos(a) * 4.6 - 0.6, 6 + Math.sin(a) * 4.6 - 0.6, 1.2, 1.2, 0.3, '#12130a');
      }
      hatch(ctx, -6, 6, 4.2, p, -1);
      box(ctx, -8.6, -9.4, 6.4, 4.6, 2.2, shade(ctx, -9.4, -4.8, p), p.edge, 0.8);
    } else {
      box(ctx, -8.4, 2.6, 7.2, 6.4, 2.6, shade(ctx, 2.6, 9, p), p.edge, 0.8);
      if (tier >= 1) box(ctx, -7.4, -8.6, 5.6, 4.4, 2, shade(ctx, -8.6, -4.2, p), p.edge, 0.7);
    }
    // periszkópok
    box(ctx, 4, -6.4, 1.6, 2.4, 0.3, '#12130a');
    box(ctx, 4, 4, 1.6, 2.4, 0.3, '#12130a');
    // 12,7 mm-es légvédelmi géppuska a torony tetején
    line(ctx, [-12, 2.4, 2, 2.4], '#20211a', 1.2);
    line(ctx, [-1, 2.4, 6, 2.4], '#20211a', 0.8);
    box(ctx, -13.4, 0.8, 3.4, 3.2, 0.6, '#2a2b20', '#0c0c08', 0.5);
    // Firefly: páncélozott rádióláda a torony hátán
    if (tier >= 5) box(ctx, -21.4, -6.4, 5.4, 12.8, 1, shade(ctx, -6.4, 6.4, p), p.edge, 0.9);
    // fehér csillag a torony tetején (csak a korai változatokon volt ilyen nagy)
    if (tier <= 1) whiteStar(ctx, -2, -4, 2.6, false);
    recognition(ctx, t23 ? -16.6 : -13, -2.2, 4.2, 4.4);
  });
}

// --- összesítés ---------------------------------------------------------------------

export interface ClassicTank {
  name: string;
  hint: string;
  tierNames: readonly string[];
  hull: (ctx: Ctx, frame: number, tier: number) => void;
  turret: (ctx: Ctx, marks: number, tier: number) => void;
}

export const CLASSIC_TANKS: readonly ClassicTank[] = [
  {
    name: 'T-34',
    hint: 'Szovjet közepes harckocsi, védőzöld festéssel: ferde páncél, széles lánctalp – a T-34/76-tól a T-34-85-ön át a 100 mm-es ágyúig.',
    tierNames: T34_TIER_NAMES,
    hull: hullT34,
    turret: turretT34,
  },
  {
    name: 'Tigris',
    hint: 'Német nehéz harckocsi, sötétsárga alapon olívzöld–vörösbarna terepmintával: Tiger I, majd Királytigris, a végén 10,5 cm-es ágyúval.',
    tierNames: TIGER_TIER_NAMES,
    hull: hullTiger,
    turret: turretTiger,
  },
  {
    name: 'Sherman',
    hint: 'Amerikai közepes harckocsi, olívbarna festéssel, fehér csillaggal: M4-től az „Easy Eight”-en és a „Jumbo”-n át a hosszú csövű Fireflyig.',
    tierNames: SHERMAN_TIER_NAMES,
    hull: hullSherman,
    turret: turretSherman,
  },
];
