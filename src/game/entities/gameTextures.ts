// A harchoz és a felvehető tárgyakhoz tartozó, kódból rajzolt textúrák:
// ellenséges tank (a saját tank átszínezve), tárgyikonok, rakéta, olajfolt,
// pajzsgyűrű, füst. A createTextures() után hívandó.

import Phaser from 'phaser';
import { PICKUP_KINDS } from '../sim/pickups';
import { PICKUP_STYLE, pickupTexture } from './pickupStyle';
import { HULL_SIZE, TEX, TURRET_SIZE } from './textures';

export const GTEX = {
  enemyHull: ['enemy-hull-0', 'enemy-hull-1', 'enemy-hull-2'],
  enemyTurret: 'enemy-turret',
  wreckHull: 'wreck-hull',
  wreckTurret: 'wreck-turret',
  rocket: 'rocket',
  heavyShell: 'heavy-shell',
  /** lángok: FIRE_FRAMES képkocka egymás mellett */
  fire: 'fx-fire',
  glow: 'fx-glow',
  oil: 'oil-slick',
  ring: 'fx-ring',
  smoke: 'fx-smoke',
  /** 2×2-es fehér négyzet: életerősávokhoz és lézersugárhoz nyújtva használjuk */
  px: 'px',
} as const;

export const PICKUP_ICON_SIZE = 48;
/** a láng-animáció képkockáinak száma és mérete (pixel) */
export const FIRE_FRAMES = 8;
const FIRE_SIZE = 48;

type Ctx = CanvasRenderingContext2D;

function canvasTexture(scene: Phaser.Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void): void {
  const tex = scene.textures.createCanvas(key, w, h)!;
  draw(tex.context);
  tex.refresh();
}

/** A saját tank textúrájának átszínezése: a zöld árnyalatok vörösre váltanak, a többi marad. */
function recolored(scene: Phaser.Scene, source: string, key: string, w: number, h: number): void {
  canvasTexture(scene, key, w, h, (ctx) => {
    const src = scene.textures.get(source).getSourceImage() as HTMLCanvasElement;
    ctx.drawImage(src, 0, 0);
    const image = ctx.getImageData(0, 0, w, h);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (g > r * 1.08 && g > b) {
        d[i] = Math.min(255, g * 1.15);
        d[i + 1] = r * 0.7;
        d[i + 2] = b * 0.7;
      }
    }
    ctx.putImageData(image, 0, 0);
  });
}

/** Kiégett roncs: a tank textúrája megfeketedve, rozsdás foltokkal. */
function charred(scene: Phaser.Scene, source: string, key: string, w: number, h: number): void {
  canvasTexture(scene, key, w, h, (ctx) => {
    const src = scene.textures.get(source).getSourceImage() as HTMLCanvasElement;
    ctx.drawImage(src, 0, 0);
    const image = ctx.getImageData(0, 0, w, h);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const px = (i / 4) % w;
      const py = Math.floor(i / 4 / w);
      const lum = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) * 0.42;
      // szabálytalan rozsdafoltok
      const rust = (Math.sin(px * 0.9) + Math.sin(py * 1.3 + px * 0.4)) > 1.1 ? 22 : 0;
      d[i] = Math.min(255, lum + 14 + rust);
      d[i + 1] = lum + 6 + rust * 0.4;
      d[i + 2] = lum;
    }
    ctx.putImageData(image, 0, 0);
  });
}

