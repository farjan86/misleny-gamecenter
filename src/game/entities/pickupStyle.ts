// A felvehető tárgyak megjelenése: név, szín és a kódból rajzolt ikon.
// A szabályok (időtartam, hatás) a sim/pickups.ts-ben vannak.

import type { PickupKind } from '../sim/pickups';

type Ctx = CanvasRenderingContext2D;

export interface PickupStyle {
  /** a HUD-on és a felvételkor megjelenő név */
  label: string;
  /** rövid magyarázat a felvételkor */
  hint: string;
  /** a korong színe (CSS) */
  color: string;
  /** az ikon rajza egy 48×48-as mező közepére (a korong már ki van rajzolva) */
  icon: (ctx: Ctx) => void;
}

const stroke = (ctx: Ctx, width: number, color = '#ffffff'): void => {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
};

function path(ctx: Ctx, pts: number[], close = false): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  if (close) ctx.closePath();
}

/** Lövedék alakja (jobbra néz), a megadott közép körül. */
function shell(ctx: Ctx, x: number, y: number, length: number, width: number, color = '#ffffff'): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - length / 2, y - width / 2);
  ctx.lineTo(x + length / 6, y - width / 2);
  ctx.quadraticCurveTo(x + length / 2, y - width / 2, x + length / 2, y);
  ctx.quadraticCurveTo(x + length / 2, y + width / 2, x + length / 6, y + width / 2);
  ctx.lineTo(x - length / 2, y + width / 2);
  ctx.closePath();
  ctx.fill();
}

