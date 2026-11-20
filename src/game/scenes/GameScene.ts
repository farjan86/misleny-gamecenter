// A játékjelenet: a szerveren futó meccs megjelenítése. A jelenet csak
// BEMENETET küld (a ClientWorld-ön keresztül), az állapotot a szervertől kapja:
// a tankokat, lövedékeket, tárgyakat a pillanatképekből, a hangokat, effekteket
// és a pálya változásait (kidőlt fa, összedőlt ház) az eseményekből rajzolja.

import Phaser from 'phaser';
import { FireLayer } from '../entities/FireLayer';
import { createGameTextures, GTEX, PICKUP_ICON_SIZE } from '../entities/gameTextures';
import { PICKUP_STYLE, pickupTexture } from '../entities/pickupStyle';
import { tankTex, TIER_NAMES, TURRET_PIVOT, TURRET_SIZE } from '../entities/tankTextures';
import { TankView } from '../entities/TankView';
import { TrackLayer } from '../entities/TrackLayer';
import { VehicleLayer } from '../entities/VehicleLayer';
import { createTextures, TEX } from '../entities/textures';
import { WeatherLayer } from '../entities/WeatherLayer';
import { ChunkLayer } from '../maps/ChunkLayer';
import type { GameMap } from '../maps/GameMap';
import { RoadLabelLayer } from '../maps/RoadLabelLayer';
import type { ClientWorld } from '../net/ClientWorld';
import { BASE_PPM } from '../quality';
import { ACTION_LABEL, ACTIONS, keysText, type Action, type KeyBindings } from '../settings';
import { OIL, PICKUP, TIMED_KINDS, type PickupKind } from '../sim/pickups';
import { BOOSTER, LEVEL, SIM_DT, TANK, tankMaxHp, tankSize, tankTier, type ShotKind, type SimEvent, type TankInput, type TankState } from '../sim/world';
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
/** A felrobbanó jármű robbanásának mérete és a roncs tüze. */
const VEHICLE_BLAST = { car: 2.6, truck: 3.1, bus: 3.9 } as const;
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
  private tracks!: TrackLayer;
  private vehicles!: VehicleLayer;
  private readonly debrisPool: Phaser.GameObjects.Image[] = [];
  private readonly shockPool: Phaser.GameObjects.Image[] = [];
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
  /** a nemrég megsérült épületek életerősávjai (az épület sorszáma szerint) */
  private readonly structureBars = new Map<number, { back: Phaser.GameObjects.Image; fill: Phaser.GameObjects.Image; hide: Phaser.Time.TimerEvent }>();
  /** újrahasznált effekt-sprite-ok */
  private readonly boomPool: Phaser.GameObjects.Sprite[] = [];
  private readonly flashPool: Phaser.GameObjects.Image[] = [];
  private readonly beamPool: Phaser.GameObjects.Image[] = [];
  private readonly smokePool: Phaser.GameObjects.Image[] = [];
  // képkockánként újrahasznált objektumok (ne keletkezzen fölösleges szemét)
  private readonly input_: TankInput = { throttle: 0, turn: 0, aim: null, fire: false, drop: false, boost: false, deploy: false };
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
  /** az ágyú telepítését kérő leütés, ugyanígy */
  private deployLatch = false;
  /** a saját szintlépés szövege: a kilövés üzenetéhez fűzve jelenik meg (a két esemény együtt érkezik) */
  private levelNote = '';
  private ready = false;
  private startedAt = 0;
  private frame = 0;
  private camX = 0;
  private camY = 0;
  /** a legutóbb kiírt hátralévő idő (mp) és állás – csak változáskor frissül a kijelző */
  private shownClock = -1;
  private shownScore = '';
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
    this.fitCamera();
    this.cameras.main.setRoundPixels(true);

    this.ground = new ChunkLayer(this, this.map, this.ppm);
    this.fires = new FireLayer(this, this.ppm);
    this.weather = new WeatherLayer(this, this.map, this.ppm, this.world.room.settings.weather);
    this.tracks = new TrackLayer(this, this.map, this.ppm, this.world.room.settings.weather);
    this.vehicles = new VehicleLayer(this, this.ppm, this.world.room.settings.weather, this.world.myId, (kind, px, py) => {
      if (kind === 'smoke') this.smoke(px, py);
      else this.puff(px, py, 0xc8d4e0, 0.6, 320); // vízpermet az esőben
    });
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
      else if (action === 'deploy') this.deployLatch = true;
      else if (action === 'scores') this.hud.holdScores(true);
    }) as EventListener);
    this.listen(window, 'keyup', ((ev: KeyboardEvent) => {
      this.down.delete(ev.code);
      if (!this.held('scores')) this.hud.holdScores(false);
    }) as EventListener);
    // ha az ablak elveszti a fókuszt, a lenyomva maradt gombok ne ragadjanak be
    this.listen(window, 'blur', () => {
      this.down.clear();
      this.hud.holdScores(false);
    });
    this.input.on('pointerdown', () => this.sfx.unlock());
    this.input.on('pointermove', () => {
      this.pointerMoved = true;
    });
    this.input.mouse?.disableContextMenu();

    // a vászon helyét csak átméretezéskor olvassuk ki újra
    const stale = (): void => {
      this.canvasRectStale = true;
    };
    // a vászon mérete az ablak képarányát követi: a képernyőt fedő rétegek (eső, sötétség) is igazodnak
    this.scale.on(Phaser.Scale.Events.RESIZE, (size: Phaser.Structs.Size) => {
      this.canvasRectStale = true;
      this.weather.resize(size.width, size.height);
      this.fitCamera();
    });
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
    this.hud.toast(`${s.name} – ${s.minutes} perc, ${WEATHER_LABEL[s.weather]}. Az nyer, aki a legtöbb tankot lövi ki!`);
  }

  /**
   * A kamera csak a kijelölt játékteret járja be: ami azon kívül van, az nem
   * látszik. Ha a játéktér kisebb a képnél (nagyon kis pálya, széles monitor),
   * a kép közepére kerül.
   */
  private fitCamera(): void {
    const cam = this.cameras.main;
    const area = this.map.bounds ?? { minX: 0, minY: 0, maxX: this.map.width, maxY: this.map.height };
    const w = (area.maxX - area.minX) * this.ppm;
    const h = (area.maxY - area.minY) * this.ppm;
    const bw = Math.max(w, cam.width);
    const bh = Math.max(h, cam.height);
    cam.setBounds(Math.round(area.minX * this.ppm - (bw - w) / 2), Math.round(area.minY * this.ppm - (bh - h) / 2), bw, bh);
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
    input.deploy = this.deployLatch;
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
      this.vehicles.rebase(world.vehicles, world.turrets);
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
      this.deployLatch = false;
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
    this.tracks.update(world.tanks, view, seconds);
    if (this.frame % 5 === 0) this.dust(view);
    this.vehicles.render(netAlpha, view, seconds, dt);
    this.weather.update(view, world.tanks, this.fires, dt, this.vehicles);
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
    if (own) this.tankViews.get(own.id)?.setOwnStatus(own.heat / BOOSTER.duration, own.overheated, -1);

    if (this.frame % 6 === 0) this.hud.setLoadout(this.loadoutOf(own));

    // visszaszámláló óra és az állás
    const score = this.scoreText();
    if (world.timeLeft !== this.shownClock || score !== this.shownScore) {
      this.shownClock = world.timeLeft;
      this.shownScore = score;
      this.hud.setClock(world.timeLeft, score);
    }
    if (this.frame % 20 === 0 && this.hud.infoOpen) this.hud.setInfo(this.infoHtml());
    if (this.hud.scoresOpen && this.frame % 10 === 0) this.hud.setScores(this.scoresHtml());
  }

  private iconUrl(kind: PickupKind): string {
    let url = this.iconUrls.get(kind);
    if (!url) {
      url = (this.textures.get(pickupTexture(kind)).getSourceImage() as HTMLCanvasElement).toDataURL();
      this.iconUrls.set(kind, url);
    }
    return url;
  }

  /** Az eredménytábla: minden játékos kilövései és halálai, a helyezés sorrendjében. */
  private scoresHtml(): string {
    const world = this.world;
    const s = world.room.settings;
    // ugyanaz a sorrend, mint a végeredménynél: kilövések, aztán kevesebb halál; a kilépettek a végén
    const list = [...world.standings].sort((a, b) => Number(a.gone) - Number(b.gone) || b.kills - a.kills || a.deaths - b.deaths);
    let place = 0;
    const rows = list.map((p, i) => {
      const prev = list[i - 1];
      if (!prev || prev.gone !== p.gone || prev.kills !== p.kills || prev.deaths !== p.deaths) place = i + 1;
      const level = world.tank(p.tank)?.level ?? 1;
      const cls = [p.tank === world.myId ? 'me' : '', p.gone ? 'gone' : ''].join(' ').trim();
      return (
        `<tr class="${cls}"><td>${place}.</td><td class="name">${escapeHtml(p.name)}${p.gone ? ' (kilépett)' : ''}</td>` +
        `<td>${p.kills}</td><td>${p.deaths}</td><td>${level}.</td></tr>`
      );
    });
    const bots = world.room.plan.bots ? ` · ${world.room.plan.bots} bot a pályán` : '';
    return (
      `<h3>${escapeHtml(s.name)}</h3>` +
      `<table><tr><th></th><th class="name">Játékos</th><th>Kilövés</th><th>Halál</th><th>Szint</th></tr>${rows.join('')}</table>` +
      `<p class="small">A legtöbb kilövés nyer${bots}</p>`
    );
  }

  /** Az óra alatti sor: a saját kilövések száma, többjátékos meccsben a helyezés is. */
  private scoreText(): string {
    const world = this.world;
    const mine = world.standings.find((p) => p.tank === world.myId);
    if (!mine) return '';
    const rivals = world.standings.filter((p) => !p.gone);
    if (rivals.length < 2) return `${mine.kills} kilövés`;
    const place = 1 + rivals.filter((p) => p.kills > mine.kills || (p.kills === mine.kills && p.deaths < mine.deaths)).length;
    return `${mine.kills} kilövés · ${place}. hely`;
  }

  /** Ami éppen a tanknál van: a fegyver, a megmaradó képességek, majd a fogyó és az időre szóló tárgyak. */
  private loadoutOf(own: TankState | undefined): LoadoutItem[] {
    const items = this.loadout;
    items.length = 0;
    if (!own) return items;
    // a sáv elején mindig a tank szintje áll (ikon nélkül)
    items.push({ icon: '', label: `★ ${own.level}. szint · ${TIER_NAMES[tankTier(own.level)]}`, count: own.level >= LEVEL.max ? 'max' : '' });
    if (!own.alive) return items;
    const add = (kind: PickupKind, count = ''): void => {
      items.push({ icon: this.iconUrl(kind), label: PICKUP_STYLE[kind].label, count });
    };
    if (own.weapon) add(own.weapon);
    if (own.ricochet) add('ricochet');
    if (own.tripleShots > 0) add('triple', `${own.tripleShots} lövés`);
    if (own.shield > 0) add('shield', `×${own.shield}`);
    if (own.oil > 0) add('oil', `×${own.oil}`);
    if (own.turrets > 0) add('turret', `×${own.turrets}`);
    for (const kind of TIMED_KINDS) if (own.effects[kind] > 0) add(kind, `${Math.ceil(own.effects[kind])} mp`);
    return items;
  }

  /** A szint és a tank típusa; ha van még erősebb típus, az is, hogy hányadik szinttől jár. */
  private levelText(level: number): string {
    const tier = tankTier(level);
    const next = LEVEL.tiers[tier + 1];
    return `${level}. – ${TIER_NAMES[tier]}` + (next ? ` (a ${next}. szinttől: ${TIER_NAMES[tier + 1]})` : '');
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
      state.push(['Életerő', `${Math.ceil(own.hp)} / ${tankMaxHp(own)}`], ['Szint', this.levelText(own.level)], ['Kilövés / halál', `${own.kills} / ${own.deaths}`]);
      state.push(['Fegyver', own.weapon ? PICKUP_STYLE[own.weapon].label : 'alaplövedék']);
      const extras: string[] = [];
      if (own.ricochet) extras.push(PICKUP_STYLE.ricochet.label);
      if (own.tripleShots > 0) extras.push(`${PICKUP_STYLE.triple.label} (${own.tripleShots} lövés)`);
      for (const kind of TIMED_KINDS) if (own.effects[kind] > 0) extras.push(`${PICKUP_STYLE[kind].label} (${Math.ceil(own.effects[kind])} mp)`);
      if (own.shield > 0) extras.push(`${PICKUP_STYLE.shield.label} ×${own.shield}`);
      if (own.oil > 0) extras.push(`${PICKUP_STYLE.oil.label} ×${own.oil}`);
      if (own.turrets > 0) extras.push(`${PICKUP_STYLE.turret.label} ×${own.turrets}`);
      if (extras.length) state.push(['Nálad van', extras.join(', ')]);
    }
    const players: [string, string][] = this.world.standings.map((p) => [escapeHtml(p.name), `${p.kills} kilövés · ${p.deaths} halál${p.gone ? ' (kilépett)' : ''}`]);
    const extra = this.map.data.meta.extraAttribution ? ` · ${this.map.data.meta.extraAttribution}` : '';
    return (
      `<h3>Irányítás</h3>${rows(controls)}` +
      `<h3>A tankod</h3>${rows(state)}` +
      `<h3>Játékosok – ${escapeHtml(s.name)}</h3>${rows(players)}` +
      `<p class="small">Időjárás: ${WEATHER_LABEL[s.weather]} · játékidő: ${s.minutes} perc · botok: ${this.world.room.plan.bots} · járművek: ${this.world.room.plan.traffic} · válaszidő: ${this.world.pingMs} ms<br />` +
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
          const flash = this.flashPool.pop() ?? this.add.image(0, 0, TEX.flash).setOrigin(0.15, 0.5).setDepth(12);
          // a nagyobb tank torkolattüze is nagyobb
          const shooter = world.tank(ev.tank);
          flash.setScale(this.spriteScale * (shooter ? tankSize(shooter) : 1)).setPosition(ev.x * ppm, ev.y * ppm).setRotation(ev.angle).setVisible(true);
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
          this.hud.toast('Kilőttek! Mindjárt újraéledsz…');
        } else if (ev.by === myId) {
          const name = world.nameOf(ev.tank);
          this.hud.toast((name === 'Bot' ? 'Bot kilőve!' : `Kilőtted: ${name}!`) + (this.levelNote ? ` ${this.levelNote}` : ''));
          this.levelNote = '';
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
        this.dropStructureBar(ev.index);
        this.collapse(ev.index);
        break;
      case 'structure':
        this.showStructureBar(ev.index, ev.x, ev.y, ev.left);
        break;
      case 'ram': {
        // a tank egy épületnek feszül: por és törmelék a falnál, recsegés
        const volume = this.loudness(ev.x, ev.y);
        if (volume <= 0) break;
        const rammer = world.tank(ev.tank);
        const size = rammer ? tankSize(rammer) : 1;
        for (let i = 0; i < 3; i++) this.puff((ev.x + (i - 1) * 1.1 * size) * ppm, (ev.y + ((i * 7 + this.frame) % 5) * 0.4 - 1) * ppm, 0xb9ab98, 0.9 * size, 520);
        this.sfx.crunch(volume * 0.45);
        if (mine) this.cameras.main.shake(90, 0.0016 * size);
        break;
      }
      case 'overheat':
        if (mine) {
          this.sfx.overheat();
          this.hud.toast('Túlmelegedett a gyorsító – le kell hűlnie');
        }
        break;
      case 'levelup': {
        // osztályváltáskor a tank új típus lesz: ezt mindenki látja, aki a közelben van
        const tier = tankTier(ev.level);
        const promoted = LEVEL.tiers[tier] === ev.level;
        const tank = world.tank(ev.tank);
        if (promoted && tank && this.loudness(tank.x, tank.y) > 0) this.flare(tank.x * ppm, tank.y * ppm, tankSize(tank));
        if (mine) {
          if (promoted) this.sfx.fanfare();
          else this.sfx.pickup();
          // a szintlépést kiváltó kilövés eseménye közvetlenül ezután jön: az üzenete ezzel a szöveggel egészül ki
          this.levelNote = promoted ? `${ev.level}. szint – új tank: ${TIER_NAMES[tier]}!` : `${ev.level}. szint: nagyobb, erősebb tank.`;
          this.hud.toast(this.levelNote);
        }
        break;
      }
      case 'blast': {
        // felrobbant egy jármű: nagy robbanás, a roncsa ég
        const size = VEHICLE_BLAST[ev.kind];
        this.boom(ev.x, ev.y, size);
        this.scar(ev.x, ev.y, size * 0.9);
        this.fires.ignite(ev.x, ev.y, 1.6 + size * 0.3, 32);
        this.weather.flash(ev.x, ev.y, ev.radius * 2.4, 0.5);
        const volume = this.loudness(ev.x, ev.y);
        if (volume > 0) {
          this.sfx.explosion(Math.max(0.3, volume) * 1.5);
          this.cameras.main.shake(260, 0.006 * volume);
        }
        break;
      }
      case 'crushed': {
        const volume = this.loudness(ev.x, ev.y);
        if (volume > 0) this.sfx.crunch(volume);
        this.burst(ev.x * ppm, ev.y * ppm, 0.9);
        break;
      }
      case 'honk': {
        const volume = this.loudness(ev.x, ev.y);
        if (volume > 0) this.sfx.honk(volume);
        break;
      }
      case 'deploy':
        if (mine) {
          this.sfx.bump();
          this.hud.toast('Ágyú telepítve – lő minden ellenségre a közelében');
        }
        break;
      case 'turretDown':
        this.boom(ev.x, ev.y, 1.9);
        this.scar(ev.x, ev.y, 1.5);
        this.weather.flash(ev.x, ev.y, 16, 0.4);
        if (this.loudness(ev.x, ev.y) > 0) this.sfx.explosion(Math.max(0.3, this.loudness(ev.x, ev.y)));
        if (ev.owner === myId) this.hud.toast('Megsemmisült az egyik ágyúd!');
        break;
      case 'respawn': {
        const tank = world.tank(ev.tank);
        if (tank) this.tankViews.get(ev.tank)?.snap(tank);
        break;
      }
    }
  }

  /** A megsérült épület fölött rövid időre megjelenik az életerősávja: így látszik, hogy a lövés vagy az ütközés rombolja. */
  private showStructureBar(index: number, x: number, y: number, left: number): void {
    const scale = this.spriteScale;
    const width = 64 * scale;
    let bar = this.structureBars.get(index);
    if (!bar) {
      const back = this.add.image(x * this.ppm, y * this.ppm, GTEX.px).setDepth(17).setTint(0x101418).setAlpha(0.85).setDisplaySize(width + 2 * scale, 8 * scale);
      const fill = this.add.image(x * this.ppm - width / 2, y * this.ppm, GTEX.px).setDepth(18).setOrigin(0, 0.5);
      bar = { back, fill, hide: this.time.delayedCall(0, () => undefined) };
      this.structureBars.set(index, bar);
    }
    const ratio = Math.max(0, Math.min(1, left));
    bar.fill.setDisplaySize(Math.max(1, width * ratio), 6 * scale).setTint(ratio > 0.5 ? 0xe8c23a : ratio > 0.25 ? 0xf08a2a : 0xe0483a);
    bar.hide.remove();
    bar.hide = this.time.delayedCall(2200, () => this.dropStructureBar(index));
  }

  private dropStructureBar(index: number): void {
    const bar = this.structureBars.get(index);
    if (!bar) return;
    bar.hide.remove();
    bar.back.destroy();
    bar.fill.destroy();
    this.structureBars.delete(index);
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
          this.add.image(x, y, tankTex.wreckHull(tankTier(w.level))).setRotation(w.hullAngle).setScale(this.spriteScale * tankSize(w)).setDepth(5),
          this.add
            .image(x, y, tankTex.wreckTurret(tankTier(w.level)))
            .setOrigin(TURRET_PIVOT.x / TURRET_SIZE.w, TURRET_PIVOT.y / TURRET_SIZE.h)
            .setRotation(w.turretAngle + 0.5)
            .setScale(this.spriteScale * tankSize(w))
            .setDepth(6),
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
    // a képernyőn látható, nagyobb robbanásokat lökéshullám, törmelék és gomolygó füst kíséri
    const px = x * this.ppm;
    const py = y * this.ppm;
    const v = this.view;
    if (size >= 0.9 && px > v.x - 80 && px < v.right + 80 && py > v.y - 80 && py < v.bottom + 80) this.burst(px, py, size);
  }

  private burst(px: number, py: number, size: number): void {
    const scale = this.spriteScale;
    const ring = this.shockPool.pop() ?? this.add.image(0, 0, GTEX.shock).setDepth(18).setBlendMode(Phaser.BlendModes.ADD);
    ring.setPosition(px, py).setScale(scale * size * 0.25).setAlpha(0.7).setVisible(true);
    this.tweens.add({
      targets: ring,
      scale: scale * size * 1.5,
      alpha: 0,
      duration: 260,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        ring.setVisible(false);
        this.shockPool.push(ring);
      },
    });
    const pieces = Math.min(9, 3 + Math.round(size * 2.5));
    for (let i = 0; i < pieces; i++) {
      const piece = this.debrisPool.pop() ?? this.add.image(0, 0, GTEX.debris).setDepth(18);
      const angle = (i / pieces) * Math.PI * 2 + ((this.frame * 7 + i * 13) % 10) * 0.07;
      const reach = (22 + ((i * 37 + this.frame) % 30)) * size * scale;
      piece
        .setPosition(px, py)
        .setScale(scale * (0.6 + (i % 3) * 0.35))
        .setRotation(angle)
        .setTint(i % 3 === 0 ? 0xd88a3a : 0x2a2622)
        .setAlpha(1)
        .setVisible(true);
      this.tweens.add({
        targets: piece,
        x: px + Math.cos(angle) * reach,
        y: py + Math.sin(angle) * reach,
        rotation: angle + 4,
        alpha: 0,
        duration: 380 + (i % 4) * 70,
        ease: 'Quad.easeOut',
        onComplete: () => {
          piece.setVisible(false);
          this.debrisPool.push(piece);
        },
      });
    }
    for (let i = 0; i < 3; i++) this.time.delayedCall(90 + i * 110, () => this.puff(px + (i - 1) * 9 * scale * size, py - i * 7 * scale, 0x4a4642, 1.1 * size, 900));
  }

  /** Új tanktípus: két táguló, aranyszínű fénygyűrű a tank körül. */
  private flare(px: number, py: number, size: number): void {
    const scale = this.spriteScale * size;
    for (let i = 0; i < 2; i++) {
      const ring = this.shockPool.pop() ?? this.add.image(0, 0, GTEX.shock).setDepth(18).setBlendMode(Phaser.BlendModes.ADD);
      ring.setPosition(px, py).setScale(scale * 0.4).setAlpha(0).setTint(0xffd84a).setVisible(true);
      this.tweens.add({
        targets: ring,
        scale: scale * (2.2 + i * 0.9),
        alpha: { from: 0.95, to: 0 },
        delay: i * 140,
        duration: 620,
        ease: 'Cubic.easeOut',
        onComplete: () => {
          ring.setVisible(false).clearTint();
          this.shockPool.push(ring);
        },
      });
    }
  }

  /** A terepen gyorsan haladó tankok port vernek fel (esőben sarat). */
  private dust(view: Phaser.Geom.Rectangle): void {
    const rain = this.world.room.settings.weather === 'rain';
    for (const tank of this.world.tanks) {
      if (!tank.alive || Math.abs(tank.speed) < 2) continue;
      const px = tank.x * this.ppm;
      const py = tank.y * this.ppm;
      if (px < view.x || px > view.right || py < view.y || py > view.bottom) continue;
      // a nehéz tanktól fölfelé a kipufogó sötét füstöt ereget
      const tier = tankTier(tank.level);
      if (tier >= 2 && (this.frame / 5) % 2 === 0) {
        const size = tankSize(tank);
        const rear = -2.9 * size * this.ppm;
        const off = ((this.frame / 10) & 1 ? 1 : -1) * 1.2 * size * this.ppm;
        this.puff(px + Math.cos(tank.hullAngle) * rear - Math.sin(tank.hullAngle) * off, py + Math.sin(tank.hullAngle) * rear + Math.cos(tank.hullAngle) * off, 0x2e2b28, 0.45 + 0.12 * tier, 520);
      }
      if (Math.abs(tank.speed) < 6) continue;
      if (this.map.speedFactor(tank.x, tank.y) >= 1) continue;
      const back = (tank.speed > 0 ? -1.9 : 1.9) * this.ppm;
      const side = ((this.frame / 5) & 1 ? 1 : -1) * 1.2 * this.ppm;
      const cos = Math.cos(tank.hullAngle);
      const sin = Math.sin(tank.hullAngle);
      this.puff(px + cos * back - sin * side, py + sin * back + cos * side, rain ? 0x5a4832 : 0xb8a888, rain ? 0.7 : 1, rain ? 380 : 620);
    }
  }

  /** Színezett füst- vagy porpamacs, amely szétterül és elhalványul. */
  private puff(x: number, y: number, tint: number, size: number, duration: number): void {
    const puff = this.smokePool.pop() ?? this.add.image(0, 0, GTEX.smoke).setDepth(12);
    puff.setPosition(x, y).setScale(this.spriteScale * 0.5 * size).setAlpha(0.6).setTint(tint).setVisible(true);
    this.tweens.add({
      targets: puff,
      alpha: 0,
      scale: this.spriteScale * 1.7 * size,
      duration,
      onComplete: () => {
        puff.setVisible(false);
        puff.clearTint();
        this.smokePool.push(puff);
      },
    });
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
          .setDepth(12);
        // a nagyobb tank lövedéke is nagyobb; a titán energiaágyúja kéken izzó lövedéket lő
        const shooter = this.world.tank(b.owner);
        view.setScale(this.spriteScale * (heavy ? 1.15 : 1) * (shooter ? 0.8 + 0.2 * tankSize(shooter) + 0.25 * (tankSize(shooter) - 1) : 1));
        if (shooter && !rocket && !heavy && tankTier(shooter.level) === LEVEL.tiers.length - 1) view.setTint(0x8ff0ff);
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
      kills: p.kills ?? 0,
      deaths: p.deaths ?? 0,
      timeLeft: this.world.timeLeft,
      viewWidth: Math.round(this.cameras.main.width / this.ppm),
      viewHeight: Math.round(this.cameras.main.height / this.ppm),
      heat: p.heat ?? 0,
      tick: this.world.tick,
      ready: this.ready,
      ppm: this.ppm,
      tanks: this.world.tanks.length,
      bots: this.world.tanks.filter((t) => t.bot).length,
      pickups: this.world.pickups.length,
      wrecks: this.world.wrecks.length,
      vehicles: this.world.vehicles.length,
      vehicleViews: this.vehicles.count,
      turrets: this.world.turrets.length,
      turretCharges: p.turrets ?? 0,
      fires: this.fires.count,
      scars: this.map.scars.length / 3,
      fallen: this.map.fellables.fallen.reduce((n, f) => n + f, 0),
      collapsed: this.map.structures.collapsed.reduce((n, f) => n + f, 0),
      chunks: this.ground.chunkCount,
      chunksPending: this.ground.pendingCount,
      antialias: this.ground.antialias,
      tracks: this.tracks.count,
      chunkMs: Math.round(this.ground.lastRenderMs * 10) / 10,
      ping: this.world.pingMs,
    };
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