export function createGameTextures(scene: Phaser.Scene): void {
  charred(scene, TEX.hull[0], GTEX.wreckHull, HULL_SIZE.w, HULL_SIZE.h);
  charred(scene, TEX.turret, GTEX.wreckTurret, TURRET_SIZE.w, TURRET_SIZE.h);
  TEX.hull.forEach((key, i) => recolored(scene, key, GTEX.enemyHull[i], HULL_SIZE.w, HULL_SIZE.h));
  recolored(scene, TEX.turret, GTEX.enemyTurret, TURRET_SIZE.w, TURRET_SIZE.h);

  // tárgyikonok: színes korong világos peremmel, közepén a jel
  const size = PICKUP_ICON_SIZE;
  for (const kind of PICKUP_KINDS) {
    const style = PICKUP_STYLE[kind];
    canvasTexture(scene, pickupTexture(kind), size, size, (ctx) => {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2);
      ctx.fillStyle = '#101418';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
      ctx.fillStyle = style.color;
      ctx.fill();
      ctx.strokeStyle = '#fff6d0';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      style.icon(ctx);
    });
  }

  // nehéz lövedék (jobbra néz): vaskos, sötét acéltest hegyes orral és vörös gyűrűvel, mögötte izzó csóva
  canvasTexture(scene, GTEX.heavyShell, 34, 14, (ctx) => {
    const tail = ctx.createLinearGradient(0, 0, 14, 0);
    tail.addColorStop(0, 'rgba(255,120,30,0)');
    tail.addColorStop(1, 'rgba(255,210,90,0.95)');
    ctx.fillStyle = tail;
    ctx.beginPath();
    ctx.moveTo(14, 2.5);
    ctx.lineTo(0, 7);
    ctx.lineTo(14, 11.5);
    ctx.fill();
    ctx.fillStyle = '#4a4f5a';
    ctx.beginPath();
    ctx.moveTo(12, 1.5);
    ctx.lineTo(24, 1.5);
    ctx.lineTo(33.5, 7);
    ctx.lineTo(24, 12.5);
    ctx.lineTo(12, 12.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#15171c';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#d8322c';
    ctx.fillRect(15, 2.2, 3.5, 9.6);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(13, 3.2, 12, 1.6);
  });

  // lángok felülnézetben: lobogó, szabálytalan folt, kívül vörös, beljebb narancs, sárga, középen fehéren izzó
  {
    const tex = scene.textures.createCanvas(GTEX.fire, FIRE_SIZE * FIRE_FRAMES, FIRE_SIZE)!;
    const ctx = tex.context;
    const layers: [string, number][] = [['rgba(200,48,20,0.88)', 1], ['#ee7a1c', 0.76], ['#ffc83a', 0.52], ['#fff3c0', 0.27]];
    const tongues = 7;
    for (let f = 0; f < FIRE_FRAMES; f++) {
      const cx = f * FIRE_SIZE + FIRE_SIZE / 2;
      const cy = FIRE_SIZE / 2;
      const phase = (f / FIRE_FRAMES) * Math.PI * 2;
      for (const [color, k] of layers) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, 11.5 * k, 0, Math.PI * 2);
        ctx.fill();
        for (let t = 0; t < tongues; t++) {
          // a nyelvek hossza és iránya képkockánként hullámzik (a sorozat körbeér)
          const angle = (t / tongues) * Math.PI * 2 + 0.28 * Math.sin(phase + t * 2.4);
          const reach = (9 + 6.5 * (0.5 + 0.5 * Math.sin(phase * 2 + t * 1.9))) * k;
          const r = (6.2 + 1.8 * Math.sin(phase + t * 3.1)) * k;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(cx + Math.cos(angle) * reach * 0.55, cy + Math.sin(angle) * reach * 0.55, r * 1.15, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    tex.refresh();
    for (let f = 0; f < FIRE_FRAMES; f++) tex.add(f, 0, f * FIRE_SIZE, 0, FIRE_SIZE, FIRE_SIZE);
  }

  // a tűz fénye a környezetén
  canvasTexture(scene, GTEX.glow, 64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,190,90,0.9)');
    g.addColorStop(0.5, 'rgba(255,120,40,0.35)');
    g.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });

  // rakéta (jobbra néz), mögötte láng
  canvasTexture(scene, GTEX.rocket, 40, 14, (ctx) => {
    const flame = ctx.createLinearGradient(0, 0, 16, 0);
    flame.addColorStop(0, 'rgba(255,140,40,0)');
    flame.addColorStop(1, '#ffe07a');
    ctx.fillStyle = flame;
    ctx.beginPath();
    ctx.moveTo(16, 3.5);
    ctx.lineTo(0, 7);
    ctx.lineTo(16, 10.5);
    ctx.fill();
    ctx.fillStyle = '#d8d8dc';
    ctx.beginPath();
    ctx.moveTo(15, 3.5);
    ctx.lineTo(31, 3.5);
    ctx.quadraticCurveTo(39, 4, 39.5, 7);
    ctx.quadraticCurveTo(39, 10, 31, 10.5);
    ctx.lineTo(15, 10.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#3a3a40';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#c8322c';
    ctx.fillRect(30, 4, 3, 6);
    ctx.fillRect(15, 0.5, 5, 3);
    ctx.fillRect(15, 10.5, 5, 3);
  });

  // olajfolt: szabálytalan, sötét, fénylő folt
  canvasTexture(scene, GTEX.oil, 96, 96, (ctx) => {
    ctx.fillStyle = '#16161c';
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const r = 36 + Math.sin(a * 3 + 0.6) * 5 + Math.sin(a * 7 + 2) * 3.5;
      ctx.lineTo(48 + Math.cos(a) * r, 48 + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    for (const [x, y, r] of [[30, 26, 8], [70, 60, 9], [58, 20, 6], [26, 66, 7]]) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // szivárványos csillogás
    const shine = ctx.createLinearGradient(20, 20, 76, 76);
    shine.addColorStop(0, 'rgba(120,90,200,0.55)');
    shine.addColorStop(0.5, 'rgba(60,140,180,0.45)');
    shine.addColorStop(1, 'rgba(200,170,80,0.4)');
    ctx.strokeStyle = shine;
    ctx.lineWidth = 3;
    for (const r of [14, 23]) {
      ctx.beginPath();
      ctx.ellipse(46, 46, r * 1.2, r * 0.8, 0.6, 0.3, 4.2);
      ctx.stroke();
    }
  });

  // gyűrű a tank körül (pajzs, sebezhetetlenség) – színezve használjuk
  canvasTexture(scene, GTEX.ring, 112, 112, (ctx) => {
    const glow = ctx.createRadialGradient(56, 56, 34, 56, 56, 55);
    glow.addColorStop(0, 'rgba(255,255,255,0)');
    glow.addColorStop(0.75, 'rgba(255,255,255,0.28)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 112, 112);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(56, 56, 48, 0, Math.PI * 2);
    ctx.stroke();
  });

  canvasTexture(scene, GTEX.smoke, 28, 28, (ctx) => {
    const g = ctx.createRadialGradient(14, 14, 0, 14, 14, 14);
    g.addColorStop(0, 'rgba(230,230,230,0.9)');
    g.addColorStop(1, 'rgba(160,160,160,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 28, 28);
  });

  canvasTexture(scene, GTEX.px, 2, 2, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 2, 2);
  });
}
