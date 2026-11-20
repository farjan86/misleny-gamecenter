// A harchoz és a felvehető tárgyakhoz tartozó, kódból rajzolt textúrák:
// tárgyikonok, rakéta, olajfolt, pajzsgyűrű, füst. A createTextures() után hívandó.

import Phaser from 'phaser';
import { WORKSHOP } from '../sim/gadgets';
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
  /** a füstfelhő gomolyagjai: a kulcs után a változat sorszáma áll (fx-puff0 … ) */
  puff: 'fx-puff',
  /** lerakott akna, gázpalack (felülről), füstfelhő */
  mine: 'fx-mine',
  barrel: 'fx-barrel',
  cloud: 'fx-cloud',
  /** jobbra mutató nyíl (a bosszú és a szupertárgy irányához), és a találat irányát jelző ív */
  arrow: 'fx-arrow',
  hitArc: 'fx-hit-arc',
  /** javítóműhely: a csarnok padlója (a tankok alatt) és a váza a tetővel (a tankok fölött, áttetszően) */
  shopFloor: 'fx-shop-floor',
  shopRoof: 'fx-shop-roof',
  /** a tank oldalára szerelt kiegészítő géppuska (jobbra néz; a forgáspontja a tokja) */
  mg: 'fx-mg',
  /** 2×2-es fehér négyzet: életerősávokhoz és lézersugárhoz nyújtva használjuk */
  px: 'px',
} as const;

