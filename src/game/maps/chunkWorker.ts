// Háttérszál (Web Worker): a térképdarabok kirajzolása itt történik, hogy a
// játék fő szála – a szimuláció és a megjelenítés – közben ne akadjon meg.
// A kész pixelpuffereket másolás nélkül (transfer) adja vissza.

import { GameMap } from './GameMap';
import { renderCanopy, renderMap } from './raster';
import type { MapData } from './types';

export type ChunkRequest =
  | { type: 'init'; data: MapData; ppm: number; size: number }
  | { type: 'render'; key: number; cx: number; cy: number };

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
    ppm = msg.ppm;
    size = msg.size;
    return;
  }
  if (!map) return;
  const started = performance.now();
  const target = { w: size, h: size, ox: msg.cx * size, oy: msg.cy * size, scale: ppm, detail: true };

  const ground = new Uint32Array(size * size);
  renderMap(map, { ...target, buf: ground });
  const canopyBuf = new Uint32Array(size * size);
  const hasCanopy = renderCanopy(map, { ...target, buf: canopyBuf });

  const reply: ChunkReply = {
    key: msg.key,
    cx: msg.cx,
    cy: msg.cy,
    ground: ground.buffer,
    canopy: hasCanopy ? canopyBuf.buffer : null,
    ms: performance.now() - started,
  };
  scope.postMessage(reply, hasCanopy ? [ground.buffer, canopyBuf.buffer] : [ground.buffer]);
};
