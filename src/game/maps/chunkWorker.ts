// Háttérszál (Web Worker): a térképdarabok kirajzolása itt történik, hogy a
// játék fő szála – a szimuláció és a megjelenítés – közben ne akadjon meg.
// A kész pixelpuffereket másolás nélkül (transfer) adja vissza.

import { GameMap } from './GameMap';
import { renderChunk, setSupersample } from './chunkRender';
import type { Weather } from '../sim/world';
import type { MapData } from './types';

export type ChunkRequest =
  | { type: 'init'; data: MapData; ppm: number; size: number; aa: number; weather: Weather; area: { minX: number; minY: number; maxX: number; maxY: number } | null }
  | { type: 'render'; key: number; cx: number; cy: number }
  // a pálya változó állapota: a fő szál minden változást elküld, mielőtt újrarajzolást kér
  | { type: 'felled'; index: number; angle: number }
  | { type: 'scar'; x: number; y: number; r: number }
  | { type: 'collapse'; index: number }
  | { type: 'reset' };

export interface ChunkReply {
  key: number;
  cx: number;
  cy: number;
  /** a talajréteg RGBA pixelei */
  ground: ArrayBuffer;
  /** a lombréteg RGBA pixelei, vagy null, ha a darabon nincs lomb */
  canopy: ArrayBuffer | null;
  /** a rajzolás ideje ms-ban (diagnosztikához) */
  ms: number;
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<ChunkRequest>) => void) | null;
  postMessage(message: ChunkReply, transfer: Transferable[]): void;
};

let map: GameMap | null = null;
let ppm = 12;
let size = 256;

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    map = new GameMap(msg.data, { collision: false });
    map.weather = msg.weather;
    setSupersample(msg.aa);
    map.bounds = msg.area;
    ppm = msg.ppm;
    size = msg.size;
    return;
  }
  if (!map) return;
  if (msg.type === 'felled') {
    map.fellables.fell(msg.index, msg.angle);
    return;
  }
  if (msg.type === 'scar') {
    map.addScar(msg.x, msg.y, msg.r);
    return;
  }
  if (msg.type === 'collapse') {
    map.collapse(msg.index);
    return;
  }
  if (msg.type === 'reset') {
    map.resetDamage();
    return;
  }
  const started = performance.now();
  const { ground, canopy } = renderChunk(map, msg.cx, msg.cy, size, ppm);

  const reply: ChunkReply = {
    key: msg.key,
    cx: msg.cx,
    cy: msg.cy,
    ground: ground.buffer as ArrayBuffer,
    canopy: canopy ? (canopy.buffer as ArrayBuffer) : null,
    ms: performance.now() - started,
  };
  scope.postMessage(reply, canopy ? [reply.ground, canopy.buffer as ArrayBuffer] : [reply.ground]);
};
