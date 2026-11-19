// A játékjelenet: a szerveren futó meccs megjelenítése. A jelenet csak
// BEMENETET küld (a ClientWorld-ön keresztül), az állapotot a szervertől kapja:
// a tankokat, lövedékeket, tárgyakat a pillanatképekből, a hangokat, effekteket
// és a pálya változásait (kidőlt fa, összedőlt ház) az eseményekből rajzolja.

import Phaser from 'phaser';
import { FireLayer } from '../entities/FireLayer';
import { createGameTextures, GTEX, PICKUP_ICON_SIZE } from '../entities/gameTextures';
import { PICKUP_STYLE, pickupTexture } from '../entities/pickupStyle';
import { TankView } from '../entities/TankView';
import { createTextures, TEX } from '../entities/textures';
import { WeatherLayer } from '../entities/WeatherLayer';
import { ChunkLayer } from '../maps/ChunkLayer';
import type { GameMap } from '../maps/GameMap';
import { RoadLabelLayer } from '../maps/RoadLabelLayer';
import type { ClientWorld } from '../net/ClientWorld';
import { BASE_PPM } from '../quality';
import { ACTION_LABEL, ACTIONS, keysText, type Action, type KeyBindings } from '../settings';
import { OIL, PICKUP, TIMED_KINDS, type PickupKind } from '../sim/pickups';
import { BOOSTER, LEVEL, SIM_DT, TANK, tankMaxHp, type ShotKind, type SimEvent, type TankInput, type TankState } from '../sim/world';
import { Sfx } from '../systems/audio';
import { toggleFullscreen } from '../ui/fullscreen';
import { Hud, type HudFrame, type LoadoutItem } from '../ui/Hud';

/** Ha a térkép ennyi idő alatt sem készül el, a töltőképernyő akkor is eltűnik. */
const LOADING_TIMEOUT_MS = 8000;
/** A robbanás mérete a találat fajtája szerint. */
const BLAST: Record<ShotKind, number> = { shell: 1, heavy: 1.7, rocket: 2.4, laser: 0.45 };
/** A maradandó lövésnyom sugara méterben, a találat fajtája szerint. */
const SCAR: Record<ShotKind, number> = { shell: 1.1, heavy: 1.8, rocket: 2.6, laser: 0.45 };
/** A találattól kigyulladó háztető tüze: a láng fél szélessége (m) és az égés ideje (mp). */
const ROOF_FIRE: Record<ShotKind, { size: number; life: number }> = {
  shell: { size: 1.7, life: 24 },
  heavy: { size: 2.3, life: 34 },
  rocket: { size: 2.9, life: 42 },
  laser: { size: 1.2, life: 15 },
};
/** A kilőtt tank roncsa ennyi ideig ég (mp). */
const WRECK_FIRE = { size: 2.4, life: 45 };
/** Ennél messzebbi események hangja nem hallatszik (m). */
const HEARING = 140;
const WEATHER_LABEL = { day: 'nappal', rain: 'eső', night: 'este' } as const;

export interface GameSceneData {
  map: GameMap;
  ppm: number;
  world: ClientWorld;
  keys: KeyBindings;
  /** a játékos a „Kilépés a meccsből” gombra kattintott */
  onLeave: () => void;
}

export class GameScene extends Phaser.Scene {
  private map!: GameMap;
  /** világpixel / méter */
  private ppm = BASE_PPM;
  /** a sprite-ok méretaránya az alap részletességhez képest */
  private spriteScale = 1;
  private world!: ClientWorld;
  private bindings!: KeyBindings;
  private onLeave: () => void = () => undefined;
  private ground!: ChunkLayer;
  private fires!: FireLayer;
  private weather!: WeatherLayer;
  private roadLabels!: RoadLabelLayer;
  private hud!: Hud;
  private readonly sfx = new Sfx();
  /** a lenyomott billentyűk (KeyboardEvent.code) */
  private readonly down = new Set<string>();
  // a szerverállapot elemeinek megjelenítői, azonosító szerint
  private readonly tankViews = new Map<number, TankView>();
  private readonly bulletViews = new Map<number, Phaser.GameObjects.Image>();
  private readonly pickupViews = new Map<number, Phaser.GameObjects.Image>();
  private readonly oilViews = new Map<number, Phaser.GameObjects.Image>();
  /** a roncsok képei: test és torony */
  private readonly wreckViews = new Map<number, Phaser.GameObjects.Image[]>();
  /** újrahasznált effekt-sprite-ok */
  private readonly boomPool: Phaser.GameObjects.Sprite[] = [];
  private readonly flashPool: Phaser.GameObjects.Image[] = [];
  private readonly beamPool: Phaser.GameObjects.Image[] = [];
  private readonly smokePool: Phaser.GameObjects.Image[] = [];
  // képkockánként újrahasznált objektumok (ne keletkezzen fölösleges szemét)
  private readonly input_: TankInput = { throttle: 0, turn: 0, aim: null, fire: false, drop: false, boost: false };
  private readonly view = new Phaser.Geom.Rectangle();
  private readonly hudFrame: HudFrame = {
    x: 0, y: 0, angle: 0, viewX: 0, viewY: 0, viewW: 0, viewH: 0, canvasLeft: 0, canvasTop: 0, canvasWidth: 1, canvasHeight: 1,
    tanks: [], pickups: null, focusId: 0,
  };
  private canvasRectStale = true;
  private accumulator = 0;
  private pointerMoved = false;
  /** az olajfolt lerakását kérő leütés, amíg el nem megy a szervernek */
  private dropLatch = false;
  private ready = false;
  private startedAt = 0;
  private frame = 0;
  private camX = 0;
  private camY = 0;
  private wasOut = false;
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  /** a tárgyak ikonjai képként (adat-URL), a felső sáv számára */
  private readonly iconUrls = new Map<PickupKind, string>();
  private readonly loadout: LoadoutItem[] = [];

