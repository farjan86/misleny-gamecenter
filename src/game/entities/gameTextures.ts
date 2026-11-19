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
  oil: 'oil-slick',
  ring: 'fx-ring',
  smoke: 'fx-smoke',
  /** 2×2-es fehér négyzet: életerősávokhoz és lézersugárhoz nyújtva használjuk */
  px: 'px',
} as const;

export const PICKUP_ICON_SIZE = 48;

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
