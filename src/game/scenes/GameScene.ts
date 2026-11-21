// A játékjelenet: a szerveren futó meccs megjelenítése. A jelenet csak
// BEMENETET küld (a ClientWorld-ön keresztül), az állapotot a szervertől kapja:
// a tankokat, lövedékeket, tárgyakat a pillanatképekből, a hangokat, effekteket
// és a pálya változásait (kidőlt fa, összedőlt ház) az eseményekből rajzolja.

import Phaser from 'phaser';
import { FireLayer } from '../entities/FireLayer';
import { createGameTextures, GTEX, PICKUP_ICON_SIZE, PUFF_SIZE, PUFF_VARIANTS } from '../entities/gameTextures';
import { PICKUP_STYLE, pickupTexture } from '../entities/pickupStyle';
import { LOOK_TIER_NAMES, tankTex, TIER_NAMES, TURRET_PIVOT, TURRET_SIZE } from '../entities/tankTextures';
import { TankView } from '../entities/TankView';
import { TrackLayer } from '../entities/TrackLayer';
import { VehicleLayer } from '../entities/VehicleLayer';
import { createTextures, TEX } from '../entities/textures';
import { WeatherLayer } from '../entities/WeatherLayer';
import { ChunkLayer } from '../maps/ChunkLayer';
import type { GameMap } from '../maps/GameMap';
import { RoadLabelLayer } from '../maps/RoadLabelLayer';
import { RoadNav, type Route } from '../maps/roadNav';
import type { ClientWorld } from '../net/ClientWorld';
import { BASE_PPM } from '../quality';
import { ACTION_LABEL, ACTIONS, keysText, type Action, type KeyBindings } from '../settings';
import { BARREL, CLOAK, FLAME, SMOKE, STRIKE, WORKSHOP, insideSmoke, smokeRadius } from '../sim/gadgets';
import { GAME_MODE_NAME } from '../sim/match';
import { OIL, PICKUP, TIMED_KINDS, type PickupKind } from '../sim/pickups';
import { BOOSTER, LEVEL, SIM_DT, TANK, tankMaxHp, tankRadius, tankSize, tankTier, type KillCause, type ShotKind, type SimEvent, type TankInput, type TankState } from '../sim/world';
import { Sfx } from '../systems/audio';
import { isFullscreen, toggleFullscreen } from '../ui/fullscreen';
import { RELEASE_KEYS } from '../ui/GameChat';
import { CAUSE_LABEL, causeWith, deathText } from '../ui/killText';
import { VERSION } from '../version';
import { Hud, type HudFrame, type LoadoutItem, type MapMark } from '../ui/Hud';

/** A billentyűvel használható tárgyak és a hozzájuk tartozó művelet (a tank sávja a billentyűt is kiírja). */
const USE_KEY: Partial<Record<PickupKind, Action>> = { oil: 'oil', turret: 'deploy', mine: 'mine', smoke: 'smoke' };
/** Késő pillanatképnél a többi tank mozgása legfeljebb ennyivel fut túl az utolsó ismert helyén (1 = nem fut túl). */
const NET_OVERSHOOT = 1.35;
/** Aki kilőtt, az újraéledés után ennyi ideig jelölve látszik (mp). */
const REVENGE_SECONDS = 25;
/** Ha a térkép ennyi idő alatt sem készül el, a töltőképernyő akkor is eltűnik. */
const LOADING_TIMEOUT_MS = 8000;
/** A robbanás mérete a találat fajtája szerint. */
const BLAST: Record<ShotKind, number> = { shell: 1, heavy: 2, rocket: 2.9, laser: 0.55 };
/** A maradandó lövésnyom sugara méterben, a találat fajtája szerint. */
const SCAR: Record<ShotKind, number> = { shell: 1.2, heavy: 2.6, rocket: 3.8, laser: 0.55 };
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
  /** a hangerő 0 és 1 között */
  volume: number;
  /** a játékos a „Kilépés a meccsből” gombra kattintott */
  onLeave: () => void;
}

/**
 * A GPS-útvonal a tank mostani helyétől: megkeresi, melyik szakasz mellett jár a tank (az útvonal
 * elején), az addig megtett részt levágja, és az útvonal a tanktól indul. off: a tank távolsága az
 * útvonaltól (m) – ha nagy, letért róla (az első szakasz a tervezéskori tankhelytől indul, az nem számít).
 */
function trimRoute(p: readonly number[], x: number, y: number): { points: number[]; length: number; off: number } {
  let best = 0;
  let bestD = Infinity;
  // csak az elején keres: a tank az utolsó tervezés óta legfeljebb ennyi pontot haladhatott
  const last = Math.min(p.length - 4, 80);
  for (let i = 0; i <= last; i += 2) {
    const dx = p[i + 2] - p[i];
    const dy = p[i + 3] - p[i + 1];
    const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (y - p[i + 1]) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(x - p[i] - dx * t, y - p[i + 1] - dy * t);
    if (d < bestD - 0.01) {
      bestD = d;
      best = i;
    }
  }
  const points = [x, y, ...p.slice(best + 2)];
  let length = 0;
  for (let i = 2; i < points.length; i += 2) length += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  return { points, length, off: best === 0 ? 0 : bestD };
}

/** A lángszóró lángjának egy darabja: a csőtől kifelé repül, közben nő, és fehérből sárgán, narancson át vörösbe hűl. */
interface FlamePart {
  image: Phaser.GameObjects.Image;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  spin: number;
}
/** a láng színe az életkora szerint: [eddig az arányig, szín] */
const FLAME_COLORS: [number, number][] = [
  [0.12, 0xfff6d2],
  [0.3, 0xffd24a],
  [0.55, 0xff8a1e],
  [0.8, 0xe8440f],
  [1, 0x6a1c0a],
];
/** a lángdarabok sebessége (m/s) */
const FLAME_SPEED = 46;

/** egy füstfelhő gomolyagjainak száma */
const SMOKE_PUFFS = 26;
/**
 * A lézersugár élete (mp) és rétegei (pixelvastagság 1-es léptéknél): halvány borostyán izzás,
 * sárga sugár, vakító fehér mag – körülötte két spirálisan tekeredő lila szalag (LASER_SPIRAL).
 */
const LASER_LIFE = 0.42;
const LASER_LAYERS = [
  { width: 36, tint: 0xff9010, alpha: 0.6, depth: 0 },
  { width: 14, tint: 0xffd84a, alpha: 0.95, depth: 0.1 },
  { width: 5, tint: 0xffffff, alpha: 1, depth: 0.2 },
] as const;
/** a szalagok: kitérés és menetemelkedés (pixel), forgási sebesség (rad/mp), színük */
const LASER_SPIRAL = { amplitude: 11, pitch: 36, spin: 16, step: 3.5, colors: [0xa04dff, 0xe04ae0] } as const;
/** Egy füstfelhő képei: a sűrű mag két rétege, a gomolyagok, a földre vetett árnyék; és a szervertől utoljára kapott hátralévő idő. */
interface SmokeView {
  core: Phaser.GameObjects.Image[];
  puffs: Phaser.GameObjects.Image[];
  shadow: Phaser.GameObjects.Image;
  life: number;
  at: number;
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
  private readonly mineViews = new Map<number, Phaser.GameObjects.Image>();
  private readonly barrelViews = new Map<number, Phaser.GameObjects.Image>();
  /** a füstfelhők: két, ellentétesen forgó réteg */
  private readonly smokeViews = new Map<number, SmokeView>();
  /** felröppenő sebzésszámok és a találat irányát jelző ívek (újrahasznált objektumok) */
  private readonly numberPool: Phaser.GameObjects.Text[] = [];
  private readonly arcPool: Phaser.GameObjects.Image[] = [];
  private readonly tracerPool: Phaser.GameObjects.Image[] = [];
  private readonly casingPool: Phaser.GameObjects.Image[] = [];
  private readonly flameParts: FlamePart[] = [];
  private readonly flamePool: Phaser.GameObjects.Image[] = [];
  /** mely tankok lángszórója égett az előző képkockában (a begyulladás hangjához) */
  private readonly flamingBefore = new Set<number>();
  /** a géppuska lövéseinek számlálója: minden harmadik lövedék fényes nyomjelző */
  private mgRound = 0;