  constructor() {
    super('game');
  }

  init(data: GameSceneData): void {
    this.map = data.map;
    this.ppm = data.ppm;
    this.spriteScale = data.ppm / BASE_PPM;
    this.world = data.world;
    this.bindings = data.keys;
    this.onLeave = data.onLeave;
    this.startedAt = performance.now();
  }

  private listen(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.listeners.push([target, type, handler]);
  }

  create(): void {
    createTextures(this);
    createGameTextures(this);
    // A kamera csak a kijelölt játékteret járja be: ami azon kívül van, az nem látszik.
    const area = this.map.bounds ?? { minX: 0, minY: 0, maxX: this.map.width, maxY: this.map.height };
    this.cameras.main.setBounds(area.minX * this.ppm, area.minY * this.ppm, (area.maxX - area.minX) * this.ppm, (area.maxY - area.minY) * this.ppm);
    this.cameras.main.setRoundPixels(true);

    this.ground = new ChunkLayer(this, this.map, this.ppm);
    this.fires = new FireLayer(this, this.ppm);
    this.weather = new WeatherLayer(this, this.map, this.ppm, this.world.room.settings.weather);
    this.hud = new Hud(this.map, this.ppm);
    this.hud.onLeave(() => this.onLeave());
    this.roadLabels = new RoadLabelLayer(this, this.map, this.ppm);

    // A billentyűket közvetlenül a böngésző eseményeiből követjük, a beállított kiosztás szerint.
    this.listen(window, 'keydown', ((ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
      const action = this.actionOf(ev.code);
      if (action) ev.preventDefault();
      this.down.add(ev.code);
      if (ev.repeat) return;
      this.sfx.unlock();
      if (action === 'map') this.hud.toggleMap();
      else if (action === 'info') this.hud.toggleInfo();
      else if (action === 'fullscreen') toggleFullscreen();
      else if (action === 'oil') this.dropLatch = true;
    }) as EventListener);
    this.listen(window, 'keyup', ((ev: KeyboardEvent) => {
      this.down.delete(ev.code);
    }) as EventListener);
    // ha az ablak elveszti a fókuszt, a lenyomva maradt gombok ne ragadjanak be
    this.listen(window, 'blur', () => this.down.clear());
    this.input.on('pointerdown', () => this.sfx.unlock());
    this.input.on('pointermove', () => {
      this.pointerMoved = true;
    });
    this.input.mouse?.disableContextMenu();

    // a vászon helyét csak átméretezéskor olvassuk ki újra
    const stale = (): void => {
      this.canvasRectStale = true;
    };
    this.scale.on(Phaser.Scale.Events.RESIZE, stale);
    this.listen(window, 'resize', stale);
    this.listen(document, 'fullscreenchange', stale);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const [target, type, handler] of this.listeners) target.removeEventListener(type, handler);
    });

    const focus = this.world.focus;
    if (focus) {
      this.camX = focus.x * this.ppm;
      this.camY = focus.y * this.ppm;
      this.cameras.main.centerOn(this.camX, this.camY);
    }
    const s = this.world.room.settings;
    this.hud.toast(`${s.name} – ${s.lives} élet, ${WEATHER_LABEL[s.weather]}. Az utolsó életben maradó nyer!`);
  }

  private actionOf(code: string): Action | null {
    for (const action of ACTIONS) if (this.bindings[action].includes(code)) return action;
    return null;
  }

  private held(action: Action): boolean {
    for (const code of this.bindings[action]) if (this.down.has(code)) return true;
    return false;
  }

  private readInput(): TankInput {
    const input = this.input_;
    input.throttle = (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0);
    input.turn = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    const pointer = this.input.activePointer;
    input.aim = null;
    const own = this.world.own;
    if (this.pointerMoved && own) {
      pointer.updateWorldPoint(this.cameras.main);
      input.aim = Math.atan2(pointer.worldY - own.y * this.ppm, pointer.worldX - own.x * this.ppm);
    }
    input.fire = this.held('fire') || pointer.leftButtonDown();
    input.boost = this.held('boost');
    input.drop = this.dropLatch || pointer.rightButtonDown();
    return input;
  }

  update(time: number, deltaMs: number): void {
    this.frame++;
    const world = this.world;
    const seconds = time / 1000;
    const now = performance.now();

    // új szerverállapot érkezett: a többi tank interpolációja onnan indul, ahol éppen látszik
    if (world.fresh) {
      world.fresh = false;
      for (const [id, view] of this.tankViews) {
        const tank = world.tank(id);
        if (!tank) {
          view.destroy();
          this.tankViews.delete(id);
        } else if (id !== world.myId) view.rebase(tank);
      }
    }
    for (const ev of world.events) this.handleEvent(ev);
    world.events.length = 0;

    // rögzített lépésközű bemenet: minden lépés elmegy a szervernek, és a saját tankon azonnal le is játszódik
    this.accumulator = Math.min(this.accumulator + deltaMs / 1000, SIM_DT * 5);
    const ownView = this.tankViews.get(world.myId);
    while (this.accumulator >= SIM_DT) {
      const own = world.own;
      if (own && ownView) ownView.remember(own);
      world.input(this.readInput());
      this.dropLatch = false;
      this.accumulator -= SIM_DT;
    }

    const netAlpha = Math.max(0, Math.min(1, (now - world.snapAt) / world.snapInterval));
    this.syncTanks(this.accumulator / SIM_DT, netAlpha, seconds, this.view);
    this.syncBullets((now - world.snapAt) / 1000);
    if (world.listsChanged) this.syncOils();
    this.syncWrecks(this.view);

    const own = world.own;
    const focus = world.focus;
    this.sfx.engine(own && own.alive ? (Math.abs(own.speed) / TANK.maxSpeed) * (own.boosting ? 1.15 : 1) : 0);

    // a kamera a saját tankot követi (kiesés után egy másik játékosét); ha kilőtték, ott marad, ahol történt
    const focusView = focus ? this.tankViews.get(focus.id) : undefined;
    if (focus && focusView && focus.alive) {
      this.camX = focusView.px;
      this.camY = focusView.py;
      focusView.setCovered(this.map.underCanopy(focus.x, focus.y));
    }
    const cam = this.cameras.main;
    cam.centerOn(this.camX, this.camY);
    const view = this.view.setTo(cam.scrollX, cam.scrollY, cam.width, cam.height);
    // amíg a töltőképernyő látszik, a kész darabok átvétele több időt kaphat
    this.ground.update(view, this.ready ? 3 : 12);
    this.roadLabels.update(view);
    const dt = Math.min(0.1, deltaMs / 1000);
    this.fires.update(view, dt);
    this.weather.update(view, world.tanks, this.fires, dt);
    this.syncPickups(view, seconds);
    world.listsChanged = false;

    if (!this.ready && (this.ground.isReady(view) || performance.now() - this.startedAt > LOADING_TIMEOUT_MS)) {
      this.ready = true;
      this.hud.hideLoading();
    }
    this.updateHud(view);
  }

  private updateHud(view: Phaser.Geom.Rectangle): void {
    const world = this.world;
    const focus = world.focus;
    if (!focus) return;
    const f = this.hudFrame;
    if (this.canvasRectStale) {
      const rect = this.game.canvas.getBoundingClientRect();
      f.canvasLeft = rect.left;
      f.canvasTop = rect.top;
      f.canvasWidth = rect.width;
      f.canvasHeight = rect.height;
      this.canvasRectStale = false;
    }
    f.x = focus.x;
    f.y = focus.y;
    f.angle = focus.hullAngle;
    f.viewX = view.x;
    f.viewY = view.y;
    f.viewW = view.width;
    f.viewH = view.height;
    f.tanks = world.tanks;
    f.focusId = focus.id;
    const own = world.own;
    f.pickups = own && own.effects.radar > 0 ? world.pickups : null;
    this.hud.update(f);

    // a saját tank fölött: a gyorsító hőfoka és az életek
    if (own) this.tankViews.get(own.id)?.setOwnStatus(own.heat / BOOSTER.duration, own.overheated, own.lives);

    if (this.frame % 6 === 0) this.hud.setLoadout(this.loadoutOf(own));

    if (own?.out && !this.wasOut) {
      this.wasOut = true;
      this.hud.toast('Kiestél! Nézőként követed a játékot.');
    }
    if (this.frame % 20 === 0 && this.hud.infoOpen) this.hud.setInfo(this.infoHtml());
  }

  private iconUrl(kind: PickupKind): string {
    let url = this.iconUrls.get(kind);
    if (!url) {
      url = (this.textures.get(pickupTexture(kind)).getSourceImage() as HTMLCanvasElement).toDataURL();
      this.iconUrls.set(kind, url);
    }
    return url;
  }

  /** Ami éppen a tanknál van: a fegyver, a megmaradó képességek, majd a fogyó és az időre szóló tárgyak. */
  private loadoutOf(own: TankState | undefined): LoadoutItem[] {
    const items = this.loadout;
    items.length = 0;
    if (!own) return items;
    // a sáv elején mindig a tank szintje áll (ikon nélkül)
    items.push({ icon: '', label: `★ ${own.level}. szint`, count: own.level >= LEVEL.max ? 'max' : '' });
    if (!own.alive) return items;
    const add = (kind: PickupKind, count = ''): void => {
      items.push({ icon: this.iconUrl(kind), label: PICKUP_STYLE[kind].label, count });
    };
    if (own.weapon) add(own.weapon);
    if (own.ricochet) add('ricochet');
    if (own.tripleShots > 0) add('triple', `${own.tripleShots} lövés`);
    if (own.shield > 0) add('shield', `×${own.shield}`);
    if (own.oil > 0) add('oil', `×${own.oil}`);
    for (const kind of TIMED_KINDS) if (own.effects[kind] > 0) add(kind, `${Math.ceil(own.effects[kind])} mp`);
    return items;
  }

  /** Az információs panel tartalma: irányítás, a tank állapota, a játékosok, forrásmegjelölés. */
  private infoHtml(): string {
    const own = this.world.own;
    const s = this.world.room.settings;
    const rows = (pairs: [string, string][]): string => `<table>${pairs.map(([k, v]) => `<tr><td class="key">${k}</td><td>${v}</td></tr>`).join('')}</table>`;
    const controls: [string, string][] = ACTIONS.map((a) => [keysText(this.bindings, a), ACTION_LABEL[a]]);
    controls.splice(4, 0, ['Egér', 'célzás – bal gomb: lövés, jobb gomb: olajfolt']);
    const state: [string, string][] = [];
    if (own) {
      state.push(['Életerő', `${Math.ceil(own.hp)} / ${tankMaxHp(own)}`], ['Szint', String(own.level)], ['Életek', own.out ? 'kiestél' : String(own.lives)]);
      state.push(['Fegyver', own.weapon ? PICKUP_STYLE[own.weapon].label : 'alaplövedék']);
      const extras: string[] = [];
      if (own.ricochet) extras.push(PICKUP_STYLE.ricochet.label);
      if (own.tripleShots > 0) extras.push(`${PICKUP_STYLE.triple.label} (${own.tripleShots} lövés)`);
      for (const kind of TIMED_KINDS) if (own.effects[kind] > 0) extras.push(`${PICKUP_STYLE[kind].label} (${Math.ceil(own.effects[kind])} mp)`);
      if (own.shield > 0) extras.push(`${PICKUP_STYLE.shield.label} ×${own.shield}`);
      if (own.oil > 0) extras.push(`${PICKUP_STYLE.oil.label} ×${own.oil}`);
      if (extras.length) state.push(['Nálad van', extras.join(', ')]);
    }
    const players: [string, string][] = this.world.standings.map((p) => [escapeHtml(p.name), p.out ? 'kiesett' : `${p.lives} élet · ${p.kills} kilövés`]);
    const extra = this.map.data.meta.extraAttribution ? ` · ${this.map.data.meta.extraAttribution}` : '';
    return (
      `<h3>Irányítás</h3>${rows(controls)}` +
      `<h3>A tankod</h3>${rows(state)}` +
      `<h3>Játékosok – ${escapeHtml(s.name)}</h3>${rows(players)}` +
      `<p class="small">Időjárás: ${WEATHER_LABEL[s.weather]} · botok: ${this.world.room.plan.bots} · válaszidő: ${this.world.pingMs} ms<br />` +
      `Térképadat: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap közreműködők</a> (ODbL)${extra}</p>`
    );
  }

  /** A hang ereje a követett tanktól mért távolság szerint (0 = nem hallatszik). */
  private loudness(x: number, y: number): number {
    const focus = this.world.focus;
    if (!focus) return 0;
    const dist = Math.hypot(x - focus.x, y - focus.y);
    return dist >= HEARING ? 0 : 1 - dist / HEARING;
  }

  private handleEvent(ev: SimEvent): void {
    const ppm = this.ppm;
    const world = this.world;
    const myId = world.myId;
    const mine = 'tank' in ev && ev.tank === myId;
    switch (ev.type) {
      case 'shot': {
        const volume = mine ? 1 : this.loudness(ev.x, ev.y) * 0.7;
        if (volume > 0) {
          if (ev.kind === 'laser') this.sfx.laser(volume);
          else if (ev.kind === 'rocket') this.sfx.rocket(volume);
          else this.sfx.shot(volume);
        }
        if (ev.kind !== 'laser') {
          const flash = this.flashPool.pop() ?? this.add.image(0, 0, TEX.flash).setOrigin(0.15, 0.5).setScale(this.spriteScale).setDepth(12);
          flash.setPosition(ev.x * ppm, ev.y * ppm).setRotation(ev.angle).setVisible(true);
          this.time.delayedCall(70, () => {
            flash.setVisible(false);
            this.flashPool.push(flash);
          });
        }
        this.weather.flash(ev.x, ev.y, 9, 0.12);
        if (mine) this.cameras.main.shake(70, ev.kind === 'rocket' ? 0.003 : 0.0018);
        break;
      }
      case 'impact': {
        const volume = this.loudness(ev.x, ev.y);
        if (volume > 0 && ev.kind !== 'laser') this.sfx.explosion(Math.max(0.15, volume) * (ev.kind === 'shell' ? 1 : 1.3));
        this.boom(ev.x, ev.y, BLAST[ev.kind]);
        this.scar(ev.x, ev.y, SCAR[ev.kind]);
        this.weather.flash(ev.x, ev.y, 8 + BLAST[ev.kind] * 5, 0.3);
        // az eltalált épület teteje kigyullad
        const roof = this.map.roofNear(ev.x, ev.y);
        if (roof) this.fires.ignite(roof.x, roof.y, ROOF_FIRE[ev.kind].size, ROOF_FIRE[ev.kind].life);
        break;
      }
      case 'laser':
        this.beam(ev.x1, ev.y1, ev.x2, ev.y2);
        this.weather.flash((ev.x1 + ev.x2) / 2, (ev.y1 + ev.y2) / 2, Math.hypot(ev.x2 - ev.x1, ev.y2 - ev.y1) / 2 + 4, 0.2);
        break;
      case 'ricochet':
        if (this.loudness(ev.x, ev.y) > 0) this.sfx.ricochet(this.loudness(ev.x, ev.y));
        this.boom(ev.x, ev.y, 0.3);
        break;
      case 'pickup':
        if (mine) {
          const style = PICKUP_STYLE[ev.kind];
          this.sfx.pickup();
          this.hud.toast(`${style.label} – ${style.hint}`);
        }
        break;
      case 'oil':
        if (mine) this.sfx.bump();
        break;
      case 'slip':
        if (mine) {
          this.sfx.skid();
          this.hud.toast('Megcsúsztál!');
        }
        break;
      case 'bump':
        if (mine) {
          this.sfx.bump();
          this.cameras.main.shake(90, 0.002);
        }
        break;
      case 'hit':
        if (mine) {
          this.sfx.hit(ev.absorbed !== null);
          this.cameras.main.shake(140, ev.absorbed ? 0.002 : 0.005);
        } else if (ev.by === myId) {
          this.sfx.hit(ev.absorbed !== null);
        }
        break;
      case 'destroyed':
        this.boom(ev.x, ev.y, 3.2);
        this.scar(ev.x, ev.y, 3);
        this.fires.ignite(ev.x, ev.y, WRECK_FIRE.size, WRECK_FIRE.life);
        this.weather.flash(ev.x, ev.y, 26, 0.5);
        this.sfx.explosion(Math.max(0.4, this.loudness(ev.x, ev.y)) * 1.6);
        if (mine) {
          this.cameras.main.shake(400, 0.009);
          const left = (world.me?.lives ?? 1) - 1;
          this.hud.toast(left > 0 ? `Kilőttek! Még ${left} életed van – mindjárt újraéledsz…` : 'Kilőttek!');
        } else if (ev.by === myId) {
          const name = world.nameOf(ev.tank);
          this.hud.toast(name === 'Bot' ? 'Bot kilőve!' : `Kilőtted: ${name}!`);
        }
        break;
      case 'eliminated':
        if (!mine) {
          const left = world.standings.filter((p) => !p.out && p.tank !== ev.tank).length;
          this.hud.toast(`${world.nameOf(ev.tank)} kiesett – még ${left} játékos van játékban`);
        }
        break;
      case 'felled': {
        // a kidőlt fa bekerül a pálya állapotába; a háttérszálak is megkapják, az érintett térképdarabok újrarajzolódnak
        this.map.fellables.fell(ev.index, ev.angle);
        this.ground.notify({ type: 'felled', index: ev.index, angle: ev.angle });
        const reach = (this.map.trees[ev.index]?.r ?? 2.5) * 2.6 + 3;
        this.ground.invalidate(ev.x - reach, ev.y - reach, ev.x + reach, ev.y + reach);
        const volume = this.loudness(ev.x, ev.y);
        if (volume > 0) this.sfx.crack(volume);
        // a lövéstől kidőlt fa (oszlop) kigyullad; amit a tank döntött ki, az nem
        if (ev.shot) {
          const tree = this.map.trees[ev.index];
          const r = tree ? tree.r : 0.6;
          this.fires.ignite(ev.x + Math.cos(ev.angle) * r * 0.9, ev.y + Math.sin(ev.angle) * r * 0.9, tree ? Math.min(3, 1.2 + r * 0.55) : 1, tree ? 22 : 10);
        }
        break;
      }
      case 'collapse':
        this.collapse(ev.index);
        break;
      case 'overheat':
        if (mine) {
          this.sfx.overheat();
          this.hud.toast('Túlmelegedett a gyorsító – le kell hűlnie');
        }
        break;
      case 'levelup':
        if (mine) {
          this.sfx.pickup();
          this.hud.toast(`${ev.level}. szint: nagyobb, szívósabb tank, erősebb lövedék!`);
        }
        break;
      case 'respawn': {
        const tank = world.tank(ev.tank);
        if (tank) this.tankViews.get(ev.tank)?.snap(tank);
        break;
      }
    }
  }

  /** Épület összedőlése: a pályán rom lesz belőle (át lehet hajtani rajta), porfelhő és tűz kíséri. */
  private collapse(index: number): void {
    const building = this.map.data.buildings[index];
    if (!building || this.map.structures.collapsed[index]) return;
    this.map.collapse(index);
    this.ground.notify({ type: 'collapse', index });
    const [minX, minY, maxX, maxY] = this.map.buildingBoxes[index];
    this.ground.invalidate(minX - 6, minY - 6, maxX + 6, maxY + 6);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const size = Math.max(maxX - minX, maxY - minY);
    // robbanások és por az alaprajz mentén
    const count = Math.min(7, 2 + Math.floor(building.area / 60));
    for (let i = 0; i < count; i++) {
      const x = minX + ((i * 0.618 + 0.31) % 1) * (maxX - minX);
      const y = minY + ((i * 0.382 + 0.17) % 1) * (maxY - minY);
      this.time.delayedCall(i * 90, () => {
        this.boom(x, y, 1.6 + size * 0.06);
        for (let k = 0; k < 3; k++) this.smoke((x + k - 1) * this.ppm, (y - k) * this.ppm);
      });
    }
    this.fires.ignite(cx, cy, Math.min(4, 2 + size * 0.08), 40);
    this.weather.flash(cx, cy, size + 12, 0.6);
    const volume = this.loudness(cx, cy);
    if (volume > 0) {
      this.sfx.explosion(Math.max(0.3, volume) * 1.8);
      this.cameras.main.shake(300, 0.004 * volume + 0.002);
    }
  }

  /** Maradandó lövésnyom: bekerül a pálya állapotába, és a térkép érintett része újrarajzolódik. */
  private scar(x: number, y: number, r: number): void {
    this.ground.notify({ type: 'scar', x, y, r });
    if (!this.map.addScar(x, y, r)) return;
    const reach = r * 1.3 + 0.5;
    this.ground.invalidate(x - reach, y - reach, x + reach, y + reach);
  }

  /** A kilőtt tankok roncsai: kiégett test és torony; a frissek füstölnek. */
  private syncWrecks(view: Phaser.Geom.Rectangle): void {
    const { wrecks } = this.world;
    if (wrecks.length === 0 && this.wreckViews.size === 0) return;
    const margin = 6 * this.ppm;
    for (const w of wrecks) {
      const x = w.x * this.ppm;
      const y = w.y * this.ppm;
      let parts = this.wreckViews.get(w.id);
      if (!parts) {
        parts = [
          this.add.image(x, y, GTEX.wreckHull).setRotation(w.hullAngle).setScale(this.spriteScale).setDepth(5),
          this.add.image(x, y, GTEX.wreckTurret).setOrigin(0.25, 0.5).setRotation(w.turretAngle + 0.5).setScale(this.spriteScale).setDepth(6),
        ];
        this.wreckViews.set(w.id, parts);
      }
      const visible = x > view.x - margin && x < view.right + margin && y > view.y - margin && y < view.bottom + margin;
      if (parts[0].visible !== visible) for (const part of parts) part.setVisible(visible);
      // a friss roncs még füstöl
      if (visible && w.age < 25 && (this.frame + w.id) % 14 === 0) this.smoke(x + (w.id % 5) - 2, y - 4);
    }
    if (this.world.listsChanged) {
      for (const [id, parts] of this.wreckViews) {
        if (!wrecks.some((w) => w.id === id)) {
          for (const part of parts) part.destroy();
          this.wreckViews.delete(id);
        }
      }
    }
  }

  /** Robbanás a megadott helyen, a megadott méretszorzóval. */
  private boom(x: number, y: number, size: number): void {
    let boom = this.boomPool.pop();
    if (!boom) {
      const created = this.add.sprite(0, 0, TEX.explosion, 0).setDepth(19);
      // az animáció végén a sprite elrejtődik (hideOnComplete) és visszakerül a készletbe
      created.on(Phaser.Animations.Events.ANIMATION_COMPLETE, () => this.boomPool.push(created));
      boom = created;
    }
    boom
      .setPosition(x * this.ppm, y * this.ppm)
      .setScale(this.spriteScale * size)
      .setVisible(true)
      .play('boom');
  }

  /** Lézersugár: fényes vonal, amely gyorsan elhalványul. */
  private beam(x1: number, y1: number, x2: number, y2: number): void {
    const ppm = this.ppm;
    const length = Math.hypot(x2 - x1, y2 - y1) * ppm;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    for (const [width, tint, alpha] of [[9, 0xff4a8a, 0.45], [3, 0xffffff, 0.95]] as const) {
      const beam = this.beamPool.pop() ?? this.add.image(0, 0, GTEX.px).setOrigin(0, 0.5).setDepth(13);
      beam
        .setPosition(x1 * ppm, y1 * ppm)
        .setRotation(angle)
        .setDisplaySize(length, width * this.spriteScale)
        .setTint(tint)
        .setAlpha(alpha)
        .setVisible(true);
      this.tweens.add({
        targets: beam,
        alpha: 0,
        duration: 240,
        onComplete: () => {
          beam.setVisible(false);
          this.beamPool.push(beam);
        },
      });
    }
  }

  private smoke(x: number, y: number): void {
    const puff = this.smokePool.pop() ?? this.add.image(0, 0, GTEX.smoke).setDepth(12);
    puff.setPosition(x, y).setScale(this.spriteScale * 0.6).setAlpha(0.7).setVisible(true);
    this.tweens.add({
      targets: puff,
      alpha: 0,
      scale: this.spriteScale * 1.6,
      duration: 420,
      onComplete: () => {
        puff.setVisible(false);
        this.smokePool.push(puff);
      },
    });
  }

  /**
   * `ownAlpha`: a saját tank két helyi lépése közötti arány; `netAlpha`: a többi
   * tanké két szerverállapot között. `visible`: az előző képkocka látómezeje –
   * a rajta kívüli tankok megjelenítője pihen.
   */
  private syncTanks(ownAlpha: number, netAlpha: number, seconds: number, visible: Phaser.Geom.Rectangle): void {
    const { tanks, myId } = this.world;
    const focusId = this.world.focus?.id ?? myId;
    const margin = 6 * this.ppm;
    for (const tank of tanks) {
      const x = tank.x * this.ppm;
      const y = tank.y * this.ppm;
      const onScreen = tank.id === focusId || (x > visible.x - margin && x < visible.right + margin && y > visible.y - margin && y < visible.bottom + margin);
      let view = this.tankViews.get(tank.id);
      if (!view) {
        // megjelenítő csak akkor készül, amikor a tank először a kép közelébe kerül
        if (!onScreen) continue;
        view = new TankView(this, this.ppm, tank, tank.id === myId ? 'own' : tank.bot ? 'bot' : 'rival');
        this.tankViews.set(tank.id, view);
      }
      if (onScreen) view.render(tank, tank.id === myId ? ownAlpha : netAlpha, seconds);
      else view.hide();
    }
  }

  /** `age`: az utolsó szerverállapot óta eltelt idő (mp) – a lövedékek addig a sebességük szerint repülnek tovább. */
  private syncBullets(age: number): void {
    const { bullets } = this.world;
    if (bullets.length === 0 && this.bulletViews.size === 0) return;
    const t = Math.min(0.15, Math.max(0, age));
    for (const b of bullets) {
      let view = this.bulletViews.get(b.id);
      if (!view) {
        const rocket = b.kind === 'rocket';
        const heavy = b.kind === 'heavy';
        view = this.add
          .image(0, 0, rocket ? GTEX.rocket : heavy ? GTEX.heavyShell : TEX.bullet)
          .setOrigin(rocket ? 0.7 : heavy ? 0.8 : 0.85, 0.5)
          .setScale(this.spriteScale * (heavy ? 1.15 : 1))
          .setDepth(12);
        this.bulletViews.set(b.id, view);
      }
      const x = (b.x + b.vx * t) * this.ppm;
      const y = (b.y + b.vy * t) * this.ppm;
      // a pattanó lövedék iránya menet közben változhat
      view.setPosition(x, y).setRotation(Math.atan2(b.vy, b.vx));
      if (b.kind === 'rocket' && this.frame % 2 === 0) this.smoke(x, y);
    }
    if (this.world.listsChanged) {
      for (const [id, view] of this.bulletViews) {
        if (!bullets.some((b) => b.id === id)) {
          view.destroy();
          this.bulletViews.delete(id);
        }
      }
    }
  }

  private syncPickups(view: Phaser.Geom.Rectangle, seconds: number): void {
    const { pickups } = this.world;
    const size = PICKUP.radius * 2 * this.ppm;
    const base = size / PICKUP_ICON_SIZE;
    for (const p of pickups) {
      let icon = this.pickupViews.get(p.id);
      if (!icon) {
        // a lombréteg fölött, hogy fa alatt is látsszon
        icon = this.add.image(p.x * this.ppm, p.y * this.ppm, pickupTexture(p.kind)).setDepth(15);
        this.pickupViews.set(p.id, icon);
      }
      const visible = icon.x > view.x - size && icon.x < view.right + size && icon.y > view.y - size && icon.y < view.bottom + size;
      if (icon.visible !== visible) icon.setVisible(visible);
      // finom lüktetés, hogy feltűnjön
      if (visible) icon.setScale(base * (1 + 0.09 * Math.sin(seconds * 4 + p.id)));
    }
    if (this.world.listsChanged) {
      for (const [id, icon] of this.pickupViews) {
        if (!pickups.some((p) => p.id === id)) {
          icon.destroy();
          this.pickupViews.delete(id);
        }
      }
    }
  }

  private syncOils(): void {
    const { oils } = this.world;
    const scale = (OIL.radius * 2 * this.ppm) / 80; // a textúrán a folt kb. 80 pixel átmérőjű
    for (const oil of oils) {
      if (this.oilViews.has(oil.id)) continue;
      const view = this.add.image(oil.x * this.ppm, oil.y * this.ppm, GTEX.oil).setDepth(2).setScale(scale).setRotation((oil.id * 1.7) % 6.28).setAlpha(0.88);
      this.oilViews.set(oil.id, view);
    }
    for (const [id, view] of this.oilViews) {
      if (!oils.some((o) => o.id === id)) {
        view.destroy();
        this.oilViews.delete(id);
      }
    }
  }

  /** Diagnosztika (automata tesztekhez és hibakereséshez). */
  debugState(): Record<string, number | boolean> {
    const p: Partial<TankState> = this.world.own ?? {};
    return {
      x: p.x ?? 0,
      y: p.y ?? 0,
      angle: p.hullAngle ?? 0,
      speed: p.speed ?? 0,
      hp: p.hp ?? 0,
      alive: p.alive ?? false,
      level: p.level ?? 0,
      lives: p.lives ?? 0,
      out: p.out ?? false,
      heat: p.heat ?? 0,
      tick: this.world.tick,
      ready: this.ready,
      ppm: this.ppm,
      tanks: this.world.tanks.length,
      bots: this.world.tanks.filter((t) => t.bot).length,
      pickups: this.world.pickups.length,
      wrecks: this.world.wrecks.length,
      fires: this.fires.count,
      scars: this.map.scars.length / 3,
      fallen: this.map.fellables.fallen.reduce((n, f) => n + f, 0),
      collapsed: this.map.structures.collapsed.reduce((n, f) => n + f, 0),
      chunks: this.ground.chunkCount,
      chunksPending: this.ground.pendingCount,
      ping: this.world.pingMs,
    };
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
