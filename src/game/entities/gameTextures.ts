// A harchoz és a felvehető tárgyakhoz tartozó, kódból rajzolt textúrák:
// tárgyikonok, rakéta, olajfolt, pajzsgyűrű, füst. A createTextures() után hívandó.

import Phaser from 'phaser';
import { PICKUP_KINDS } from '../sim/pickups';
import { PICKUP_STYLE, pickupTexture } from './pickupStyle';

export const GTEX = {
  rocket: 'rocket',
  heavyShell: 'heavy-shell',
  /** lángok: FIRE_FRAMES képkocka egymás mellett */
  fire: 'fx-fire',
  glow: 'fx-glow',
  /** lágy szélű fehér korong: este ezzel „vágunk lyukat” a sötétségbe a fények helyén */
  light: 'fx-light',
  rain: 'fx-rain',
  /** a földet érő esőcsepp gyűrűje */
  splash: 'fx-splash',
  /** két lánctalp nyoma, 2 méternyi útszakasz (jobbra néz) */
  track: 'fx-track',
  /** robbanáskor szétrepülő törmelékdarab */
  debris: 'fx-debris',
  /** lökéshullám gyűrűje */
  shock: 'fx-shock',
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

export function createGameTextures(scene: Phaser.Scene): void {
  canvasTexture(scene, GTEX.light, 128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });

  // esőcseppek: sok rövid, vékony, különböző erősségű vonalka (a kép csempézve ismétlődik)
  canvasTexture(scene, GTEX.rain, 256, 256, (ctx) => {
    ctx.lineCap = 'round';
    for (let i = 0; i < 80; i++) {
      const x = (i * 97.31 + 13) % 256;
      const y = (i * 61.73 + ((i * i * 7.1) % 53)) % 256;
      const len = 12 + ((i * 7) % 14);
      ctx.strokeStyle = `rgba(214,226,242,${(0.1 + ((i * 13) % 10) * 0.018).toFixed(2)})`;
      ctx.lineWidth = i % 4 === 0 ? 2 : 1.5;
      for (const [ox, oy] of [[0, 0], [256, 0], [0, 256], [-256, 0], [0, -256]]) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox - len * 0.2, y + oy + len);
        ctx.stroke();
      }
    }
  });

  // lánctalpnyom: két sáv, bennük a láncszemek keresztirányú lenyomatai (fehér: a színt a tint adja)
  canvasTexture(scene, GTEX.track, 24, 40, (ctx) => {
    for (const top of [2, 28]) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(0, top, 24, 10);
      ctx.fillStyle = 'rgba(255,255,255,1)';
      for (let x = 1; x < 24; x += 4) ctx.fillRect(x, top, 2, 10);
    }
  });

  canvasTexture(scene, GTEX.debris, 8, 8, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(1, 2);
    ctx.lineTo(6, 0);
    ctx.lineTo(7, 5);
    ctx.lineTo(3, 7);
    ctx.closePath();
    ctx.fill();
  });

  canvasTexture(scene, GTEX.shock, 96, 96, (ctx) => {
    const g = ctx.createRadialGradient(48, 48, 30, 48, 48, 47);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.75, 'rgba(255,240,200,0.75)');
    g.addColorStop(1, 'rgba(255,220,160,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 96, 96);
  });

  canvasTexture(scene, GTEX.splash, 24, 24, (ctx) => {
    ctx.strokeStyle = 'rgba(225,235,248,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(12, 12, 9, 7, 0, 0, Math.PI * 2);
    ctx.stroke();
  });

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
