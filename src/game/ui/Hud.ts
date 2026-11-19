// DOM-alapú HUD a játékvászon fölött: utcanév, a hivatal iránya, minitérkép,
// a tájékozódási pontok feliratai és az OSM-forrásmegjelölés.
// A DOM-ot csak akkor írja, ha a megjelenítendő érték tényleg változott.

import type { GameMap } from '../maps/GameMap';
import { renderMap } from '../maps/raster';
import { PICKUP_STYLE } from '../entities/pickupStyle';
import type { PickupState, TankState } from '../sim/world';

/** A térképkép felbontása: pixel / méter. */
const MINI_SCALE = 0.3;
/** A sarokban lévő kis térkép mérete pixelben; a tank környékét mutatja. */
const MINI_VIEW = 220;

const POI_LABEL: Record<string, string> = {
  place_of_worship: 'Templom',
  post_office: 'Posta',
  police: 'Rendőrség',
  pharmacy: 'Gyógyszertár',
  doctors: 'Orvosi rendelő',
  dentist: 'Fogorvos',
  bank: 'Bank',
  school: 'Iskola',
  kindergarten: 'Óvoda',
  library: 'Könyvtár',
  community_centre: 'Művelődési ház',
  fire_station: 'Tűzoltóság',
  memorial: 'Emlékmű',
};
/** Ezeknél a típusoknál az OSM-ben szereplő (intézmény)név jelenik meg. */
const USE_OSM_NAME = new Set(['place_of_worship', 'school', 'kindergarten', 'library', 'community_centre']);

const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];

interface Label {
  el: HTMLDivElement;
  x: number;
  y: number;
  visible: boolean;
  left: number;
  top: number;
}

interface StreetLabel {
  name: string;
  x: number;
  y: number;
  angle: number;
}

/**
 * Utcánként egy felirat egy egyenes szakasz közepére, a szakasz irányában.
 * A hosszabb szakaszok élveznek elsőbbséget; ha a hely már foglalt, az utca
 * egy másik szakaszára kerül a név.
 */
function streetLabels(map: GameMap): StreetLabel[] {
  const byName = new Map<string, (StreetLabel & { len: number })[]>();
  for (const road of map.data.roads) {
    if (!road.name || road.kind === 'footway' || road.kind === 'path') continue;
    const p = road.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2] - p[i];
      const dy = p[i + 3] - p[i + 1];
      let angle = Math.atan2(dy, dx);
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      const list = byName.get(road.name) ?? [];
      list.push({ name: road.name, x: (p[i] + p[i + 2]) / 2, y: (p[i + 1] + p[i + 3]) / 2, angle, len: Math.hypot(dx, dy) });
      byName.set(road.name, list);
    }
  }
  const streets = [...byName.values()].map((list) => list.sort((a, b) => b.len - a.len));
  streets.sort((a, b) => b[0].len - a[0].len);
  const placed: StreetLabel[] = [];
  const minGap = 70; // méter
  for (const candidates of streets) {
    const free = candidates.find((cand) => placed.every((q) => Math.hypot(q.x - cand.x, q.y - cand.y) >= minGap));
    placed.push(free ?? candidates[0]);
  }
  return placed;
}

/** A képkockánként átadott állapot; a hívó ugyanazt az objektumot használhatja újra. */
export interface HudFrame {
  /** a tank helye méterben és a test iránya */
  x: number;
  y: number;
  angle: number;
  /** a kamera látómezeje világpixelben */
  viewX: number;
  viewY: number;
  viewW: number;
  viewH: number;
  /** a játékvászon helye és mérete az ablakban (CSS pixel) */
  canvasLeft: number;
  canvasTop: number;
  canvasWidth: number;
  canvasHeight: number;
  /** a pálya összes tankja (a botok a térképen piros pontként látszanak) */
  tanks: readonly TankState[];
  /** a felvehető tárgyak, ha a radar aktív; különben null */
  pickups: readonly PickupState[] | null;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Hiányzó HUD-elem: #${id}`);
  return node as T;
}

export class Hud {
  private readonly street = el<HTMLDivElement>('hud-street');
  private readonly townhall = el<HTMLDivElement>('hud-townhall');
  private readonly miniPanel = el<HTMLDivElement>('hud-minimap');
  private readonly mini = el<HTMLCanvasElement>('minimap');
  private readonly help = el<HTMLDivElement>('hud-help');
  private readonly miniCtx: CanvasRenderingContext2D;
  private readonly miniBase: HTMLCanvasElement;
  private readonly labels: Label[] = [];
  private readonly streets: StreetLabel[];
  private frame = 0;
  private bigMap = false;
  // az utoljára kiírt értékek
  private streetText = '';
  private townhallText = '';
  private miniX = NaN;
  private miniY = NaN;
  private miniAngle = NaN;
  private miniDirty = true;
  private readonly healthFill = el<HTMLDivElement>('hud-health-fill');
  private readonly healthText = el<HTMLSpanElement>('hud-health-text');
  private readonly score = el<HTMLDivElement>('hud-score');
  private readonly effects = el<HTMLDivElement>('hud-effects');
  private readonly toastBox = el<HTMLDivElement>('hud-toast');
  private readonly botCount = el<HTMLSpanElement>('hud-bots-count');
  private statusKey = '';
  private effectsKey = '';
  private toastTimer = 0;