  /** A saját alaptank osztályainak neve (fajtánként más). */
  private get tierNames(): readonly string[] {
    return LOOK_TIER_NAMES[this.world.lookOf(this.world.myId)] ?? TIER_NAMES;
  }
  /** olajos volt-e a saját tank lánctalpa az előző képkockában (a jelzéshez) */
  private wasOily = false;
  /** a géppuskatalálatok jelzésének ritkítása (ne szóljon és ne villogjon másodpercenként nyolcszor) */
  private lastPing = 0;
  private lastLightArc = 0;
  /** a kilövés üzenetéhez fűzött megjegyzés a szintvesztésről */
  private lossNote = '';
  /** bosszú: aki kilőtt – az újraéledés után egy ideig jelölve látszik (live: már újraéledtem) */
  private revenge: { id: number; until: number; live: boolean } | null = null;
  private revengeArrow: Phaser.GameObjects.Image | null = null;
  /** a bejelentett vagy már kint lévő szupertárgy helye */
  private superMark: { x: number; y: number; here: boolean; since: number } | null = null;
  private superArrow: Phaser.GameObjects.Image | null = null;
  /** a folyamatban lévő tüzérségi csapások helye (a térképhez) */
  private readonly strikeMarks: { x: number; y: number; until: number }[] = [];
  private readonly marks: MapMark[] = [];
  /** a roncsok képei: test és torony */
  private readonly wreckViews = new Map<number, Phaser.GameObjects.Image[]>();
  /** a nemrég megsérült épületek életerősávjai (az épület sorszáma szerint) */
  private readonly structureBars = new Map<number, { back: Phaser.GameObjects.Image; fill: Phaser.GameObjects.Image; hide: Phaser.Time.TimerEvent }>();
  /** újrahasznált effekt-sprite-ok */
  private readonly boomPool: Phaser.GameObjects.Sprite[] = [];
  private readonly flashPool: Phaser.GameObjects.Image[] = [];
  private readonly beamPool: Phaser.GameObjects.Image[] = [];
  /** a látható lézersugarak (lásd beam, updateLasers) */
  private readonly lasers: {
    shooter: number;
    start: { x: number; y: number };
    end: { x: number; y: number };
    age: number;
    layers: { width: number; tint: number; alpha: number; image: Phaser.GameObjects.Image }[];
    muzzle: Phaser.GameObjects.Image;
    hit: Phaser.GameObjects.Image;
    sparks: { t: number; vx: number; vy: number; image: Phaser.GameObjects.Image }[];
    back: Phaser.GameObjects.Graphics;
    front: Phaser.GameObjects.Graphics;
    seed: number;
  }[] = [];
  private readonly smokePool: Phaser.GameObjects.Image[] = [];
  // képkockánként újrahasznált objektumok (ne keletkezzen fölösleges szemét)
  private readonly input_: TankInput = { throttle: 0, turn: 0, aim: null, fire: false, drop: false, boost: false, deploy: false, mine: false, smoke: false, strike: null, cloak: false };
  private readonly view = new Phaser.Geom.Rectangle();
  private readonly hudFrame: HudFrame = {
    x: 0, y: 0, angle: 0, viewX: 0, viewY: 0, viewW: 0, viewH: 0, canvasLeft: 0, canvasTop: 0, canvasWidth: 1, canvasHeight: 1,
    tanks: [], pickups: null, focusId: 0, smokes: [], marks: [], gps: null,
  };
  /** GPS: a kijelölt cél, az utolsó útvonal és a tervezés ideje (mp); null: ki van kapcsolva */
  private gps: { x: number; y: number; route: Route | null; plannedAt: number } | null = null;
  private nav: RoadNav | null = null;
  private gpsLine: Phaser.GameObjects.Graphics | null = null;
  private gpsArrow: Phaser.GameObjects.Image | null = null;
  /** a tüzérségi csapás célzása (X): amíg nyitva a nagy térkép, a kattintás a csapás helye */
  private strikeAim = false;
  private canvasRectStale = true;
  private accumulator = 0;
  private pointerMoved = false;
  /** az olajfolt lerakását kérő leütés, amíg el nem megy a szervernek */
  private dropLatch = false;
  /** az ágyú telepítését kérő leütés, ugyanígy */
  private deployLatch = false;
  /** akna, füst és a tüzérségi csapás célpontja, ugyanígy */
  private mineLatch = false;
  private smokeLatch = false;
  private strikeLatch: { x: number; y: number } | null = null;
  private cloakLatch = false;
  /** a saját szintlépés szövege: a kilövés üzenetéhez fűzve jelenik meg (a két esemény együtt érkezik) */
  private levelNote = '';
  /** az előző képkocka állapota a hangokhoz: gyorsított-e a tank, kevés volt-e az életereje, hány másodpercet mutatott az óra */
  private wasBoosting = false;
  private wasLow = false;
  /** a saját tank éppen műhelyben áll-e (a belépés üzenetéhez), és a javítás hangjának ütemezése */
  private inShop = false;
  private lastWrench = 0;
  private readonly shopLights: Phaser.GameObjects.Image[] = [];
  private lastSecond = -1;
  private ready = false;
  private startedAt = 0;
  private frame = 0;
  private camX = 0;
  private camY = 0;
  /** a legutóbb kiírt hátralévő idő (mp) és állás – csak változáskor frissül a kijelző */
  private shownClock = -1;
  private shownScore = '';
  private shownStats = '';
  /** tankonként az utolsó falrombolás ideje (ms): ebből tudni, hogy új ütközés-e */
  private lastRam = new Map<number, number>();
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
    this.sfx.setVolume(data.volume);
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
    // menet közben léptünk be (nyitott játék): ami már le van döntve, az nálunk is úgy látszik
    const destroyed = this.world.destroyed;
    if (destroyed) {
      for (const index of destroyed.b) {
        if (this.map.structures.collapsed[index]) continue;
        this.map.collapse(index);
        this.ground.notify({ type: 'collapse', index });
      }
      destroyed.p.forEach((index, i) => {
        if (!this.map.fellables.fell(index, destroyed.a[i] ?? 0)) return;
        this.ground.notify({ type: 'felled', index, angle: destroyed.a[i] ?? 0 });
      });
    }
    this.fires = new FireLayer(this, this.ppm);
    this.weather = new WeatherLayer(this, this.map, this.ppm, this.world.room.settings.weather);
    this.tracks = new TrackLayer(this, this.map, this.ppm, this.world.room.settings.weather);
    this.vehicles = new VehicleLayer(this, this.ppm, this.world.room.settings.weather, this.world.myId, (kind, px, py) => {
      if (kind === 'smoke') this.smoke(px, py);
      else this.puff(px, py, 0xc8d4e0, 0.6, 320); // vízpermet az esőben
    });
    this.hud = new Hud(this.map, this.ppm);
    this.hud.onLeave(() => this.onLeave());
    // a nagy térképre kattintva a tüzérségi csapás a pálya bármely pontjára kérhető
    this.hud.onMapClick((x, y) => {
      if (this.requestStrike(x, y)) this.hud.toggleMap();
    });
    // GPS: kattintás a nagy térképen (M) – cél; jobb klikk vagy G – kikapcsolás
    this.hud.onGps(
      (x, y) => this.setGps(x, y),
      () => this.gpsOff(),
    );
    this.roadLabels = new RoadLabelLayer(this, this.map, this.ppm);
    this.buildWorkshops();

