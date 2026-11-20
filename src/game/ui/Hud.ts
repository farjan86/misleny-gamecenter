// DOM-alapú felület a játékvászon fölött. Játék közben csak a térkép és az
// információ gombja látszik állandóan; az irányítás, a tank állapota és a
// forrásmegjelölés az információs panelen van. Emellett a tájékozódási pontok
// feliratai és a rövid értesítések tartoznak ide.
// A DOM-ot csak akkor írja, ha a megjelenítendő érték tényleg változott.

import type { GameMap } from '../maps/GameMap';
import { renderMap } from '../maps/raster';
import { PICKUP_STYLE } from '../entities/pickupStyle';
import { SMOKE, STRIKE, type SmokeState } from '../sim/gadgets';
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

/** A tanknál lévő fegyver, képesség vagy aktív tárgy a képernyő tetején. */
export interface LoadoutItem {
  /** az ikon képe (adat-URL); üres, ha nincs ikon (pl. a szint) */
  icon: string;
  label: string;
  /** a hátralévő mennyiség kiírva (pl. „18 lövés”, „9 mp”, „×2”), vagy üres */
  count: string;
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
  /** az ismert tankok: a botok piros, a többi játékos narancs pontként látszik a térképen */
  tanks: readonly TankState[];
  /** a saját (követett) tank azonosítója */
  focusId: number;
  /** a felvehető tárgyak, ha a radar aktív; különben null */
  pickups: readonly PickupState[] | null;
  /** a füstfelhők: a bennük lévő ellenfél a térképen sem látszik */
  smokes: readonly SmokeState[];
  /** külön jelek a térképen: bosszú (aki kilőtt), szupertárgy (érkezik / kint van), tüzérségi csapás */
  marks: readonly MapMark[];
}

export interface MapMark {
  kind: 'revenge' | 'super' | 'superSoon' | 'strike' | 'workshop';
  x: number;
  y: number;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Hiányzó HUD-elem: #${id}`);
  return node as T;
}

export class Hud {
  private readonly miniPanel = el<HTMLDivElement>('hud-minimap');
  private readonly mini = el<HTMLCanvasElement>('minimap');
  private readonly info = el<HTMLDivElement>('hud-info');
  private readonly infoBody = el<HTMLDivElement>('hud-info-body');
  private readonly miniCtx: CanvasRenderingContext2D;
  private readonly miniBase: HTMLCanvasElement;
  /** a térképképnek az a része, amely a játéktérhez tartozik (pixel): csak ez látszik */
  private readonly crop: { x: number; y: number; w: number; h: number };
  private readonly labels: Label[] = [];
  private readonly streets: StreetLabel[];
  private frame = 0;
  private bigMap = false;
  private miniX = NaN;
  private miniY = NaN;
  private miniAngle = NaN;
  private miniDirty = true;
  private readonly toastBox = el<HTMLDivElement>('hud-toast');
  private readonly menuButton = el<HTMLDivElement>('hud-menu-button');
  private readonly menuList = el<HTMLDivElement>('hud-menu-list');
  private readonly menuConfirm = el<HTMLDivElement>('hud-menu-confirm');
  private leave: () => void = () => undefined;
  private readonly feedBox = el<HTMLDivElement>('hud-feed');
  private mapClick: ((x: number, y: number) => void) | null = null;
  private aiming = false;
  private readonly clock = el<HTMLDivElement>('hud-clock');
  private readonly clockTime = el<HTMLDivElement>('hud-clock-time');
  private readonly clockScore = el<HTMLDivElement>('hud-clock-score');
  private readonly scores = el<HTMLDivElement>('hud-scores');
  private scoresKey = '';
  /** az órára kattintva a tábla kint marad (a billentyű elengedése nem rejti el) */
  private scoresPinned = false;
  private scoresHeld = false;
  private infoKey = '';
  private readonly loadout = el<HTMLDivElement>('hud-loadout');
  private loadoutKey = '';
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
    const area = map.bounds ?? { minX: 0, minY: 0, maxX: map.width, maxY: map.height };
    this.crop = {
      x: Math.round(area.minX * MINI_SCALE),
      y: Math.round(area.minY * MINI_SCALE),
      w: Math.round((area.maxX - area.minX) * MINI_SCALE),
      h: Math.round((area.maxY - area.minY) * MINI_SCALE),
    };
    this.miniCtx = this.mini.getContext('2d')!;
    this.resizeMinimap();
    window.addEventListener('resize', () => this.resizeMinimap());