export const PICKUP_ICON_SIZE = 48;
/** a füstgomolyag-textúrák száma és mérete (pixel) */
export const PUFF_VARIANTS = 4;
export const PUFF_SIZE = 160;
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
  // (kétszeres felbontásban rajzolva: a folt nagy, közelről se legyen elmosódott)
  canvasTexture(scene, GTEX.oil, 192, 192, (ctx) => {
    ctx.scale(2, 2);
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

  // --- javítóműhely: 17 × 14 méteres nyitott csarnok (12 pixel / méter) ---------------------
  {
    const w = WORKSHOP.width * 12;
    const h = WORKSHOP.height * 12;
    // padló: betonlap figyelmeztető szegéllyel, közepén szerelőakna és nagy csavarkulcs-jel
    canvasTexture(scene, GTEX.shopFloor, w, h, (ctx) => {
      ctx.fillStyle = '#8f9499';
      ctx.fillRect(0, 0, w, h);
      // betontáblák fugái
      ctx.strokeStyle = 'rgba(40,44,50,0.35)';
      ctx.lineWidth = 2;
      for (let x = 51; x < w; x += 51) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 56; y < h; y += 56) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      // olajfoltok
      for (const [x, y, r] of [[60, 50, 16], [150, 118, 22], [118, 40, 10], [40, 130, 12]]) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(20,20,24,0.4)');
        g.addColorStop(1, 'rgba(20,20,24,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      // sárga-fekete szegély körben
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.rect(10, 10, w - 20, h - 20);
      ctx.clip('evenodd');
      ctx.fillStyle = '#ffd23c';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#1a1a14';
      ctx.lineWidth = 7;
      for (let d = -h; d < w + h; d += 22) {
        ctx.beginPath();
        ctx.moveTo(d, h + 4);
        ctx.lineTo(d + h, -4);
        ctx.stroke();
      }
      ctx.restore();
      // zöld kör, benne fehér csavarkulcs: itt javul a tank
      const cx = w / 2;
      const cy = h / 2;
      ctx.fillStyle = 'rgba(46,160,80,0.9)';
      ctx.beginPath();
      ctx.arc(cx, cy, 52, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-30, -7, 60, 14);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(side * 34, 0, 16, 0, Math.PI * 2);
        ctx.fill();
        // a kulcs nyílása
        ctx.fillStyle = 'rgba(46,160,80,1)';
        ctx.fillRect(side > 0 ? 36 : -52, -6, 16, 12);
        ctx.fillStyle = '#ffffff';
      }
      ctx.restore();
    });
    // váz és tető: acélgerendák, sarkain oszlopok, a mezőkben áttetsző hullámlemez; a homlokán piros-fehér tábla
    canvasTexture(scene, GTEX.shopRoof, w, h, (ctx) => {
      ctx.fillStyle = 'rgba(70,96,120,0.5)';
      ctx.fillRect(6, 6, w - 12, h - 12);
      ctx.strokeStyle = 'rgba(210,225,240,0.22)';
      ctx.lineWidth = 2;
      for (let x = 12; x < w - 8; x += 9) {
        ctx.beginPath();
        ctx.moveTo(x, 8);
        ctx.lineTo(x, h - 8);
        ctx.stroke();
      }
      // középen nyitott a tető: látszik a tank
      ctx.clearRect(34, 30, w - 68, h - 60);
      ctx.strokeStyle = '#2a323c';
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.lineWidth = 5;
      ctx.strokeRect(34, 30, w - 68, h - 60);
      for (const x of [w / 3, (2 * w) / 3]) {
        ctx.beginPath();
        ctx.moveTo(x, 4);
        ctx.lineTo(x, 30);
        ctx.moveTo(x, h - 30);
        ctx.lineTo(x, h - 4);
        ctx.stroke();
      }
      ctx.strokeStyle = '#8fa0b0';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      // sarokoszlopok
      for (const [x, y] of [[9, 9], [w - 9, 9], [9, h - 9], [w - 9, h - 9]]) {
        ctx.fillStyle = '#1c232b';
        ctx.fillRect(x - 9, y - 9, 18, 18);
        ctx.fillStyle = '#ffd23c';
        ctx.fillRect(x - 5, y - 5, 10, 10);
      }
      // tábla a felső gerendán: piros alapon fehér kereszt
      ctx.fillStyle = '#d8322c';
      ctx.fillRect(w / 2 - 26, 0, 52, 26);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(w / 2 - 25, 1, 50, 24);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(w / 2 - 3.5, 4, 7, 18);
      ctx.fillRect(w / 2 - 10, 9.5, 20, 7);
    });
  }

  // kiegészítő géppuska felülről: lőszeres doboz hevederrel, tok, hűtőbordás cső, csőszájfék
  canvasTexture(scene, GTEX.mg, 46, 20, (ctx) => {
    // lőszeres doboz a tok mellett, belőle sárga heveder fut a tokba
    ctx.fillStyle = '#4a5a3a';
    ctx.fillRect(2, 11, 11, 8);
    ctx.strokeStyle = '#141a10';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(2, 11, 11, 8);
    ctx.fillStyle = '#ffd84a';
    for (let i = 0; i < 4; i++) ctx.fillRect(4 + i * 2.4, 8.2, 1.4, 3.2);
    // tok
    ctx.fillStyle = '#2a2d33';
    ctx.beginPath();
    ctx.roundRect(1, 3, 17, 8, 1.5);
    ctx.fill();
    ctx.strokeStyle = '#0a0b0d';
    ctx.stroke();
    ctx.fillStyle = '#5a5f6a';
    ctx.fillRect(3, 4.3, 12, 1.6);
    // cső hűtőbordákkal
    ctx.fillStyle = '#1c1e22';
    ctx.fillRect(18, 5.2, 24, 3.6);
    ctx.fillStyle = '#6a6f7a';
    for (let x = 20; x < 36; x += 3) ctx.fillRect(x, 4.4, 1.5, 5.2);
    // csőszájfék
    ctx.fillStyle = '#0c0d10';
    ctx.fillRect(40, 4, 5, 6);
    ctx.fillStyle = '#8a9099';
    ctx.fillRect(41.2, 5, 1.2, 4);
  });

  // akna: sötét tányér tüskékkel, közepén piros gyújtó
  canvasTexture(scene, GTEX.mine, 28, 28, (ctx) => {
    ctx.strokeStyle = '#15130f';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(14 + Math.cos(a) * 7, 14 + Math.sin(a) * 7);
      ctx.lineTo(14 + Math.cos(a) * 12, 14 + Math.sin(a) * 12);
      ctx.stroke();
    }
    ctx.fillStyle = '#3d3a2c';
    ctx.beginPath();
    ctx.arc(14, 14, 8.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#15130f';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = '#6a6548';
    ctx.beginPath();
    ctx.arc(12.5, 12.5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff3a2a';
    ctx.beginPath();
    ctx.arc(14, 14, 2.6, 0, Math.PI * 2);
    ctx.fill();
  });

  // gázpalack felülről: piros henger világos peremmel, szeleppel, figyelmeztető jellel
  canvasTexture(scene, GTEX.barrel, 28, 28, (ctx) => {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(16, 16, 10.5, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(11, 11, 1, 14, 14, 11);
    g.addColorStop(0, '#ff7a5a');
    g.addColorStop(0.6, '#d8322c');
    g.addColorStop(1, '#8a1a16');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(14, 14, 10.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a0c0a';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,220,200,0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(14, 14, 7.2, 0, Math.PI * 2);
    ctx.stroke();
    // sárga figyelmeztető háromszög és a szelep
    ctx.fillStyle = '#ffd84a';
    ctx.beginPath();
    ctx.moveTo(14, 9);
    ctx.lineTo(19, 18);
    ctx.lineTo(9, 18);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1a1a14';
    ctx.fillRect(13.2, 12, 1.6, 3.6);
    ctx.fillRect(13.2, 16.2, 1.6, 1.2);
  });

  // füstfelhő: sok egymásra rajzolt, lágy szélű pamacs (a közepe átlátszatlan)
  canvasTexture(scene, GTEX.cloud, 256, 256, (ctx) => {
    for (let i = 0; i < 46; i++) {
      const a = i * 2.399963; // aranyszög: egyenletes szórás
      const d = Math.sqrt(i / 46) * 84;
      const x = 128 + Math.cos(a) * d;
      const y = 128 + Math.sin(a) * d;
      const r = 34 + ((i * 37) % 22);
      const shade = 150 + ((i * 53) % 70);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${shade},${shade + 4},${shade + 10},0.95)`);
      g.addColorStop(0.6, `rgba(${shade},${shade + 4},${shade + 10},0.6)`);
      g.addColorStop(1, `rgba(${shade},${shade + 4},${shade + 10},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });

  // füstgomolyagok: zajból számolt, foszlós szélű, belül sűrű pamacsok, a tetejükön
  // világosabbak (mintha felülről érné őket a fény) – ettől térbelinek hat a felhő
  for (let v = 0; v < PUFF_VARIANTS; v++) {
    canvasTexture(scene, `${GTEX.puff}${v}`, PUFF_SIZE, PUFF_SIZE, (ctx) => {
      const hash = (ix: number, iy: number, seed: number): number => {
        const s = Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.7) * 43758.5453;
        return s - Math.floor(s);
      };
      const value = (x: number, y: number, seed: number): number => {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const fx = x - ix;
        const fy = y - iy;
        const ux = fx * fx * (3 - 2 * fx);
        const uy = fy * fy * (3 - 2 * fy);
        const a = hash(ix, iy, seed);
        const b = hash(ix + 1, iy, seed);
        const c = hash(ix, iy + 1, seed);
        const d = hash(ix + 1, iy + 1, seed);
        return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
      };
      const fbm = (x: number, y: number, seed: number): number => 0.5 * value(x, y, seed) + 0.27 * value(x * 2.1, y * 2.1, seed + 3) + 0.15 * value(x * 4.3, y * 4.3, seed + 7) + 0.08 * value(x * 8.7, y * 8.7, seed + 11);
      const img = ctx.createImageData(PUFF_SIZE, PUFF_SIZE);
      const seed = 5 + v * 13;
      for (let y = 0; y < PUFF_SIZE; y++) {
        for (let x = 0; x < PUFF_SIZE; x++) {
          const dx = (x / (PUFF_SIZE - 1)) * 2 - 1;
          const dy = (y / (PUFF_SIZE - 1)) * 2 - 1;
          const shape = fbm(x / 34, y / 34, seed);
          const detail = fbm(x / 13, y / 13, seed + 20);
          // a pamacs széle nem kör: a zaj kijjebb-beljebb húzza, a foszlányok áttetszők
          const edge = 1 - Math.hypot(dx, dy) / (0.6 + 0.38 * shape);
          const soft = Math.max(0, Math.min(1, edge / 0.5));
          const alpha = soft * soft * (3 - 2 * soft) * (0.5 + 0.5 * detail);
          const light = Math.max(0, Math.min(1, 0.7 + 0.3 * detail - 0.13 * (dx + dy) + 0.1 * edge));
          const i = (y * PUFF_SIZE + x) * 4;
          img.data[i] = 255 * light;
          img.data[i + 1] = 255 * light;
          img.data[i + 2] = 255 * Math.min(1, light * 1.02);
          img.data[i + 3] = 255 * Math.min(1, alpha * 1.15);
        }
      }
      ctx.putImageData(img, 0, 0);
    });
  }

  // jobbra mutató nyíl (fehér: a színt a tint adja)
  canvasTexture(scene, GTEX.arrow, 44, 44, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(40, 22);
    ctx.lineTo(8, 5);
    ctx.lineTo(16, 22);
    ctx.lineTo(8, 39);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#101418';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();
  });

  // a találat irányát jelző piros ív (jobbra néz)
  canvasTexture(scene, GTEX.hitArc, 64, 140, (ctx) => {
    ctx.lineCap = 'round';
    for (const [width, color] of [[14, 'rgba(120,10,10,0.55)'], [8, 'rgba(255,60,40,0.95)'], [3, 'rgba(255,200,180,0.9)']] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(-70, 70, 120, -0.5, 0.5);
      ctx.stroke();
    }
  });

  canvasTexture(scene, GTEX.px, 2, 2, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 2, 2);
  });
}