  constructor(
    private readonly map: GameMap,
    private readonly ppm: number,
  ) {
    // a teljes pálya egyszerűsített képe, egyszer kirajzolva
    const w = Math.round(map.width * MINI_SCALE);
    const h = Math.round(map.height * MINI_SCALE);
    this.miniBase = document.createElement('canvas');
    this.miniBase.width = w;
    this.miniBase.height = h;
    const buf = new Uint32Array(w * h);
    renderMap(map, { buf, w, h, ox: 0, oy: 0, scale: MINI_SCALE, detail: false });
    this.miniBase.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer), w, h), 0, 0);
    this.miniCtx = this.mini.getContext('2d')!;
    this.resizeMinimap();

    this.streets = streetLabels(map);
    if (map.data.meta.extraAttribution) el<HTMLSpanElement>('hud-extra-attribution').textContent = ` · ${map.data.meta.extraAttribution}`;

    const layer = el<HTMLDivElement>('labels');
    layer.replaceChildren();
    const th = map.data.townhall;
    // a felirat az épület mellé kerül, hogy ne takarja a tetőt és a teret
    this.addLabel(layer, 'POLGÁRMESTERI HIVATAL', th.x - 13, th.y + 4, true);
    for (const poi of map.data.pois) {
      if (poi.kind === 'townhall') continue;
      const generic = POI_LABEL[poi.kind];
      if (!generic) continue;
      const text = USE_OSM_NAME.has(poi.kind) && poi.name ? poi.name : generic;
      this.addLabel(layer, text, poi.x, poi.y - 4, false);
    }
  }

  private addLabel(layer: HTMLElement, text: string, x: number, y: number, townhall: boolean): void {
    const node = document.createElement('div');
    node.className = townhall ? 'world-label townhall' : 'world-label';
    node.textContent = text;
    node.style.display = 'none';
    layer.appendChild(node);
    this.labels.push({ el: node, x, y, visible: false, left: NaN, top: NaN });
  }

  /** A − és + gomb a botok számát állítja; a visszahívás a változás irányát kapja (−1 vagy +1). */
  onBotChange(callback: (delta: number) => void): void {
    el<HTMLSpanElement>('hud-bots-minus').addEventListener('click', () => callback(-1));
    el<HTMLSpanElement>('hud-bots-plus').addEventListener('click', () => callback(1));
  }

  setBotCount(count: number): void {
    this.botCount.textContent = String(count);
    this.miniDirty = true;
  }

  /** Rövid értesítés a képernyő tetején (pl. felvett tárgy). */
  toast(text: string): void {
    this.toastBox.textContent = text;
    this.toastBox.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastBox.classList.remove('show'), 2600);
  }

  /** Életerő és eredmény; respawn > 0: a tank ki van lőve, ennyi mp múlva éled újra. */
  setStatus(hp: number, maxHp: number, kills: number, deaths: number, respawn: number): void {
    const key = `${Math.ceil(hp)}|${kills}|${deaths}|${Math.ceil(respawn)}`;
    if (key === this.statusKey) return;
    this.statusKey = key;
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    this.healthFill.style.width = `${Math.round(ratio * 100)}%`;
    this.healthFill.style.background = ratio > 0.5 ? '#5ad24a' : ratio > 0.25 ? '#e8c23a' : '#e0483a';
    this.healthText.textContent = respawn > 0 ? `újraéledés: ${Math.ceil(respawn)} mp` : `${Math.ceil(hp)} / ${maxHp}`;
    this.score.textContent = `Kilőtt ellenfél: ${kills} · Kilőttek: ${deaths}`;
  }

  /** Az aktív bónuszok listája (soronként egy). */
  setEffects(lines: readonly string[]): void {
    const key = lines.join('\n');
    if (key === this.effectsKey) return;
    this.effectsKey = key;
    this.effects.classList.toggle('hidden', lines.length === 0);
    this.effects.textContent = key;
  }

  hideLoading(): void {
    el<HTMLDivElement>('loading').classList.add('hidden');
  }

  setQualityText(text: string): void {
    el<HTMLSpanElement>('hud-quality').textContent = text;
  }

  toggleMap(): void {
    this.bigMap = this.miniPanel.classList.toggle('big');
    this.resizeMinimap();
    this.frame = 0; // azonnali újrarajzolás
  }

  /** Kis nézetben a vászon a tank környékét mutatja, nagy nézetben az egész pályát. */
  private resizeMinimap(): void {
    this.mini.width = this.bigMap ? this.miniBase.width : MINI_VIEW;
    this.mini.height = this.bigMap ? this.miniBase.height : MINI_VIEW;
    this.miniCtx.imageSmoothingEnabled = false;
    this.miniDirty = true;
  }

  toggleHelp(): void {
    this.help.classList.toggle('hidden');
  }

  update(f: HudFrame): void {
    this.updateLabels(f);
    if (this.frame++ % 6 !== 0) return;

    const street = this.map.streetNameAt(f.x, f.y) || '(terep)';
    if (street !== this.streetText) {
      this.streetText = street;
      this.street.textContent = street;
    }

    const th = this.map.data.townhall;
    const dx = th.x - f.x;
    const dy = th.y - f.y;
    const dist = Math.hypot(dx, dy);
    const dir = ARROWS[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];
    const text = dist < 30 ? 'Hivatal: itt vagy ★' : `Hivatal: ${Math.round(dist)} m ${dir}`;
    if (text !== this.townhallText) {
      this.townhallText = text;
      this.townhall.textContent = text;
    }

    // a minitérképet csak akkor rajzoljuk újra, ha a tank érdemben elmozdult vagy elfordult
    const moved = !(Math.abs(f.x - this.miniX) < 0.5 && Math.abs(f.y - this.miniY) < 0.5 && Math.abs(f.angle - this.miniAngle) < 0.03);
    // ha vannak ellenfelek vagy aktív a radar, a térkép folyamatosan frissül
    if (f.tanks.length > 1 || f.pickups) this.miniDirty = true;
    if (moved || this.miniDirty) {
      this.miniX = f.x;
      this.miniY = f.y;
      this.miniAngle = f.angle;
      this.miniDirty = false;
      this.drawMinimap(f);
    }
  }

  private updateLabels(f: HudFrame): void {
    const k = f.canvasWidth / f.viewW;
    for (const label of this.labels) {
      const sx = (label.x * this.ppm - f.viewX) * k;
      const sy = (label.y * this.ppm - f.viewY) * k;
      const visible = sx > -60 && sy > 0 && sx < f.canvasWidth + 60 && sy < f.canvasHeight + 20;
      if (visible !== label.visible) {
        label.visible = visible;
        label.el.style.display = visible ? 'block' : 'none';
      }
      if (!visible) continue;
      const left = Math.round(f.canvasLeft + sx);
      const top = Math.round(f.canvasTop + sy);
      if (left !== label.left || top !== label.top) {
        label.left = left;
        label.top = top;
        // transform: nem vált ki elrendezés-újraszámítást
        label.el.style.transform = `translate(${left}px, ${top}px) translate(-50%, -100%)`;
      }
    }
  }

  private drawMinimap(f: HudFrame): void {
    const ctx = this.miniCtx;
    const s = MINI_SCALE;
    // kis nézetben a kép a tank köré igazodik (a pálya szélén megáll)
    let ox = 0;
    let oy = 0;
    if (!this.bigMap) {
      ox = Math.max(0, Math.min(this.miniBase.width - MINI_VIEW, Math.round(f.x * s - MINI_VIEW / 2)));
      oy = Math.max(0, Math.min(this.miniBase.height - MINI_VIEW, Math.round(f.y * s - MINI_VIEW / 2)));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.miniBase, -ox, -oy);
    ctx.translate(-ox, -oy);

    // nagy térképen az utcanevek is látszanak
    if (this.bigMap) {
      ctx.font = 'bold 11px Consolas, "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      for (const st of this.streets) {
        ctx.save();
        ctx.translate(st.x * s, st.y * s);
        ctx.rotate(st.angle);
        ctx.strokeStyle = '#101418';
        ctx.lineWidth = 3;
        ctx.strokeText(st.name, 0, 0);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(st.name, 0, 0);
        ctx.restore();
      }
    }

    // a kamera látómezeje
    const m = s / this.ppm;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(f.viewX * m, f.viewY * m, f.viewW * m, f.viewH * m);

    // a hivatal jelölője
    const th = this.map.data.townhall;
    ctx.fillStyle = '#101418';
    ctx.fillRect(th.x * s - 8, th.y * s - 8, 16, 16);
    ctx.fillStyle = '#ffd84a';
    ctx.fillRect(th.x * s - 6, th.y * s - 6, 12, 12);
    ctx.fillStyle = '#d03a40';
    ctx.fillRect(th.x * s - 3, th.y * s - 3, 6, 6);

    // radar: a felvehető tárgyak a saját színükkel
    if (f.pickups) {
      for (const p of f.pickups) {
        ctx.fillStyle = '#101418';
        ctx.fillRect(p.x * s - 4, p.y * s - 4, 8, 8);
        ctx.fillStyle = PICKUP_STYLE[p.kind].color;
        ctx.fillRect(p.x * s - 3, p.y * s - 3, 6, 6);
        ctx.fillStyle = '#fff6d0';
        ctx.fillRect(p.x * s - 1, p.y * s - 1, 2, 2);
      }
    }

    // ellenséges tankok: piros pont
    for (const t of f.tanks) {
      if (!t.bot || !t.alive) continue;
      ctx.fillStyle = '#101418';
      ctx.fillRect(t.x * s - 5, t.y * s - 5, 10, 10);
      ctx.fillStyle = '#ff4a3a';
      ctx.fillRect(t.x * s - 3.5, t.y * s - 3.5, 7, 7);
    }

    // a tank: irányba forgatott nyíl
    ctx.save();
    ctx.translate(f.x * s, f.y * s);
    ctx.rotate(f.angle);
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-7, -7);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#101418';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
}