    this.streets = streetLabels(map);
    el<HTMLDivElement>('hud').classList.remove('hidden');
    // lenyitható menü: billentyűk és információ, kilépés (megerősítéssel)
    this.menuButton.onclick = () => this.toggleMenu();
    el<HTMLSpanElement>('hud-menu-keys').onclick = () => {
      this.toggleMenu(false);
      if (!this.infoOpen) this.toggleInfo();
    };
    el<HTMLSpanElement>('hud-menu-leave').onclick = () => this.menuConfirm.classList.remove('hidden');
    el<HTMLSpanElement>('hud-menu-no').onclick = () => this.menuConfirm.classList.add('hidden');
    el<HTMLSpanElement>('hud-menu-yes').onclick = () => this.leave();
    el<HTMLSpanElement>('hud-info-close').onclick = () => this.toggleInfo();
    // nagy térképen (ha van kérhető csapás) a kattintás helye a pályán
    this.mini.addEventListener('click', (ev) => {
      if (!this.bigMap || !this.aiming || !this.mapClick) return;
      const rect = this.mini.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * this.mini.width;
      const py = ((ev.clientY - rect.top) / rect.height) * this.mini.height;
      this.mapClick((this.crop.x + px) / MINI_SCALE, (this.crop.y + py) / MINI_SCALE);
    });
    this.clock.onclick = () => {
      this.scoresPinned = !this.scoresPinned;
      this.syncScores();
    };
    this.scores.onclick = () => {
      this.scoresPinned = false;
      this.syncScores();
    };

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

  /** A nagy térképre kattintás kezelője (tüzérségi csapás kérése a pálya adott pontjára). */
  onMapClick(callback: (x: number, y: number) => void): void {
    this.mapClick = callback;
  }

  /** Kattintható-e most a nagy térkép (van kérhető csapás): ilyenkor célkereszt a kurzor. */
  setAiming(aiming: boolean): void {
    if (aiming === this.aiming) return;
    this.aiming = aiming;
    this.miniPanel.classList.toggle('aim', aiming);
  }

  get mapOpen(): boolean {
    return this.bigMap;
  }

  /** Új sor a kilövési értesítőbe (HTML); néhány másodperc múlva elhalványul. */
  feed(html: string): void {
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.innerHTML = html;
    this.feedBox.appendChild(item);
    while (this.feedBox.children.length > 5) this.feedBox.firstElementChild?.remove();
    window.setTimeout(() => item.classList.add('old'), 5200);
    window.setTimeout(() => item.remove(), 5900);
  }

  /** Az eredménytábla megjelenítése, amíg a billentyűje nyomva van. */
  holdScores(held: boolean): void {
    this.scoresHeld = held;
    this.syncScores();
  }

  get scoresOpen(): boolean {
    return this.scoresHeld || this.scoresPinned;
  }

  private syncScores(): void {
    this.scores.classList.toggle('hidden', !this.scoresOpen);
    this.scores.style.pointerEvents = this.scoresPinned ? 'auto' : 'none';
  }

  /** Az eredménytábla tartalma (HTML); csak változáskor íródik a dokumentumba. */
  setScores(html: string): void {
    if (html === this.scoresKey) return;
    this.scoresKey = html;
    this.scores.innerHTML = html;
  }

  /** A visszaszámláló óra (perc:másodperc) és alatta az állás; az utolsó fél percben pirosan villog. */
  setClock(seconds: number, score: string): void {
    const s = Math.max(0, Math.ceil(seconds));
    this.clockTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    this.clockScore.textContent = score;
    this.clock.classList.toggle('ending', s <= 30);
  }