    // A billentyűket közvetlenül a böngésző eseményeiből követjük, a beállított kiosztás szerint.
    this.listen(window, 'keydown', ((ev: KeyboardEvent) => {
      // gépelés közben (üzenet írása) a billentyűk a beviteli mezőé
      if (ev.target instanceof HTMLInputElement) return;
      if (ev.altKey || ev.metaKey) return;
      // Esc: a menü (billentyűk, kilépés); ha más panel van nyitva, előbb azt zárja be
      if (ev.code === 'Escape' && !ev.repeat) {
        if (this.hud.infoOpen) this.hud.toggleInfo();
        else if (this.hud.mapOpen) this.hud.toggleMap();
        else this.hud.toggleMenu();
        return;
      }
      const action = this.actionOf(ev.code);
      // Ctrl-lal együtt csak a játék saját billentyűit kezeljük (a Ctrl maga is lehet az);
      // a többi a böngészőé marad (pl. Ctrl+F5: újratöltés)
      if (ev.ctrlKey && !action) return;
      if (action) ev.preventDefault();
      this.down.add(ev.code);
      if (ev.repeat) return;
      this.sfx.unlock();
      if (action === 'map') this.hud.toggleMap();
      else if (action === 'gps') this.gpsOff();
      else if (action === 'info') this.hud.toggleInfo();
      else if (action === 'fullscreen') toggleFullscreen();
      else if (action === 'oil') this.dropLatch = true;
      else if (action === 'deploy') this.deployLatch = true;
      else if (action === 'mine') this.mineLatch = true;
      else if (action === 'smoke') this.smokeLatch = true;
      else if (action === 'strike') this.aimStrike();
      else if (action === 'cloak') this.requestCloak();
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
    // üzenetírás kezdetekor a lenyomva tartott gombok elengednek, hogy a tank ne menjen tovább magától
    this.listen(window, RELEASE_KEYS, () => this.down.clear());
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
    this.sfx.ambience(s.weather);
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
    // az egérgomb csak akkor lő (illetve rak le), ha a játéktéren nyomták le: a menüre, a térképre,
    // a gombokra kattintás nem; és amíg a menü nyitva van, az egér egyáltalán nem lő
    const onField = pointer.downElement === this.game.canvas && !this.hud.menuOpen;
    input.fire = this.held('fire') || (onField && pointer.leftButtonDown());
    input.boost = this.held('boost');
    input.drop = this.dropLatch || (onField && pointer.rightButtonDown());
    input.deploy = this.deployLatch;
    input.mine = this.mineLatch;
    input.smoke = this.smokeLatch;
    input.strike = this.strikeLatch;
    input.cloak = this.cloakLatch;
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
      this.mineLatch = false;
      this.smokeLatch = false;
      this.strikeLatch = null;
      this.cloakLatch = false;
      this.accumulator -= SIM_DT;
    }

    // ha a következő pillanatkép késik (hálózati egyenetlenség), a többi tank rövid ideig a korábbi
    // irányában halad tovább, ahelyett hogy megállna és aztán ugrana
    const netAlpha = Math.max(0, Math.min(NET_OVERSHOOT, (now - world.snapAt) / world.snapInterval));
    this.syncTanks(this.accumulator / SIM_DT, netAlpha, seconds, this.view);
    this.syncBullets((now - world.snapAt) / 1000);
    if (world.listsChanged) this.syncOils();
    this.oilyTracks();
    this.flames(Math.min(0.1, deltaMs / 1000));
    this.updateLasers(Math.min(0.1, deltaMs / 1000));
    // a „kilőttek” jelzés az újraéledésig marad kint, a hátralévő idővel
    const fallen = world.own;
    if (fallen && !fallen.alive) this.hud.deathCountdown(fallen.out ? -1 : fallen.respawn);
    else this.hud.hideDeath();
    this.syncGadgets(seconds);
    this.syncWrecks(this.view);

    const own = world.own;
    const focus = world.focus;
    // a kilőtt tank motorja hallgat; a nagyobb tanké mélyebben és hangosabban szól
    this.sfx.engine(own && own.alive ? (Math.abs(own.speed) / TANK.maxSpeed) * (own.boosting ? 1.15 : 1) : -1, own ? tankSize(own) : 1);
    const boosting = !!own && own.alive && own.boosting;
    if (boosting && !this.wasBoosting) this.sfx.boost();
    this.wasBoosting = boosting;
    this.updateWorkshop(own, seconds);
    const low = !!own && own.alive && own.hp / tankMaxHp(own) <= 0.25;
    if (low && !this.wasLow) this.sfx.lowHp();
    this.wasLow = low;

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
      if (this.bindings.fullscreen.length) this.hud.fullscreenTip(keysText(this.bindings, 'fullscreen'));
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
    f.smokes = world.smokes;
    f.marks = this.updateMarks(view);
    // a csapás célzása csak addig tart, amíg az X-szel nyitott nagy térkép nyitva van
    if (!this.hud.mapOpen) this.strikeAim = false;
    this.hud.setAiming(this.strikeAim && !!own && own.alive && own.strikes > 0);
    f.gps = this.updateGps(view);
    this.hud.update(f);

    // a saját tank fölött: a gyorsító hőfoka és az életek
    if (own) this.tankViews.get(own.id)?.setOwnStatus(own.heat / BOOSTER.duration, own.overheated, -1);

    if (this.frame % 6 === 0) this.hud.setLoadout(this.loadoutOf(own));
    // a sarokban a verzió mellett a képkockaszám és a szerver válaszideje: ebből látszik, ha a gép vagy a hálózat lassú
    if (this.frame % 45 === 0) {
      const fps = Math.round(this.game.loop.actualFps);
      const ping = world.pingMs > 0 ? ` · ${world.pingMs} ms` : '';
      // halvány tipp: melyik billentyűvel lesz teljes képernyő (teljes képernyőn nem kell)
      const full = document.fullscreenEnabled && !isFullscreen() && this.bindings.fullscreen.length ? ` · ${keysText(this.bindings, 'fullscreen')}: teljes képernyő` : '';
      const text = `v${VERSION} · ${fps} fps${ping}${full}`;
      if (text !== this.shownStats) {
        this.shownStats = text;
        const box = document.getElementById('version');
        if (box) {
          box.textContent = text;
          box.classList.toggle('slow', fps < 45 || world.pingMs > 150);
        }
      }
    }

    // visszaszámláló óra és az állás
    const score = this.scoreText();
    if (world.timeLeft !== this.shownClock || score !== this.shownScore) {
      this.shownClock = world.timeLeft;
      this.shownScore = score;
      this.hud.setClock(world.timeLeft, score);
      // az óra hangjai: figyelmeztetés egy és fél perccel a vége előtt, kattogás az utolsó tíz másodpercben
      const second = Math.ceil(world.timeLeft);
      if (second !== this.lastSecond) {
        if (this.lastSecond > 0) {
          if (second === 60 || second === 30) this.sfx.warning();
          else if (second === 0) this.sfx.finish();
          else if (second <= 10) this.sfx.tick(second <= 3);
        }
        this.lastSecond = second;
      }
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
      `<p class="small">A legtöbb kilövés nyer (csak a játékosok kilövése számít)${bots}</p>`
    );
  }

  /** Az óra alatti sor: a saját kilövések száma, többjátékos meccsben a helyezés is. */
  private scoreText(): string {
    const world = this.world;
    const mine = world.standings.find((p) => p.tank === world.myId);
    if (!mine) return '';
    const rivals = world.standings.filter((p) => !p.gone);
    // egyedül nincs ellenséges játékos: a kilőtt botok száma látszik
    if (rivals.length < 2) return `${world.own?.botsDown ?? 0} kilőtt bot`;
    const place = 1 + rivals.filter((p) => p.kills > mine.kills || (p.kills === mine.kills && p.deaths < mine.deaths)).length;
    return `${mine.kills} kilövés · ${place}. hely`;
  }

  /** Ami éppen a tanknál van: a fegyver, a megmaradó képességek, majd a fogyó és az időre szóló tárgyak. */
  private loadoutOf(own: TankState | undefined): LoadoutItem[] {
    const items = this.loadout;
    items.length = 0;
    if (!own) return items;
    // az álcázás állapota mindig látszik: éppen tart, készen áll, vagy mennyi idő múlva használható
    const cloak = own.cloak > 0 ? `${Math.ceil(own.cloak)} mp` : own.cloakReady > 0 ? `${Math.ceil(own.cloakReady)} mp múlva` : 'kész';
    // a sáv elején mindig a tank szintje áll (ikon nélkül)
    items.push({ icon: '', label: `★ ${own.level}. szint · ${this.tierNames[tankTier(own.level)]}`, count: own.level >= LEVEL.max ? 'max' : own.botKills > 0 ? `bot ${own.botKills}/${LEVEL.botKills}` : '' });
    if (!own.alive) return items;
    items.push({ icon: '', label: `◈ Álcázás (${keysText(this.bindings, 'cloak')})`, count: cloak });
    const add = (kind: PickupKind, count = ''): void => {
      // amit billentyűvel lehet használni, annál a (beállított) billentyű is ott áll zárójelben
      const action = USE_KEY[kind];
      const key = action ? ` (${keysText(this.bindings, action)})` : '';
      items.push({ icon: this.iconUrl(kind), label: PICKUP_STYLE[kind].label + key, count });
    };
    if (own.weapon === 'flame') add('flame', `${Math.ceil(own.fuel)} mp`);
    else if (own.weapon) add(own.weapon);
    if (own.tripleShots > 0) add('triple', `${own.tripleShots} lövés`);
    if (own.shield > 0) add('shield', `×${own.shield}`);
    if (own.oil > 0) add('oil', `×${own.oil}`);
    if (own.turrets > 0) add('turret', `×${own.turrets}`);
    if (own.mines > 0) add('mine', `×${own.mines}`);
    if (own.smokes > 0) add('smoke', `×${own.smokes}`);
    if (own.strikes > 0) items.push({ icon: '', label: `✦ Tüzérségi csapás (${keysText(this.bindings, 'strike')})`, count: `×${own.strikes}` });
    for (const kind of TIMED_KINDS) if (own.effects[kind] > 0) add(kind, `${Math.ceil(own.effects[kind])} mp`);
    return items;
  }

  /** A szint és a tank típusa; ha van még erősebb típus, az is, hogy hányadik szinttől jár. */
  private levelText(level: number): string {
    const tier = tankTier(level);
    const next = LEVEL.tiers[tier + 1];
    return `${level}. – ${this.tierNames[tier]}` + (next ? ` (a ${next}. szinttől: ${this.tierNames[tier + 1]})` : '');
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
      state.push(['Életerő', `${Math.ceil(own.hp)} / ${tankMaxHp(own)}`], ['Szint', this.levelText(own.level)], ['Kilövés / halál', `${own.kills} / ${own.deaths}`], ['Kilőtt bot', `${own.botsDown}`]);
      state.push(['Fegyver', own.weapon ? PICKUP_STYLE[own.weapon].label : 'alaplövedék']);
      const extras: string[] = [];
      if (own.tripleShots > 0) extras.push(`${PICKUP_STYLE.triple.label} (${own.tripleShots} lövés)`);
      for (const kind of TIMED_KINDS) if (own.effects[kind] > 0) extras.push(`${PICKUP_STYLE[kind].label} (${Math.ceil(own.effects[kind])} mp)`);
      if (own.shield > 0) extras.push(`${PICKUP_STYLE.shield.label} ×${own.shield}`);
      if (own.oil > 0) extras.push(`${PICKUP_STYLE.oil.label} ×${own.oil}`);
      if (own.turrets > 0) extras.push(`${PICKUP_STYLE.turret.label} ×${own.turrets}`);
      if (own.mines > 0) extras.push(`${PICKUP_STYLE.mine.label} ×${own.mines}`);
      if (own.smokes > 0) extras.push(`${PICKUP_STYLE.smoke.label} ×${own.smokes}`);
      if (own.strikes > 0) extras.push(`tüzérségi csapás ×${own.strikes}`);
      state.push(['Sorozat', `${own.streak} kilövés halál nélkül (minden ${STRIKE.every}. után tüzérségi csapás jár)`]);
      if (extras.length) state.push(['Nálad van', extras.join(', ')]);
    }
    const players: [string, string][] = this.world.standings.map((p) => [escapeHtml(p.name), `${p.kills} kilövés · ${p.deaths} halál${p.gone ? ' (kilépett)' : ''}`]);
    const extra = this.map.data.meta.extraAttribution ? ` · ${this.map.data.meta.extraAttribution}` : '';
    return (
      `<h3>Irányítás</h3>${rows(controls)}` +
      `<h3>A tankod</h3>${rows(state)}` +
      `<h3>Játékosok – ${escapeHtml(s.name)}</h3>${rows(players)}` +
      `<p class="small">Játékmód: ${GAME_MODE_NAME[s.mode]} · időjárás: ${WEATHER_LABEL[s.weather]} · játékidő: ${s.minutes} perc · botok: ${this.world.room.plan.bots} · járművek: ${this.world.room.plan.traffic} · válaszidő: ${this.world.pingMs} ms<br />` +
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
          // a nagyobb tank ágyúja mélyebben szól; a telepített ágyúnak (nincs tankja) saját hangja van
          const gunner = world.tank(ev.tank);
          const size = gunner ? tankSize(gunner) : 1;
          if (ev.kind === 'laser') this.sfx.laser(volume);
          else if (ev.kind === 'rocket') this.sfx.rocket(volume);
          else if (ev.kind === 'heavy') this.sfx.heavyShot(volume, size);
          else if (ev.tank === 0) this.sfx.turretShot(volume);
          else this.sfx.shot(volume, size);
        }
        if (ev.kind !== 'laser') {
          const flash = this.flashPool.pop() ?? this.add.image(0, 0, TEX.flash).setOrigin(0.15, 0.5).setDepth(12);
          // a nagyobb tank torkolattüze is nagyobb
          const shooter = world.tank(ev.tank);
          flash.setOrigin(0.15, 0.5).setScale(this.spriteScale * (shooter ? tankSize(shooter) : 1)).setPosition(ev.x * ppm, ev.y * ppm).setRotation(ev.angle).setVisible(true);
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
        if (volume > 0) this.sfx.impact(ev.kind, Math.max(0.15, volume));
        this.boom(ev.x, ev.y, BLAST[ev.kind]);
        this.scar(ev.x, ev.y, SCAR[ev.kind]);
        this.weather.flash(ev.x, ev.y, 8 + BLAST[ev.kind] * 5, 0.3);
        // az eltalált épület teteje kigyullad
        const roof = this.map.roofNear(ev.x, ev.y);
        if (roof) this.fires.ignite(roof.x, roof.y, ROOF_FIRE[ev.kind].size, ROOF_FIRE[ev.kind].life);
        break;
      }
      case 'laser':
        this.beam(ev.tank, ev.x1, ev.y1, ev.x2, ev.y2);
        this.weather.flash((ev.x1 + ev.x2) / 2, (ev.y1 + ev.y2) / 2, Math.hypot(ev.x2 - ev.x1, ev.y2 - ev.y1) / 2 + 4, 0.2);
        break;
      case 'burn': {
        // a lángszóró lángja falat ért: a ház ott lángra kap (a közeli tüzek összeolvadnak és megnőnek)
        const roof = this.map.roofNear(ev.x, ev.y);
        this.fires.ignite(roof ? roof.x : ev.x, roof ? roof.y : ev.y, 1.5, 14);
        break;
      }
      case 'ricochet':
        if (this.loudness(ev.x, ev.y) > 0) this.sfx.ricochet(this.loudness(ev.x, ev.y));
        this.boom(ev.x, ev.y, 0.3);
        break;
      case 'pickup':
        if (mine) {
          const style = PICKUP_STYLE[ev.kind];
          this.sfx.pickup(ev.kind);
          this.hud.toast(`${style.label} – ${style.hint}`);
        }
        break;
      case 'oil':
        if (mine) this.sfx.oilDrop();
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
        if (ev.light) {
          // géppuska: apró, sorozatos találat – visszafogott jelzés, szám és rázkódás nélkül
          if (mine && this.time.now - this.lastPing > 140) {
            this.lastPing = this.time.now;
            this.sfx.ping();
          }
          if (mine && this.time.now - this.lastLightArc > 900) {
            this.lastLightArc = this.time.now;
            const gunner = world.tank(ev.by);
            if (gunner) this.hitFrom(gunner.x, gunner.y);
          }
          break;
        }
        // felröppenő sebzésszám: piros, ha engem ért; sárga, ha én okoztam; különben fehér
        if (ev.amount > 0) this.damageNumber(ev.x, ev.y, ev.amount, mine ? '#ff5a4a' : ev.by === myId ? '#ffd84a' : '#f0f0f0');
        if (mine) {
          this.sfx.hit(ev.absorbed !== null);
          this.cameras.main.shake(140, ev.absorbed ? 0.002 : 0.005);
          // honnan jött: a támadó felé mutató piros ív (ha nem látszik a támadó, a becsapódás iránya)
          const attacker = world.tank(ev.by);
          this.hitFrom(attacker ? attacker.x : ev.x, attacker ? attacker.y : ev.y);
        } else if (ev.by === myId) {
          this.sfx.hitMarker(ev.absorbed !== null);
        }
        break;
      case 'destroyed':
        this.boom(ev.x, ev.y, 3.2);
        this.scar(ev.x, ev.y, 3);
        this.fires.ignite(ev.x, ev.y, WRECK_FIRE.size, WRECK_FIRE.life);
        this.weather.flash(ev.x, ev.y, 26, 0.5);
        this.sfx.tankDestroyed(Math.max(0.4, this.loudness(ev.x, ev.y)));
        if (ev.by === myId && !mine) this.sfx.kill();
        this.killFeed(ev.tank, ev.by, ev.cause);
        // bosszú: aki kilőtt, az újraéledésem után egy ideig jelölve lesz; ha őt lövik ki, a jel megszűnik
        const avenged = this.revenge !== null && this.revenge.live && this.revenge.id === ev.tank && ev.by === myId;
        if (this.revenge && this.revenge.id === ev.tank) this.revenge = null;
        if (mine && ev.by > 0 && ev.by !== myId) this.revenge = { id: ev.by, until: 0, live: false };
        if (mine) {
          this.sfx.death();
          this.cameras.main.shake(400, 0.009);
          // ki és mivel: a jelzés az újraéledésig kint marad
          const killer = ev.by > 0 && ev.by !== myId ? world.nameOf(ev.by) : null;
          const text = escapeHtml(deathText(ev.cause, killer, ev.self === true));
          const shown = killer && killer !== 'Bot' ? text.replace(escapeHtml(killer), `<b>${escapeHtml(killer)}</b>`) : text;
          this.hud.showDeath(shown, this.lossNote);
          this.lossNote = '';
        } else if (ev.by === myId) {
          const name = world.nameOf(ev.tank);
          // a nem közvetlen kilövésnél (akna, löveg, tüzérség, robbanás) az is kiderül, mivel sikerült
          const how = ev.cause === 'shell' ? '' : ` – ${causeWith(ev.cause)}`;
          this.hud.toast((avenged ? 'Bosszú! ' : '') + (name === 'Bot' ? `Bot kilőve${how}!` : `Kilőtted: ${name}${how}!`) + (this.levelNote ? ` ${this.levelNote}` : ''));
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
        if (volume > 0) {
          // a fa recsegve-suhogva dől ki és puffan; az oszlop csak reccsen
          const felled = this.map.trees[ev.index];
          if (felled) this.sfx.treeFall(volume, felled.r / 3.2);
          else this.sfx.crack(volume);
        }
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
      case 'regrow':
        this.regrow(ev.what, ev.index, ev.x, ev.y);
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
        // az első ütés a falon nagyot döndül; amíg a tank a falnak feszül, a fal csikorog és pereg
        const since = this.time.now - (this.lastRam.get(ev.tank) ?? -Infinity);
        this.lastRam.set(ev.tank, this.time.now);
        if (since > 700) {
          this.sfx.wallHit(volume * (mine ? 1 : 0.8), size);
          if (mine) this.cameras.main.shake(140, 0.003 * size);
        } else {
          this.sfx.wallGrind(volume * 0.6, size);
          if (mine) this.cameras.main.shake(90, 0.0016 * size);
        }
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
        // egyszerre több szintet is léphet (erősebb ellenfél kilövéséért): típusváltás, ha átlépett egy határt
        const promoted = tier > tankTier(ev.level - ev.gain);
        const plus = ev.gain > 1 ? ` (+${ev.gain} szint az erősebb ellenfélért)` : '';
        const tank = world.tank(ev.tank);
        if (promoted && tank && this.loudness(tank.x, tank.y) > 0) this.flare(tank.x * ppm, tank.y * ppm, tankSize(tank));
        if (mine) {
          if (promoted) this.sfx.fanfare();
          else this.sfx.levelUp();
          // a szintlépést kiváltó kilövés eseménye közvetlenül ezután jön: az üzenete ezzel a szöveggel egészül ki
          this.levelNote = (promoted ? `${ev.level}. szint – új tank: ${this.tierNames[tier]}!` : `${ev.level}. szint: nagyobb, erősebb tank.`) + plus;
          this.hud.toast(this.levelNote);
        }
        break;
      }
      case 'leveldown':
        // a kilövés eseménye közvetlenül ezután jön: az üzenete ezzel egészül ki
        if (mine) {
          this.lossNote = `${ev.lost} szintet vesztettél: ${ev.level}. szint.`;
          this.sfx.levelDown();
        }
        break;
      case 'mg': {
        // a kiegészítő géppuska lövése: nyomjelző, apró torkolattűz, a fegyver a cél felé fordul
        const angle = Math.atan2(ev.y2 - ev.y1, ev.x2 - ev.x1);
        this.tankViews.get(ev.tank)?.mgFire(angle, this.time.now / 1000);
        this.tracer(ev.x1, ev.y1, ev.x2, ev.y2);
        const volume = mine ? 0.8 : this.loudness(ev.x1, ev.y1) * 0.6;
        if (volume > 0) this.sfx.mg(volume);
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
          this.sfx.vehicleBlast(Math.max(0.3, volume), size / 2.4);
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
          this.sfx.deploy();
          this.hud.toast('Löveg telepítve – lő minden ellenségre a közelében');
        }
        break;
      case 'mine':
        if (mine) {
          this.sfx.mineLay();
          this.hud.toast('Akna lerakva – az ellenfél alatt robban');
        }
        break;
      case 'smoke': {
        const volume = mine ? 1 : this.loudness(ev.x, ev.y);
        if (volume > 0) this.sfx.smokeHiss(volume);
        // a kieresztés pillanata: sűrű füstsugarak csapnak ki a tank körül
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2 + ev.tank;
          const d = 1.5 + (i % 3) * 1.4;
          this.puff((ev.x + Math.cos(a) * d) * ppm, (ev.y + Math.sin(a) * d) * ppm, 0xd4d8dc, 1.6 + (i % 4) * 0.4, 700 + i * 60);
        }
        break;
      }
      case 'strike': {
        // figyelmeztető kör a földön, amíg a lövedékek hullanak; a térképen is látszik
        const length = ev.delay + STRIKE.shells * STRIKE.interval + 0.4;
        this.strikeMarks.push({ x: ev.x, y: ev.y, until: this.time.now / 1000 + length });
        const ring = this.add
          .image(ev.x * ppm, ev.y * ppm, GTEX.ring)
          .setDepth(8.5)
          .setTint(0xff3a2a)
          .setScale((ev.radius * ppm) / 48)
          .setAlpha(0.9);
        this.tweens.add({ targets: ring, alpha: 0.35, duration: 220, yoyo: true, repeat: -1 });
        this.time.delayedCall(length * 1000, () => ring.destroy());
        const volume = mine ? 1 : this.loudness(ev.x, ev.y);
        if (volume > 0) this.sfx.incoming(Math.max(0.4, volume));
        const own = world.own;
        if (mine) this.hud.toast('Tüzérségi csapás úton!');
        else if (own && own.alive && Math.hypot(own.x - ev.x, own.y - ev.y) < ev.radius + 12) this.hud.toast('Tüzérségi csapás érkezik – ki a piros körből!');
        break;
      }
      case 'boom': {
        // akna, gázpalack vagy tüzérségi lövedék robbanása
        const size = ev.kind === 'barrel' ? 3 : ev.kind === 'mine' ? 2.5 : 2.7;
        this.boom(ev.x, ev.y, size);
        this.scar(ev.x, ev.y, size * 0.9);
        this.weather.flash(ev.x, ev.y, ev.radius * 2.4, 0.45);
        if (ev.kind === 'barrel') this.fires.ignite(ev.x, ev.y, 1.9, 16);
        const volume = this.loudness(ev.x, ev.y);
        if (volume > 0) {
          if (ev.kind === 'barrel') this.sfx.vehicleBlast(Math.max(0.3, volume), 1.1);
          else this.sfx.explosion(Math.max(0.3, volume) * 1.2, ev.kind === 'shell' ? 1.5 : 1.2);
          this.cameras.main.shake(220, 0.006 * volume);
        }
        break;
      }
      case 'streak':
        if (mine) {
          this.sfx.streak();
          // a kilövés üzenete után jelenik meg, hogy ne írja felül
          const text = `${ev.streak} kilövés egyhuzamban – tüzérségi csapás jár! ${keysText(this.bindings, 'strike')}: nagy térkép, kattints a célpontra`;
          this.time.delayedCall(1700, () => this.hud.toast(text));
        }
        break;
      case 'cloak':
        if (mine) {
          this.sfx.cloak(ev.on);
          if (ev.on) this.hud.toast(`Álcázás ${CLOAK.duration} másodpercig – a lövés leleplez!`);
        }
        break;
      case 'superSoon':
        this.superMark = { x: ev.x, y: ev.y, here: false, since: this.time.now / 1000 };
        this.sfx.announce();
        this.hud.toast(`Szupertárgy érkezik ${ev.seconds} másodperc múlva – a térképen lila jel mutatja!`);
        break;
      case 'superHere':
        this.superMark = { x: ev.x, y: ev.y, here: true, since: this.time.now / 1000 };
        this.sfx.announce();
        this.hud.toast('Megjelent a szupertárgy – aki felveszi, háromszorosat sebez!');
        break;
      case 'turretDown':
        this.boom(ev.x, ev.y, 1.9);
        this.scar(ev.x, ev.y, 1.5);
        this.weather.flash(ev.x, ev.y, 16, 0.4);
        if (this.loudness(ev.x, ev.y) > 0) this.sfx.turretDown(Math.max(0.3, this.loudness(ev.x, ev.y)));
        if (ev.owner === myId) this.hud.toast('Megsemmisült az egyik ágyúd!');
        break;
      case 'respawn': {
        const tank = world.tank(ev.tank);
        if (tank) this.tankViews.get(ev.tank)?.snap(tank);
        if (mine) {
          this.sfx.respawn();
          if (this.revenge && !this.revenge.live) {
            this.revenge.live = true;
            this.revenge.until = this.time.now / 1000 + REVENGE_SECONDS;
            const name = world.nameOf(this.revenge.id);
            this.sfx.revenge();
            this.hud.toast(`Bosszú: ${name === 'Bot' ? 'a bot, amelyik kilőtt,' : name} ${REVENGE_SECONDS} másodpercig jelölve van!`);
          }
        }
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

  /** A javítóműhelyek: padló a tankok alatt, áttetsző tetőváz fölöttük, villogó jelzőfény és felirat. */
  private buildWorkshops(): void {
    const ppm = this.ppm;
    const scale = this.spriteScale;
    for (const shop of this.world.workshops) {
      const x = shop.x * ppm;
      const y = shop.y * ppm;
      this.add.image(x, y, GTEX.shopFloor).setScale(scale).setDepth(1.6);
      // a tető a tankok és a lombok fölött van, de az életerősávok alatt
      this.add.image(x, y, GTEX.shopRoof).setScale(scale).setDepth(16.4);
      this.shopLights.push(this.add.image(x, y - (WORKSHOP.height / 2) * ppm + 13 * scale, GTEX.light).setScale(scale * 0.55).setTint(0x60ff90).setBlendMode(Phaser.BlendModes.ADD).setDepth(16.6));
      this.add
        .text(x, y - (WORKSHOP.height / 2) * ppm - 4 * scale, 'JAVÍTÓMŰHELY', { fontFamily: 'Consolas, "Lucida Console", monospace', fontStyle: 'bold', fontSize: `${Math.round(15 * scale)}px`, color: '#ffffff', backgroundColor: '#2ea050', padding: { x: 6, y: 2 } })
        .setOrigin(0.5, 1)
        .setDepth(17);
    }
  }

  /** A műhely jelzőfénye lüktet; ha a saját tank benne áll és sérült, javítás közben szikrázik és kattog. */
  private updateWorkshop(own: TankState | undefined, seconds: number): void {
    const shops = this.world.workshops;
    if (shops.length === 0) return;
    const pulse = 0.55 + 0.45 * Math.sin(seconds * 4);
    for (const light of this.shopLights) light.setAlpha(pulse);
    const inside = !!own && own.alive && shops.some((s) => Math.hypot(own.x - s.x, own.y - s.y) <= WORKSHOP.radius);
    if (inside && !this.inShop) this.hud.toast('Javítóműhely – amíg bent állsz, a tankod javul');
    this.inShop = inside;
    if (!own || !inside || own.hp >= tankMaxHp(own)) return;
    if (seconds - this.lastWrench > 0.55) {
      this.lastWrench = seconds;
      this.sfx.wrench();
      // szikrák a tank körül
      const size = tankSize(own) * this.ppm;
      for (let i = 0; i < 3; i++) {
        const a = seconds * 3 + i * 2.1;
        this.puff(own.x * this.ppm + Math.cos(a) * 2.2 * size, own.y * this.ppm + Math.sin(a) * 2.2 * size, 0x9dffb8, 0.4, 260);
      }
    }
  }

  /**
   * A csapás gombja: ha van kérhető csapás, feljön a nagy térkép, és csak azon lehet célpontot
   * választani (kattintással); újra megnyomva, vagy Esc-re a térkép bezárul.
   */
  private aimStrike(): void {
    const own = this.world.own;
    if (!own || !own.alive) return;
    if (own.strikes <= 0) {
      this.hud.toast(`Nincs kérhető tüzérségi csapás – ${STRIKE.every} kilövés kell hozzá halál nélkül`);
      return;
    }
    if (this.hud.mapOpen) {
      this.hud.toggleMap();
      return;
    }
    this.hud.toggleMap();
    this.strikeAim = true;
    this.hud.toast('Tüzérségi csapás: kattints a térképen oda, ahová kéred (M, X vagy Esc: mégsem)');
  }

  /** Tüzérségi csapás kérése a térképen kijelölt helyre. Igazat ad, ha a kérés elment. */
  private requestStrike(x: number, y: number): boolean {
    const own = this.world.own;
    if (!own || !own.alive) return false;
    if (own.strikes <= 0) {
      this.hud.toast(`Nincs kérhető tüzérségi csapás – ${STRIKE.every} kilövés kell hozzá halál nélkül`);
      return false;
    }
    this.strikeLatch = { x, y };
    this.sfx.radio();
    return true;
  }

  /** Álcázás kérése; ha még nem használható, megmondja, mennyi idő múlva lesz az. */
  private requestCloak(): void {
    const own = this.world.own;
    if (!own || !own.alive) return;
    if (own.cloak > 0) return;
    if (own.cloakReady > 0) {
      this.hud.toast(`Az álcázás ${Math.ceil(own.cloakReady)} másodperc múlva használható újra`);
      return;
    }
    this.cloakLatch = true;
  }

  /** Új sor a kilövési értesítőbe: ki kit lőtt ki (a saját nevem kiemelve). */
  private killFeed(victimId: number, killerId: number, cause: KillCause): void {
    const world = this.world;
    const tag = (id: number): string => {
      const name = world.nameOf(id);
      const cls = id === world.myId ? 'me' : name === 'Bot' ? 'bot' : '';
      return `<span class="${cls}">${escapeHtml(name)}</span>`;
    };
    const victimBot = world.nameOf(victimId) === 'Bot';
    if (killerId > 0 && killerId !== victimId) {
      this.hud.feed(`${tag(killerId)}<span class="x">✖</span>${tag(victimId)}<span class="how">${CAUSE_LABEL[cause]}</span>`);
    } else if (!victimBot) {
      // senkinek nem jár érte pont: robbanásban (gázpalack, jármű) halt meg
      this.hud.feed(`<span class="x">✖</span>${tag(victimId)} felrobbant<span class="how">${CAUSE_LABEL[cause]}</span>`);
    }
  }

  /** Felröppenő sebzésszám a találat helyén. */
  private damageNumber(x: number, y: number, amount: number, color: string): void {
    const px = x * this.ppm;
    const py = y * this.ppm;
    const v = this.view;
    if (px < v.x || px > v.right || py < v.y || py > v.bottom) return;
    const scale = this.spriteScale;
    const text =
      this.numberPool.pop() ??
      this.add
        .text(0, 0, '', { fontFamily: 'Consolas, "Lucida Console", monospace', fontStyle: 'bold', fontSize: `${Math.round(18 * scale)}px`, stroke: '#101418', strokeThickness: Math.max(3, Math.round(4 * scale)) })
        .setOrigin(0.5)
        .setDepth(19.6);
    const jitter = (((this.frame * 13 + amount * 7) % 21) - 10) * scale;
    text
      .setText(String(amount))
      .setColor(color)
      .setPosition(px + jitter, py - 16 * scale)
      .setScale(amount >= 50 ? 1.35 : 1)
      .setAlpha(1)
      .setVisible(true);
    this.tweens.add({
      targets: text,
      y: py - 56 * scale,
      alpha: 0,
      duration: 850,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        text.setVisible(false);
        this.numberPool.push(text);
      },
    });
  }