export const PICKUP_STYLE: Record<PickupKind, PickupStyle> = {
  heavy: {
    label: 'Nehéz lövedék',
    hint: 'nagyobb robbanás, dupla sebzés – megmarad, amíg másik fegyvert nem veszel fel',
    color: '#b8322c',
    icon: (ctx) => {
      shell(ctx, 24, 24, 26, 14);
      ctx.fillStyle = '#b8322c';
      ctx.fillRect(14, 17, 3, 14);
    },
  },
  triple: {
    label: 'Hármas lövés',
    hint: '25 lövésig három lövedék legyezőben',
    color: '#d8742a',
    icon: (ctx) => {
      for (const [dy, rot] of [[-9, -0.3], [0, 0], [9, 0.3]] as const) {
        ctx.save();
        ctx.translate(22, 24 + dy);
        ctx.rotate(rot);
        shell(ctx, 3, 0, 18, 5.5);
        ctx.restore();
      }
    },
  },
  rapid: {
    label: 'Gyorstöltő',
    hint: 'sokkal gyorsabb tüzelés',
    color: '#c8a21e',
    icon: (ctx) => {
      stroke(ctx, 4.5);
      for (const x of [13, 22, 31]) {
        path(ctx, [x, 14, x + 7, 24, x, 34]);
        ctx.stroke();
      }
    },
  },
  ricochet: {
    label: 'Pattanó lövedék',
    hint: 'a lövedéked a falról kétszer visszapattan – megmarad, amíg ki nem lőnek',
    color: '#7a4ac0',
    icon: (ctx) => {
      stroke(ctx, 4);
      path(ctx, [10, 34, 20, 14, 30, 30, 37, 16]);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      path(ctx, [40, 9, 39, 20, 31, 13], true);
      ctx.fill();
    },
  },
  rocket: {
    label: 'Rakéta',
    hint: 'messzire repül, nagyot robban – megmarad, amíg másik fegyvert nem veszel fel',
    color: '#5a6672',
    icon: (ctx) => {
      ctx.save();
      ctx.translate(24, 24);
      ctx.rotate(-Math.PI / 4);
      shell(ctx, 2, 0, 24, 8);
      ctx.fillStyle = '#e8c23a';
      path(ctx, [-10, -4, -17, -10, -12, -4], true);
      ctx.fill();
      path(ctx, [-10, 4, -17, 10, -12, 4], true);
      ctx.fill();
      ctx.fillStyle = '#ff8a2a';
      path(ctx, [-10, -3, -19, 0, -10, 3], true);
      ctx.fill();
      ctx.restore();
    },
  },
  laser: {
    label: 'Lézer',
    hint: 'azonnal célba érő sugár – megmarad, amíg másik fegyvert nem veszel fel',
    color: '#c01e5a',
    icon: (ctx) => {
      stroke(ctx, 5, '#ffb0c8');
      path(ctx, [9, 36, 33, 15]);
      ctx.stroke();
      stroke(ctx, 2);
      path(ctx, [9, 36, 33, 15]);
      ctx.stroke();
      // felvillanás a sugár végén
      stroke(ctx, 2.5);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI;
        path(ctx, [34 - Math.cos(a) * 7, 14 - Math.sin(a) * 7, 34 + Math.cos(a) * 7, 14 + Math.sin(a) * 7]);
        ctx.stroke();
      }
    },
  },
  oil: {
    label: 'Olajfolt',
    hint: 'E vagy jobb egérgomb: lerakás – aki ráhajt, megcsúszik',
    color: '#2c2c34',
    icon: (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(24, 9);
      ctx.bezierCurveTo(36, 24, 35, 38, 24, 38);
      ctx.bezierCurveTo(13, 38, 12, 24, 24, 9);
      ctx.fill();
      ctx.fillStyle = '#2c2c34';
      ctx.beginPath();
      ctx.arc(20.5, 29, 3, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  repair: {
    label: 'Javítókészlet',
    hint: '+50 életerő',
    color: '#2e9a4a',
    icon: (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(19.5, 11, 9, 26);
      ctx.fillRect(11, 19.5, 26, 9);
    },
  },
  speed: {
    label: 'Turbó',
    hint: 'nagyobb sebesség és gyorsulás',
    color: '#1e96c8',
    icon: (ctx) => {
      ctx.fillStyle = '#ffffff';
      path(ctx, [28, 8, 14, 27, 23, 27, 19, 40, 34, 20, 25, 20], true);
      ctx.fill();
    },
  },
  allTerrain: {
    label: 'Terepjáró lánctalp',
    hint: 'terepen sem lassulsz, olajon sem csúszol',
    color: '#6a7a2e',
    icon: (ctx) => {
      stroke(ctx, 3.5);
      ctx.beginPath();
      ctx.roundRect(9, 17, 30, 14, 7);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      for (const x of [16, 24, 32]) {
        ctx.beginPath();
        ctx.arc(x, 24, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  shield: {
    label: 'Pajzs',
    hint: 'egy találatot elnyel',
    color: '#2e5ec8',
    icon: (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(24, 9);
      ctx.lineTo(36, 14);
      ctx.bezierCurveTo(36, 28, 31, 35, 24, 39);
      ctx.bezierCurveTo(17, 35, 12, 28, 12, 14);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#2e5ec8';
      ctx.fillRect(22.5, 15, 3, 17);
      ctx.fillRect(16, 21, 16, 3);
    },
  },
  invulnerable: {
    label: 'Sebezhetetlenség',
    hint: 'semmi nem sebez',
    color: '#d8a81e',
    icon: (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 15 : 6.5;
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
        ctx.lineTo(24 + Math.cos(a) * r, 25 + Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
    },
  },
  radar: {
    label: 'Radar',
    hint: 'a térképen látszanak a felvehető tárgyak',
    color: '#2a9a5a',
    icon: (ctx) => {
      stroke(ctx, 3);
      for (const r of [7, 13]) {
        ctx.beginPath();
        ctx.arc(24, 24, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      path(ctx, [24, 24, 34, 13]);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(24, 24, 2.6, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  turret: {
    label: 'Telepíthető ágyú',
    hint: 'Q: lerakás a tank mögé – magától lő a közeli ellenségre',
    color: '#4a6a3a',
    icon: (ctx) => {
      // háromlábú talp, rajta rövid csövű ágyú
      stroke(ctx, 3.5);
      path(ctx, [24, 28, 13, 39]);
      ctx.stroke();
      path(ctx, [24, 28, 35, 39]);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(22, 25, 7.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(22, 25);
      ctx.rotate(-0.5);
      ctx.fillRect(4, -3, 18, 6);
      ctx.restore();
    },
  },
};

export const pickupTexture = (kind: PickupKind): string => `pickup-${kind}`;