  toast(text: string): void {
    this.toastBox.textContent = text;
    this.toastBox.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastBox.classList.remove('show'), 2600);
  }

  /**
   * Ami éppen a tanknál van (fegyver, képességek, aktív tárgyak): ikon, név és
   * – ha van – a hátralévő mennyiség. Csak változáskor írja a DOM-ot.
   */
  setLoadout(items: readonly LoadoutItem[]): void {
    const key = items.map((i) => `${i.label}|${i.count}`).join(';');
    if (key === this.loadoutKey) return;
    this.loadoutKey = key;
    this.loadout.replaceChildren(
      ...items.map((item) => {
        const box = document.createElement('div');
        box.className = item.icon ? 'loadout-item' : 'loadout-item level';
        if (item.icon) {
          const icon = document.createElement('img');
          icon.src = item.icon;
          icon.alt = '';
          box.append(icon);
        }
        const label = document.createElement('span');
        label.textContent = item.label;
        box.append(label);
        if (item.count) {
          const count = document.createElement('span');
          count.className = 'count';
          count.textContent = item.count;
          box.append(count);
        }
        return box;
      }),
    );
  }

  /** A kilépés gombjai: a menüben (megerősítéssel) és az információs panelen. */
  onLeave(callback: () => void): void {
    this.leave = callback;
    el<HTMLSpanElement>('hud-info-leave').onclick = callback;
  }

  get menuOpen(): boolean {
    return !this.menuList.classList.contains('hidden');
  }

  /** A bal felső menü le- és felnyitása (`open` nélkül: váltás). Felnyitáskor a megerősítő kérdés eltűnik. */
  toggleMenu(open = !this.menuOpen): void {
    this.menuList.classList.toggle('hidden', !open);
    this.menuButton.classList.toggle('open', open);
    this.menuConfirm.classList.add('hidden');
  }

  get infoOpen(): boolean {
    return !this.info.classList.contains('hidden');
  }

  toggleInfo(): void {
    this.info.classList.toggle('hidden');
  }

  /** Az információs panel tartalma (HTML); csak akkor írja a DOM-ot, ha nyitva van és változott. */
  setInfo(html: string): void {
    if (!this.infoOpen || html === this.infoKey) return;
    this.infoKey = html;
    this.infoBody.innerHTML = html;
  }

  hideLoading(): void {
    el<HTMLDivElement>('loading').classList.add('hidden');
  }

  toggleMap(): void {
    this.bigMap = this.miniPanel.classList.toggle('big');
    this.resizeMinimap();
    this.frame = 0; // azonnali újrarajzolás
  }

  /** Kis nézetben a vászon a tank környékét mutatja, nagy nézetben az egész pályát. */
  private resizeMinimap(): void {
    const { crop } = this;
    this.mini.width = this.bigMap ? crop.w : Math.min(MINI_VIEW, crop.w);
    this.mini.height = this.bigMap ? crop.h : Math.min(MINI_VIEW, crop.h);
    // nagy nézetben a játéktér képe kitölti a képernyőt (a képarány megtartásával)
    const zoom = this.bigMap ? Math.min((window.innerWidth * 0.9) / crop.w, (window.innerHeight * 0.86) / crop.h, 5) : 1;
    this.mini.style.width = `${Math.round(this.mini.width * zoom)}px`;
    this.mini.style.height = `${Math.round(this.mini.height * zoom)}px`;
    this.miniCtx.imageSmoothingEnabled = false;
    this.miniDirty = true;
  }

  update(f: HudFrame): void {
    this.updateLabels(f);
    if (this.frame++ % 6 !== 0) return;

    // a minitérképet csak akkor rajzoljuk újra, ha a tank érdemben elmozdult vagy elfordult
    const moved = !(Math.abs(f.x - this.miniX) < 0.5 && Math.abs(f.y - this.miniY) < 0.5 && Math.abs(f.angle - this.miniAngle) < 0.03);
    // ha vannak ellenfelek vagy aktív a radar, a térkép folyamatosan frissül
    if (f.tanks.length > 1 || f.pickups || f.marks.length) this.miniDirty = true;
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
    const { crop } = this;
    let ox = crop.x;
    let oy = crop.y;
    if (!this.bigMap) {
      ox = Math.max(crop.x, Math.min(crop.x + crop.w - this.mini.width, Math.round(f.x * s - this.mini.width / 2)));
      oy = Math.max(crop.y, Math.min(crop.y + crop.h - this.mini.height, Math.round(f.y * s - this.mini.height / 2)));
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

    // külön jelek: tüzérségi csapás köre, szupertárgy, bosszú
    const blink = Math.floor(performance.now() / 300) % 2 === 0;
    for (const mark of f.marks) {
      const mx = mark.x * s;
      const my = mark.y * s;
      if (mark.kind === 'workshop') {
        // javítóműhely: zöld négyzet fehér kereszttel
        ctx.fillStyle = '#101418';
        ctx.fillRect(mx - 8, my - 8, 16, 16);
        ctx.fillStyle = '#2ea050';
        ctx.fillRect(mx - 6.5, my - 6.5, 13, 13);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(mx - 1.5, my - 5, 3, 10);
        ctx.fillRect(mx - 5, my - 1.5, 10, 3);
      } else if (mark.kind === 'strike') {
        ctx.strokeStyle = blink ? '#ff3a2a' : '#ffd84a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(mx, my, STRIKE.spread * s, 0, Math.PI * 2);
        ctx.stroke();
      } else if (mark.kind === 'revenge') {
        ctx.strokeStyle = blink ? '#ff3a2a' : '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(mx - 8, my - 8, 16, 16);
      } else {
        // szupertárgy: lila rombusz arany szegéllyel (amíg csak bejelentve van, üres)
        ctx.beginPath();
        ctx.moveTo(mx, my - 10);
        ctx.lineTo(mx + 10, my);
        ctx.lineTo(mx, my + 10);
        ctx.lineTo(mx - 10, my);
        ctx.closePath();
        ctx.fillStyle = mark.kind === 'super' ? '#a040ff' : 'rgba(16,20,24,0.7)';
        ctx.fill();
        ctx.strokeStyle = blink ? '#ffd84a' : '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }

    // ellenséges tankok: piros pont (ami füstben van, az a térképen sem látszik)
    const hidden = (t: TankState): boolean => f.smokes.some((k) => Math.hypot(t.x - k.x, t.y - k.y) < SMOKE.radius);
    for (const t of f.tanks) {
      // az álcázott tank a térképen sem látszik
      if (!t.alive || t.id === f.focusId || t.cloak > 0 || (f.smokes.length > 0 && hidden(t))) continue;
      ctx.fillStyle = '#101418';
      ctx.fillRect(t.x * s - 4, t.y * s - 4, 8, 8);
      // a botok pirosak, a többi játékos narancssárga (nagyobb ponttal)
      ctx.fillStyle = t.bot ? '#ff4a3a' : '#ffb020';
      const r = t.bot ? 2.5 : 3.5;
      ctx.fillRect(t.x * s - r, t.y * s - r, r * 2, r * 2);
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