  /**
   * A géppuska egy lövése. Nem összefüggő vonal: a lövedék rövid csíkként repül a csőtől a
   * célig (minden harmadik fényes nyomjelző, a többi halvány), a csőnél villódzó torkolattűz,
   * oldalra kirepülő hüvely, a becsapódásnál szikra és felverődő por.
   */
  private tracer(x1: number, y1: number, x2: number, y2: number): void {
    const ppm = this.ppm;
    const v = this.view;
    if (Math.max(x1, x2) * ppm < v.x || Math.min(x1, x2) * ppm > v.right || Math.max(y1, y2) * ppm < v.y || Math.min(y1, y2) * ppm > v.bottom) return;
    const s = this.spriteScale;
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const round = this.mgRound++;
    const bright = round % 3 === 0;

    // a repülő lövedék: a csík eleje a lövedék, mögötte rövid fénycsóva
    const length = Math.min(dist * 0.6, bright ? 4.4 : 2.2);
    const bullet = this.tracerPool.pop() ?? this.add.image(0, 0, GTEX.px).setDepth(12.5);
    bullet
      .setOrigin(1, 0.5)
      .setTint(bright ? 0xfff3b8 : 0xffcf78)
      .setPosition((x1 + cos * length) * ppm, (y1 + sin * length) * ppm)
      .setRotation(angle)
      .setDisplaySize(length * ppm, (bright ? 2.4 : 1.4) * s)
      .setAlpha(bright ? 1 : 0.5)
      .setVisible(true);
    this.tweens.add({
      targets: bullet,
      x: x2 * ppm,
      y: y2 * ppm,
      duration: Math.max(35, ((dist - length) / 170) * 1000),
      onComplete: () => {
        bullet.setVisible(false);
        this.tracerPool.push(bullet);
        // becsapódás: apró szikra, minden második lövésnél felverődő por
        const spark = this.flashPool.pop() ?? this.add.image(0, 0, TEX.flash).setDepth(12);
        spark.setOrigin(0.5, 0.5).setScale(s * (0.14 + Math.random() * 0.1)).setPosition(x2 * ppm, y2 * ppm).setRotation(Math.random() * 6.28).setVisible(true);
        this.time.delayedCall(40, () => {
          spark.setVisible(false);
          this.flashPool.push(spark);
        });
        if ((round & 1) === 0) this.puff(x2 * ppm, y2 * ppm, 0xcbbfa8, 0.4, 240);
      },
    });

    // torkolattűz: lövésenként más méretű és kicsit más irányú, ettől villódzik
    const flash = this.flashPool.pop() ?? this.add.image(0, 0, TEX.flash).setDepth(12);
    flash
      .setOrigin(0.15, 0.5)
      .setScale(s * (0.32 + Math.random() * 0.22))
      .setPosition(x1 * ppm, y1 * ppm)
      .setRotation(angle + (Math.random() - 0.5) * 0.3)
      .setVisible(true);
    this.time.delayedCall(38, () => {
      flash.setVisible(false);
      this.flashPool.push(flash);
    });
    if (bright) this.puff((x1 + cos * 0.4) * ppm, (y1 + sin * 0.4) * ppm, 0xd6d6d6, 0.28, 280);

    // a kirepülő hüvely: a fegyver tokjától oldalra pattan, pörög, és a földön elhalványul
    const casing = this.casingPool.pop() ?? this.add.image(0, 0, GTEX.px).setDepth(11.6).setTint(0xdcb450);
    const side = angle + Math.PI / 2 + (Math.random() - 0.5) * 0.9;
    const throwDist = 1.5 + Math.random() * 1.4;
    const bx = x1 - cos * 1.3;
    const by = y1 - sin * 1.3;
    casing
      .setPosition(bx * ppm, by * ppm)
      .setDisplaySize(3.4 * s, 1.5 * s)
      .setRotation(angle)
      .setAlpha(1)
      .setVisible(true);
    this.tweens.add({
      targets: casing,
      x: (bx + Math.cos(side) * throwDist) * ppm,
      y: (by + Math.sin(side) * throwDist) * ppm,
      rotation: angle + 5 + Math.random() * 4,
      duration: 300 + Math.random() * 120,
      ease: 'Quad.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: casing,
          alpha: 0,
          duration: 500,
          delay: 250,
          onComplete: () => {
            casing.setVisible(false);
            this.casingPool.push(casing);
          },
        });
      },
    });
  }

  /** Piros ív a saját tank körül abban az irányban, ahonnan a találat jött. */
  private hitFrom(sx: number, sy: number): void {
    const own = this.world.own;
    const view = own ? this.tankViews.get(own.id) : undefined;
    if (!own || !view) return;
    const dx = sx - own.x;
    const dy = sy - own.y;
    if (Math.hypot(dx, dy) < 1.5) return;
    const angle = Math.atan2(dy, dx);
    // a textúrán az ív középpontja 102 pixellel a kép közepe mögött van: így az ív a tank köré esik
    const r = 102 * this.spriteScale;
    const arc = this.arcPool.pop() ?? this.add.image(0, 0, GTEX.hitArc).setDepth(19.4);
    arc
      .setPosition(view.px + Math.cos(angle) * r, view.py + Math.sin(angle) * r)
      .setRotation(angle)
      .setScale(this.spriteScale)
      .setAlpha(0.95)
      .setVisible(true);
    this.tweens.add({
      targets: arc,
      alpha: 0,
      duration: 1100,
      ease: 'Quad.easeIn',
      onComplete: () => {
        arc.setVisible(false);
        this.arcPool.push(arc);
      },
    });
  }

  /** GPS-cél a pálya egy pontjára: a GPS a normál utakon vezet oda. */
  private setGps(x: number, y: number): void {
    const own = this.world.own;
    const area = this.map.bounds ?? { minX: 0, minY: 0, maxX: this.map.width, maxY: this.map.height };
    this.nav ??= new RoadNav(this.map.data.roads, area);
    const tx = Math.max(area.minX + 1, Math.min(area.maxX - 1, x));
    const ty = Math.max(area.minY + 1, Math.min(area.maxY - 1, y));
    const from = own ?? this.world.focus;
    const route = from ? this.nav.route(from.x, from.y, tx, ty) : null;
    if (!route) {
      this.hud.toast('Ide nem vezet út a játéktéren belül');
      return;
    }
    this.gps = { x: tx, y: ty, route, plannedAt: this.time.now / 1000 };
    this.sfx.ping();
    this.hud.toast(`GPS: ${Math.round(route.length)} m – kövesd a kék vonalat (${keysText(this.bindings, 'gps')} vagy jobb klikk a térképen: kikapcsolás)`);
  }

  /** A GPS kikapcsolása (a cél törlése). */
  private gpsOff(): void {
    if (!this.gps) return;
    this.gps = null;
    this.hud.toast('GPS kikapcsolva');
  }

  /**
   * A GPS képkockánként: fél másodpercenként újratervez a tank helyéről (ha letért, onnan vezet
   * tovább), a talajra rajzolja az útvonalat (a cél felé áramló sárga szaggatott vonal), a kép
   * szélén nyíl mutat a cél felé, és megérkezéskor kikapcsol. A térképnek az útvonalat adja vissza.
   */
  private updateGps(view: Phaser.Geom.Rectangle): HudFrame['gps'] {
    const gps = this.gps;
    const own = this.world.own;
    if (!gps || !this.nav) {
      this.gpsLine?.clear();
      this.gpsArrow?.setVisible(false);
      this.hud.setGps('');
      return null;
    }
    const now = this.time.now / 1000;
    // a tank ott, ahol a képen látszik (így a vonal eleje pontosan a tanknál van, gyors menetben is)
    const shown = own ? this.tankViews.get(own.id)?.shownPx : undefined;
    const tx = shown ? shown.x / this.ppm : own?.x;
    const ty = shown ? shown.y / this.ppm : own?.y;
    const trim = (): ReturnType<typeof trimRoute> | null => (gps.route && tx !== undefined && ty !== undefined ? trimRoute(gps.route.points, tx, ty) : null);
    let trimmed = trim();
    // újratervezés fél másodpercenként, vagy azonnal, ha a tank letért az útvonalról
    if (own && own.alive && (now - gps.plannedAt > 0.5 || (trimmed !== null && trimmed.off > 8))) {
      gps.plannedAt = now;
      gps.route = this.nav.route(own.x, own.y, gps.x, gps.y) ?? gps.route;
      trimmed = trim();
    }
    const planned = gps.route;
    if (!planned) return null;
    const route: Route = trimmed ? { points: trimmed.points, length: trimmed.length, end: planned.end } : planned;
    // megérkezett: az út végéhez (a célhoz legközelebbi útponthoz) vagy a célhoz ért
    if (own && own.alive && (Math.hypot(own.x - route.end.x, own.y - route.end.y) < 10 || Math.hypot(own.x - gps.x, own.y - gps.y) < 10)) {
      this.gps = null;
      this.sfx.ping();
      this.hud.toast('Megérkeztél a célhoz – a GPS kikapcsolt');
      return this.updateGps(view);
    }
    this.drawGps(route, gps, view, now);
    this.gpsArrow ??= this.add.image(0, 0, GTEX.arrow).setDepth(19.4).setTint(0x38a8ff).setScale(this.spriteScale * 0.85);
    this.pointAt(this.gpsArrow, gps.x, gps.y, view);
    const rest = route.length + Math.hypot(gps.x - route.end.x, gps.y - route.end.y);
    this.hud.setGps(`GPS ${rest >= 1000 ? `${(rest / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(rest / 10) * 10} m`} · ${keysText(this.bindings, 'gps')}: ki`);
    return { route: route.points, end: route.end, target: gps };
  }

  /**
   * Az útvonal a talajon, mint az autós navigációban: áttetsző kék sáv, rajta a cél felé áramló
   * fehér nyilacskák (nem keverhető össze az út sárga felezővonalával); a végén a célzászló.
   */
  private drawGps(route: Route, target: { x: number; y: number }, view: Phaser.Geom.Rectangle, now: number): void {
    const g = (this.gpsLine ??= this.add.graphics().setDepth(2.4));
    g.clear();
    const ppm = this.ppm;
    const p = route.points;
    const margin = 30 * ppm;
    const visible = (x1: number, y1: number, x2: number, y2: number): boolean =>
      Math.max(x1, x2) > view.x - margin && Math.min(x1, x2) < view.right + margin && Math.max(y1, y2) > view.y - margin && Math.min(y1, y2) < view.bottom + margin;
    // halvány kék sáv (az út jól látszik alatta)
    g.lineStyle(2 * ppm, 0x38a8ff, 0.2);
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x1 = p[i] * ppm;
      const y1 = p[i + 1] * ppm;
      const x2 = p[i + 2] * ppm;
      const y2 = p[i + 3] * ppm;
      if (visible(x1, y1, x2, y2)) g.lineBetween(x1, y1, x2, y2);
    }
    // a nyilacskák a cél felé áramlanak
    const period = 5;
    let along = -((now * 7) % period);
    g.lineStyle(0.26 * ppm, 0xffffff, 0.5);
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const ay = p[i + 1];
      const len = Math.hypot(p[i + 2] - ax, p[i + 3] - ay);
      if (len > 0 && visible(ax * ppm, ay * ppm, p[i + 2] * ppm, p[i + 3] * ppm)) {
        const ux = (p[i + 2] - ax) / len;
        const uy = (p[i + 3] - ay) / len;
        // az első nyilacska helye ezen a szakaszon
        for (let d = ((-along % period) + period) % period; d < len; d += period) {
          // csúcsa előre mutat, a két szára hátra és oldalra
          const tx = (ax + ux * d) * ppm;
          const ty = (ay + uy * d) * ppm;
          const bx = tx - ux * 0.8 * ppm;
          const by = ty - uy * 0.8 * ppm;
          g.lineBetween(bx - uy * 0.65 * ppm, by + ux * 0.65 * ppm, tx, ty);
          g.lineBetween(bx + uy * 0.65 * ppm, by - ux * 0.65 * ppm, tx, ty);
        }
      }
      along += len;
    }
    // az út végétől a célig pontozva (ha a cél nem az úton van)
    const { end } = route;
    const off = Math.hypot(target.x - end.x, target.y - end.y);
    if (off > 2) {
      g.fillStyle(0xffffff, 0.8);
      for (let d = 1.5; d < off; d += 2) {
        const k = d / off;
        g.fillCircle((end.x + (target.x - end.x) * k) * ppm, (end.y + (target.y - end.y) * k) * ppm, 0.22 * ppm);
      }
    }
    // célzászló: lüktető kék gyűrű, rúd, lobogó
    const fx = target.x * ppm;
    const fy = target.y * ppm;
    const pulse = (now * 0.8) % 1;
    g.lineStyle(0.3 * ppm, 0x38a8ff, 0.9 * (1 - pulse));
    g.strokeCircle(fx, fy, (1.5 + pulse * 4) * ppm);
    g.fillStyle(0x101418, 0.9);
    g.fillRect(fx - 0.12 * ppm, fy - 3.2 * ppm, 0.24 * ppm, 3.2 * ppm);
    g.fillStyle(0x38a8ff, 1);
    g.fillTriangle(fx + 0.1 * ppm, fy - 3.2 * ppm, fx + 2.2 * ppm, fy - 2.6 * ppm, fx + 0.1 * ppm, fy - 2 * ppm);
  }

  /** Nyíl a célpont fölött, vagy – ha nincs a képen – a kép szélén, a célpont felé mutatva. */
  private pointAt(arrow: Phaser.GameObjects.Image, wx: number, wy: number, view: Phaser.Geom.Rectangle): void {
    const px = wx * this.ppm;
    const py = wy * this.ppm;
    const pad = 54 * this.spriteScale;
    const bob = Math.sin(this.time.now / 160) * 5 * this.spriteScale;
    if (px > view.x + pad && px < view.right - pad && py > view.y + pad * 2 && py < view.bottom - pad) {
      arrow.setPosition(px, py - 62 * this.spriteScale + bob).setRotation(Math.PI / 2);
    } else {
      const dx = px - view.centerX;
      const dy = py - view.centerY;
      const k = Math.min((view.width / 2 - pad) / Math.max(1, Math.abs(dx)), (view.height / 2 - pad) / Math.max(1, Math.abs(dy)));
      const angle = Math.atan2(dy, dx);
      arrow.setPosition(view.centerX + dx * k + Math.cos(angle) * bob, view.centerY + dy * k + Math.sin(angle) * bob).setRotation(angle);
    }
    arrow.setVisible(true);
  }

  /** A térkép külön jelei és a képernyőn a hozzájuk tartozó nyilak: bosszú, szupertárgy, tüzérségi csapás. */
  private updateMarks(view: Phaser.Geom.Rectangle): MapMark[] {
    const world = this.world;
    const now = this.time.now / 1000;
    const marks = this.marks;
    marks.length = 0;
    // a javítóműhelyek mindig látszanak a térképen
    for (const shop of world.workshops) marks.push({ kind: 'workshop', x: shop.x, y: shop.y });
    for (let i = this.strikeMarks.length - 1; i >= 0; i--) {
      if (this.strikeMarks[i].until < now) this.strikeMarks.splice(i, 1);
      else marks.push({ kind: 'strike', x: this.strikeMarks[i].x, y: this.strikeMarks[i].y });
    }

    // szupertárgy: a bejelentéstől a felvételéig látszik (ha a bejelentésről lemaradtunk, a tárgyból is kiderül)
    const item = world.pickups.find((p) => p.kind === 'super');
    if (!this.superMark && item) this.superMark = { x: item.x, y: item.y, here: true, since: now - 5 };
    if (this.superMark && this.superMark.here && !item && now - this.superMark.since > 1.5) this.superMark = null;
    if (this.superMark) {
      marks.push({ kind: this.superMark.here ? 'super' : 'superSoon', x: this.superMark.x, y: this.superMark.y });
      this.superArrow ??= this.add.image(0, 0, GTEX.arrow).setDepth(19.5).setTint(0xb45cff).setScale(this.spriteScale);
      this.superArrow.setAlpha(this.superMark.here ? 1 : 0.6);
      this.pointAt(this.superArrow, this.superMark.x, this.superMark.y, view);
    } else this.superArrow?.setVisible(false);

    // bosszú: aki kilőtt, az újraéledés után egy ideig jelölve van
    const revenge = this.revenge;
    const target = revenge && revenge.live ? world.tank(revenge.id) : undefined;
    if (revenge && revenge.live && now > revenge.until) this.revenge = null;
    if (this.revenge && target && target.alive && !(target.cloak > 0) && !world.smokes.some((k) => insideSmoke(k, target.x, target.y))) {
      // a térképen csak a bot jelölhető: az ellenséges játékos ott nem látszik (a nyíl a képen igen)
      if (target.bot) marks.push({ kind: 'revenge', x: target.x, y: target.y });
      this.revengeArrow ??= this.add.image(0, 0, GTEX.arrow).setDepth(19.5).setTint(0xff3a2a).setScale(this.spriteScale);
      this.pointAt(this.revengeArrow, target.x, target.y, view);
    } else this.revengeArrow?.setVisible(false);
    return marks;
  }

  /** A szerverállapot egy listájához tartozó álló képek egyeztetése (azonosító szerint). */
  private syncStatic<T extends { id: number }>(views: Map<number, Phaser.GameObjects.Image>, items: readonly T[], make: (item: T) => Phaser.GameObjects.Image): void {
    for (const item of items) if (!views.has(item.id)) views.set(item.id, make(item));
    for (const [id, view] of views) {
      if (!items.some((item) => item.id === id)) {
        view.destroy();
        views.delete(id);
      }
    }
  }

  /** Aknák, gázpalackok és füstfelhők. */
  private syncGadgets(seconds: number): void {
    const world = this.world;
    const ppm = this.ppm;
    if (world.listsChanged) {
      // a saját akna jól látszik, az ellenfélé alig
      this.syncStatic(this.mineViews, world.mines, (m) =>
        this.add
          .image(m.x * ppm, m.y * ppm, GTEX.mine)
          .setDepth(3)
          .setScale(this.spriteScale * (m.owner === world.myId ? 1 : 0.85))
          .setAlpha(m.owner === world.myId ? 1 : 0.3),
      );
      this.syncStatic(this.barrelViews, world.barrels, (b) =>
        this.add
          .image(b.x * ppm, b.y * ppm, GTEX.barrel)
          .setDepth(4)
          .setScale((BARREL.radius * 1.2 * ppm) / 10.5)
          .setRotation((b.id * 2.3) % 6.28),
      );
      for (const smoke of world.smokes) {
        if (this.smokeViews.has(smoke.id)) continue;
        const x = smoke.x * ppm;
        const y = smoke.y * ppm;
        // a felhő a tankok és az életerősávok fölött van (ami benne áll, az nem látszik), az árnyéka a földön
        const core = [0, 1].map(() => this.add.image(x, y, GTEX.cloud).setDepth(18.6).setAlpha(0));
        const puffs: Phaser.GameObjects.Image[] = [];
        for (let i = 0; i < SMOKE_PUFFS; i++) {
          // belül sötétebb, sűrűbb; a szélén világosabb, ritkább füst
          const ring = Math.sqrt((i + 0.5) / SMOKE_PUFFS);
          const shade = Math.round(196 + 44 * ring + ((smoke.id * 7 + i * 13) % 14));
          puffs.push(
            this.add
              .image(x, y, `${GTEX.puff}${(smoke.id + i) % PUFF_VARIANTS}`)
              .setDepth(18.61 + i * 0.0005)
              .setAlpha(0)
              .setTint((shade << 16) | (shade << 8) | Math.min(255, shade + 4)),
          );
        }
        const shadow = this.add.image(x, y, GTEX.cloud).setDepth(3.6).setTint(0x000000).setAlpha(0);
        this.smokeViews.set(smoke.id, { core, puffs, shadow, life: smoke.life, at: this.time.now });
      }
      for (const [id, view] of this.smokeViews) {
        if (!world.smokes.some((s) => s.id === id)) {
          for (const image of [...view.core, ...view.puffs, view.shadow]) image.destroy();
          this.smokeViews.delete(id);
        }
      }
    }
    if (this.smokeViews.size === 0) return;
    const own = world.own;
    const now = this.time.now;
    for (const smoke of world.smokes) {
      const view = this.smokeViews.get(smoke.id);
      if (!view) continue;
      // a szerver másodpercenként hússzor küldi a hátralévő időt: közte a saját óránkkal számolunk, hogy a felhő simán mozogjon
      if (smoke.life !== view.life) {
        view.life = smoke.life;
        view.at = now;
      }
      const life = Math.max(0, view.life - Math.min(0.25, (now - view.at) / 1000));
      const age = SMOKE.life - life;
      const r = smokeRadius(age);
      const cx = smoke.x + SMOKE.windX * age;
      const cy = smoke.y + SMOKE.windY * age;
      // aki benne áll, az a saját közelét halványan látja
      const inside = !!own && own.alive && Math.hypot(own.x - cx, own.y - cy) < r * 0.9;
      const dim = inside ? 0.5 : 1;
      // a sűrű mag: gyorsan felgomolyog, a végén lassan oszlik el
      const fade = Math.max(0, Math.min(1, age / 0.7, life / 1.8));
      const base = (r * ppm) / 104;
      view.core[0].setPosition(cx * ppm, cy * ppm).setAlpha(fade * 0.96 * dim).setRotation(seconds * 0.05 + smoke.id).setScale(base * 0.86);
      view.core[1].setPosition(cx * ppm, cy * ppm).setAlpha(fade * 0.8 * dim).setRotation(-seconds * 0.04 + smoke.id * 2).setScale(base * (0.74 + 0.04 * Math.sin(seconds * 0.7 + smoke.id)));
      view.shadow.setPosition((cx + 2.2) * ppm, (cy + 3) * ppm).setAlpha(fade * 0.2).setScale(base * 0.95);
      // a gomolyagok: a közepéből kifelé terjednek, lassan forognak és lüktetnek; a széle foszlik el először
      for (let i = 0; i < view.puffs.length; i++) {
        const ring = Math.sqrt((i + 0.5) / view.puffs.length);
        const h = ((smoke.id * 31 + i * 17) % 23) / 22;
        const a = i * 2.399963 + smoke.id * 1.7 + Math.sin(seconds * 0.11 + i) * 0.25;
        const d = ring * 0.8 * r;
        const px = cx + Math.cos(a) * d + Math.cos(seconds * (0.23 + h * 0.2) + i * 1.3) * 0.045 * r;
        const py = cy + Math.sin(a) * d + Math.sin(seconds * (0.19 + h * 0.2) + i * 2.1) * 0.045 * r;
        const born = Math.max(0, Math.min(1, (age - ring * 0.6) / 0.9));
        const gone = Math.min(1, life / (1.2 + 3 * ring));
        const size = r * (0.36 + 0.16 * h) * (0.75 + 0.25 * born) * (1 + 0.05 * Math.sin(seconds * (0.5 + h * 0.4) + i));
        view.puffs[i]
          .setPosition(px * ppm, py * ppm)
          .setScale((size * ppm) / (PUFF_SIZE * 0.36))
          .setRotation(seconds * (h - 0.5) * 0.22 + i * 1.9)
          .setAlpha(born * gone * (0.92 - 0.3 * ring) * dim);
      }
    }
  }

  /** Visszanövés (nyitott játék): az épület újra áll (építési por kíséri), a fa, oszlop újra megjelenik. */
  private regrow(what: 'building' | 'prop', index: number, x: number, y: number): void {
    if (what === 'building') {
      if (!this.map.restoreBuilding(index)) return;
      this.ground.notify({ type: 'restore', what, index });
      const [minX, minY, maxX, maxY] = this.map.buildingBoxes[index];
      this.ground.invalidate(minX - 6, minY - 6, maxX + 6, maxY + 6);
      // a rom tüze kialszik
      this.fires.douse(minX - 1, minY - 1, maxX + 1, maxY + 1);
      const size = Math.max(maxX - minX, maxY - minY);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        this.puff((x + Math.cos(a) * size * 0.35) * this.ppm, (y + Math.sin(a) * size * 0.35) * this.ppm, 0xcfc6b4, 1.4, 900);
      }
      return;
    }
    if (!this.map.fellables.restore(index)) return;
    this.ground.notify({ type: 'restore', what, index });
    const reach = (this.map.trees[index]?.r ?? 2.5) * 2.6 + 3;
    this.ground.invalidate(x - reach, y - reach, x + reach, y + reach);
    // a kidőlt fa tüze kialszik
    this.fires.douse(x - reach, y - reach, x + reach, y + reach);
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
      this.sfx.collapse(Math.max(0.3, volume));
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
          this.add.image(x, y, tankTex.wreckHull(tankTier(w.level), w.look)).setRotation(w.hullAngle).setScale(this.spriteScale * tankSize(w)).setDepth(5),
          this.add
            .image(x, y, tankTex.wreckTurret(tankTier(w.level), w.look))
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
      if (!tank.alive) continue;
      const px = tank.x * this.ppm;
      const py = tank.y * this.ppm;
      if (px < view.x || px > view.right || py < view.y || py > view.bottom) continue;
      // az álcázott ellenfél nem füstöl és nem ver port (a lánctalpa nyoma megmarad)
      if (tank.cloak > 0 && tank.id !== this.world.myId) continue;
      // a sérült tank füstöl: félig sérülten szürkén, súlyosan sérülten sűrű, fekete füsttel (állva is)
      const stage = this.tankViews.get(tank.id)?.stage ?? 0;
      if (stage >= 2 && (stage === 3 || (this.frame / 5) % 2 === 0)) {
        const size = tankSize(tank);
        const jitter = (((this.frame * 7 + tank.id * 13) % 9) - 4) * 0.25 * size * this.ppm;
        this.puff(px - Math.cos(tank.hullAngle) * 1.2 * size * this.ppm + jitter, py - Math.sin(tank.hullAngle) * 1.2 * size * this.ppm - jitter * 0.6, stage === 3 ? 0x1c1a18 : 0x6a6660, (stage === 3 ? 1.15 : 0.8) * size, stage === 3 ? 900 : 700);
      }
      if (Math.abs(tank.speed) < 2) continue;
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

  /**
   * Lézersugár: lágy szélű, rétegzett fény (széles vörös izzás, rózsaszín sugár, vakító fehér mag),
   * egymásra adódó fénnyel; remeg, a halványulás közben elvékonyodik. Az eleje képkockánként a lövő
   * tank csövéhez igazodik (menet közben sem marad le), a vége a becsapódás helyén izzik; a sugár
   * mentén szikrák pattannak szét.
   */
  private beam(shooter: number, x1: number, y1: number, x2: number, y2: number): void {
    const ppm = this.ppm;
    const take = (texture: string): Phaser.GameObjects.Image => {
      const image = this.beamPool.pop() ?? this.add.image(0, 0, texture);
      return image.setTexture(texture).setBlendMode(Phaser.BlendModes.ADD).setVisible(true).setAlpha(1).setScale(1).setRotation(0);
    };
    const layers = LASER_LAYERS.map((layer) => ({ ...layer, image: take(GTEX.laserBeam).setOrigin(0, 0.5).setDepth(13 + layer.depth) }));
    const muzzle = take(GTEX.light).setOrigin(0.5).setDepth(13.4).setTint(0xffe0a0);
    const hit = take(GTEX.light).setOrigin(0.5).setDepth(13.4).setTint(0xd080ff);
    // a szalagok a sugár mögött (mag alatt) és előtte (mag fölött) futó szakaszai
    const back = this.add.graphics().setDepth(13.05).setBlendMode(Phaser.BlendModes.ADD);
    const front = this.add.graphics().setDepth(13.3).setBlendMode(Phaser.BlendModes.ADD);
    const end = { x: x2 * ppm, y: y2 * ppm };
    const start = { x: x1 * ppm, y: y1 * ppm };
    // szikrák a sugár mentén (a becsapódás felé sűrűbben)
    const sparks = Array.from({ length: 10 }, (_, i) => {
      const t = 0.25 + 0.75 * Math.sqrt((i + 0.5) / 10);
      const a = Math.random() * Math.PI * 2;
      const speed = (18 + Math.random() * 40) * this.spriteScale;
      return { t, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, image: take(GTEX.px).setOrigin(0.5).setDepth(13.5).setTint(i % 3 ? 0xd8a0ff : 0xfff0b0) };
    });
    this.lasers.push({ shooter, start, end, age: 0, layers, muzzle, hit, sparks, back, front, seed: Math.random() * 100 });
  }

  /**
   * A sugár körül csavarodó két szalag: csavarvonal, amely a sugár tengelye körül forog. Ahol a
   * szalag a sugár előtt fut, ott vastagabb és fényesebb (a mag fölé kerül), ahol mögötte, ott
   * vékonyabb és halványabb (a mag alá). A cső végénél és a becsapódásnál összeszűkül.
   */
  private laserSpiral(laser: { back: Phaser.GameObjects.Graphics; front: Phaser.GameObjects.Graphics; start: { x: number; y: number }; age: number; seed: number }, length: number, angle: number, fade: number, s: number): void {
    const { back, front } = laser;
    back.clear();
    front.clear();
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const step = LASER_SPIRAL.step * s;
    const pitch = LASER_SPIRAL.pitch * s;
    const taper = 16 * s;
    // a szalag kifelé tágul, ahogy a sugár halványul (szétfoszlik)
    const amplitude = LASER_SPIRAL.amplitude * s * (1 + 0.6 * (1 - fade));
    const spin = laser.age * LASER_SPIRAL.spin + laser.seed;
    for (let strand = 0; strand < 2; strand++) {
      const color = LASER_SPIRAL.colors[strand];
      let px = 0;
      let py = 0;
      let first = true;
      for (let d = 0; d <= length + step * 0.5; d += step) {
        const along = Math.min(d, length);
        const phase = (along / pitch) * Math.PI * 2 - spin + strand * Math.PI;
        // összeszűkül a két végén
        const ends = Math.min(1, along / taper, (length - along) / taper + 0.25);
        const off = Math.sin(phase) * amplitude * Math.max(0, ends);
        const x = laser.start.x + cos * along - sin * off;
        const y = laser.start.y + sin * along + cos * off;
        if (!first) {
          const facing = Math.cos(phase);
          const target = facing >= 0 ? front : back;
          target.lineStyle((facing >= 0 ? 4.2 : 2.4) * s * (0.6 + 0.4 * fade), color, (facing >= 0 ? 1 : 0.45) * fade);
          target.lineBetween(px, py, x, y);
        }
        px = x;
        py = y;
        first = false;
      }
    }
  }

  /** A lézersugarak frissítése képkockánként (lásd beam). */
  private updateLasers(dt: number): void {
    const s = this.spriteScale;
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const laser = this.lasers[i];
      laser.age += dt;
      const k = laser.age / LASER_LIFE;
      if (k >= 1) {
        for (const image of [...laser.layers.map((l) => l.image), laser.muzzle, laser.hit, ...laser.sparks.map((p) => p.image)]) {
          image.setVisible(false);
          this.beamPool.push(image);
        }
        laser.back.destroy();
        laser.front.destroy();
        this.lasers.splice(i, 1);
        continue;
      }
      // a sugár eleje: a lövő tank csövének vége, ahol a tank éppen látszik
      const muzzle = this.tankViews.get(laser.shooter)?.muzzle();
      if (muzzle) {
        laser.start.x = muzzle.x;
        laser.start.y = muzzle.y;
      }
      const dx = laser.end.x - laser.start.x;
      const dy = laser.end.y - laser.start.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const angle = Math.atan2(dy, dx);
      // gyors felvillanás, aztán halványul és vékonyodik; közben remeg
      const fade = (1 - k) ** 1.6;
      const flicker = 1 + 0.18 * Math.sin(laser.age * 90 + laser.seed) + 0.08 * Math.sin(laser.age * 233 + laser.seed * 3);
      for (const layer of laser.layers) {
        layer.image
          .setPosition(laser.start.x, laser.start.y)
          .setRotation(angle)
          .setDisplaySize(length, layer.width * s * flicker * (0.35 + 0.65 * fade) * (k < 0.08 ? 1.6 - k * 7.5 : 1))
          .setTint(layer.tint)
          .setAlpha(layer.alpha * fade);
      }
      this.laserSpiral(laser, length, angle, fade, s);
      laser.muzzle.setPosition(laser.start.x, laser.start.y).setScale(s * (0.42 + 0.12 * flicker) * (0.4 + 0.6 * fade)).setAlpha(0.95 * fade);
      laser.hit.setPosition(laser.end.x, laser.end.y).setScale(s * (0.55 + 0.15 * flicker) * (0.5 + 0.5 * fade)).setAlpha(0.9 * fade);
      for (const p of laser.sparks) {
        p.image
          .setPosition(laser.start.x + dx * p.t + p.vx * laser.age, laser.start.y + dy * p.t + p.vy * laser.age)
          .setRotation(Math.atan2(p.vy, p.vx))
          .setDisplaySize(4 * s * (1 - k * 0.5), 1.4 * s)
          .setAlpha(Math.min(1, fade * 1.4));
      }
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
        // a többi játékos tankja fölött ott a neve; a sajátunkon és a botokon nincs felirat
        const kind = tank.id === myId ? 'own' : tank.bot ? 'bot' : 'rival';
        view = new TankView(this, this.ppm, tank, kind, kind === 'rival' ? this.world.nameOf(tank.id) : '', this.world.lookOf(tank.id));
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

  /**
   * A lángszórók lángja: minden égő lángszóró csövéből képkockánként néhány lángdarab indul a
   * torony irányában, kicsit szórva. A darabok repülnek, nőnek, kihűlnek (fehér → sárga → narancs →
   * vörös), a falnál megállnak; a csóva végén füst száll fel, a földön égésnyom marad.
   */
  private flames(dt: number): void {
    const world = this.world;
    const ppm = this.ppm;
    const v = this.view;
    let loudest = 0;
    const flaming = new Set<number>();
    for (const t of world.tanks) {
      if (!t.alive || !t.flaming) continue;
      flaming.add(t.id);
      const mine = t.id === world.myId;
      const volume = mine ? 1 : this.loudness(t.x, t.y) * 0.8;
      loudest = Math.max(loudest, volume);
      if (!this.flamingBefore.has(t.id) && volume > 0) this.sfx.flameStart(volume);
      const view = this.tankViews.get(t.id);
      const tx = view ? view.px / ppm : t.x;
      const ty = view ? view.py / ppm : t.y;
      if (tx * ppm < v.x - 700 || tx * ppm > v.right + 700 || ty * ppm < v.y - 700 || ty * ppm > v.bottom + 700) continue;
      const size = tankSize(t);
      const barrel = TANK.barrelLength * size;
      const cos = Math.cos(t.turretAngle);
      const sin = Math.sin(t.turretAngle);
      const mx = tx + cos * barrel;
      const my = ty + sin * barrel;
      // a falnál megáll a láng
      const wall = this.map.walls.raycast(tx, ty, tx + cos * (barrel + FLAME.range), ty + sin * (barrel + FLAME.range));
      const reach = wall ? Math.max(1.5, Math.hypot(wall.x - mx, wall.y - my)) : FLAME.range;
      for (let i = 0; i < 6; i++) {
        const spread = (Math.random() - 0.5) * 2 * FLAME.halfAngle * 0.8;
        const a = t.turretAngle + spread;
        const speed = FLAME_SPEED * (0.8 + Math.random() * 0.4);
        const image = this.flamePool.pop() ?? this.add.image(0, 0, `${GTEX.puff}0`).setDepth(12.7).setBlendMode(Phaser.BlendModes.ADD);
        image.setTexture(`${GTEX.puff}${(this.frame + i) % PUFF_VARIANTS}`).setVisible(true);
        this.flameParts.push({
          image,
          x: mx + (Math.random() - 0.5) * 0.4,
          y: my + (Math.random() - 0.5) * 0.4,
          // a tank mozgása is viszi a lángot
          vx: Math.cos(a) * speed + Math.cos(t.hullAngle) * t.speed * 0.5,
          vy: Math.sin(a) * speed + Math.sin(t.hullAngle) * t.speed * 0.5,
          age: 0,
          life: (reach / FLAME_SPEED) * (0.85 + Math.random() * 0.3),
          size: 0.8 + Math.random() * 0.5,
          spin: (Math.random() - 0.5) * 5,
        });
      }
      // a csóva vége: felszálló fekete füst, néha égésnyom a földön; este a láng bevilágítja a környéket
      const ex = mx + cos * reach * 0.95;
      const ey = my + sin * reach * 0.95;
      if (this.frame % 5 === 0) this.puff((ex + (Math.random() - 0.5) * 4) * ppm, (ey + (Math.random() - 0.5) * 4) * ppm, 0x2c2a28, 2.4, 900);
      if (this.frame % 14 === 0 && !wall) this.scar(mx + cos * reach * (0.5 + Math.random() * 0.45), my + sin * reach * (0.5 + Math.random() * 0.45), 1.2 + Math.random() * 0.8);
      if (this.frame % 4 === 0) this.weather.flash(mx + cos * reach * 0.5, my + sin * reach * 0.5, reach * 0.9, 0.25);
    }
    this.flamingBefore.clear();
    for (const id of flaming) this.flamingBefore.add(id);
    this.sfx.flameRoar(loudest);

    // a lángdarabok mozgatása
    for (let i = this.flameParts.length - 1; i >= 0; i--) {
      const p = this.flameParts[i];
      p.age += dt;
      if (p.age >= p.life) {
        p.image.setVisible(false);
        this.flamePool.push(p.image);
        this.flameParts[i] = this.flameParts[this.flameParts.length - 1];
        this.flameParts.pop();
        continue;
      }
      const k = p.age / p.life;
      // a láng a levegőben lassul és szétterül
      const drag = 1 - 0.9 * dt;
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      let color = FLAME_COLORS[FLAME_COLORS.length - 1][1];
      for (const [until, c] of FLAME_COLORS) {
        if (k <= until) {
          color = c;
          break;
        }
      }
      const radius = p.size * (0.55 + 4.4 * k);
      p.image
        .setPosition(p.x * ppm, p.y * ppm)
        .setScale((radius * ppm) / (PUFF_SIZE * 0.36))
        .setRotation(p.spin * p.age)
        .setTint(color)
        .setAlpha(k < 0.08 ? k / 0.08 : k > 0.7 ? Math.max(0, (1 - k) / 0.3) * 0.75 : 0.75);
    }
  }

  /** Olajos lánctalp: a kipörgő lánctalp olajat fröcsköl maga mögé; a saját tanknál jelzés és surrogó hang. */
  private oilyTracks(): void {
    const world = this.world;
    const ppm = this.ppm;
    const v = this.view;
    if (this.frame % 3 === 0) {
      for (const t of world.tanks) {
        if (!t.alive || !(t.oily > 0) || Math.abs(t.speed) < 0.4) continue;
        const x = t.x * ppm;
        const y = t.y * ppm;
        if (x < v.x - 60 || x > v.right + 60 || y < v.y - 60 || y > v.bottom + 60) continue;
        const back = t.speed >= 0 ? Math.PI : 0;
        const r = tankRadius(t);
        for (const side of [-1, 1]) {
          const a = t.hullAngle + back + side * 0.55;
          this.puff(x + Math.cos(a) * r * 1.15 * ppm, y + Math.sin(a) * r * 1.15 * ppm, 0x17171d, 0.42, 320);
        }
      }
    }
    const own = world.own;
    const oily = !!own && own.alive && own.oily > 0;
    if (oily && !this.wasOily) this.hud.toast('Olajos a lánctalp – kipörög, amíg le nem kopik');
    this.wasOily = oily;
    if (oily && this.input_.throttle !== 0 && this.frame % 26 === 0) this.sfx.trackSpin();
  }

  private syncOils(): void {
    const { oils } = this.world;
    const scale = (OIL.radius * 2 * this.ppm) / 160; // a textúrán a folt kb. 160 pixel átmérőjű
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
      streak: p.streak ?? 0,
      cloak: p.cloak ?? 0,
      cloakReady: p.cloakReady ?? 0,
      strikes: p.strikes ?? 0,
      mineCharges: p.mines ?? 0,
      smokeCharges: p.smokes ?? 0,
      mines: this.world.mines.length,
      smokes: this.world.smokes.length,
      barrels: this.world.barrels.length,
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
