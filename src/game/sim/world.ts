// Játékszimuláció: tankok, lövedékek, sebzés, felvehető tárgyak, olajfoltok,
// ütközés. Tiszta, determinisztikus logika rögzített időlépéssel – nincs benne
// Phaser- vagy DOM-függés, így a későbbi szerver-authoritatív multiplayerben a
// szerver ugyanezt a kódot futtathatja. A kliens (és a botok „agya”) csak
// TankInput-ot ad, az állapotot a World számolja.
// Mértékegységek: méter, másodperc, radián.

import { SegmentGrid } from './collision';
import { FELLABLE, type Fellables } from './props';
import { BARREL, MINE, SMOKE, STRIKE, SUPER, type BarrelState, type BoomKind, type MineState, type SmokeState, type StrikeState } from './gadgets';
import type { Structures } from './structures';
import { BOOST, CARGO_KINDS, isWeapon, LASER, mulberry32, OIL, PICKUP, pickKind, PICKUPS, ROCKET, TIMED_KINDS, type PickupKind, type TimedKind, type WeaponKind } from './pickups';
import type { NetRoad } from './roadnet';
import { TURRET, VEHICLE, VEHICLES, VSTATE, type TurretState, type VehicleKind, type VehicleState } from './vehicles';

export const SIM_DT = 1 / 60;

export const TANK = {
  radius: 1.7,
  maxSpeed: 17,
  /** tolatás legnagyobb sebessége */
  maxReverse: 9,
  accel: 34,
  brake: 46,
  // Kormányzás: a forgás fokozatosan gyorsul fel, így egy rövid billentyűnyomás
  // csak néhány fokot fordít, a nyomva tartás pedig erős fordulást ad.
  /** a legnagyobb forgási sebesség álló helyzetben (rad/s) */
  turnRate: 2.2,
  /** a legnagyobb forgási sebesség teljes sebességnél (rad/s) – ívesebb, kiszámíthatóbb kanyar */
  turnRateAtSpeed: 1.15,
  /** a forgás felgyorsulása, amíg a billentyű le van nyomva (rad/s²) */
  turnAccel: 4.5,
  /** a forgás lefékeződése elengedés vagy irányváltás után (rad/s²) */
  turnDecel: 11,
  turretRate: 9,
  fireCooldown: 0.42,
  barrelLength: 3.9,
  maxHp: 100,
  /** kilövés után ennyi idővel éled újra a tank (mp) */
  respawnDelay: 4,
} as const;

/** Gyorsító (Shift): rövid ideig gyorsabb a tank, aztán túlmelegszik. */
export const BOOSTER = {
  /** a sebesség szorzója gyorsítás közben */
  speed: 1.3,
  /** ennyi ideig használható folyamatosan (mp) */
  duration: 3,
  /** túlmelegedés után ennyi idő alatt hűl le teljesen (mp); addig nem kapcsolható be */
  cooldown: 6,
} as const;

/**
 * Fejlődés: minden kilőtt tank után egy szinttel erősebb a tank – nagyobb,
 * több az életereje, és nagyobbat sebez a lövedéke. A szint a kilövéssel nem
 * vész el: az újraéledő tank ugyanazon a szinten folytatja. A szintek
 * osztályokba (tier) tartoznak: osztályváltáskor a tank más, erősebb típus
 * lesz – a kinézete megváltozik, és a mérete is ugrik.
 */
export const LEVEL = {
  max: 20,
  /** az osztályok első szintjei: felderítő, közepes, nehéz, ostromtank, romboló, titán */
  tiers: [1, 3, 6, 9, 12, 16],
  /** méretnövekedés szintenként */
  size: 0.04,
  /** további méretnövekedés osztályonként */
  tierSize: 0.07,
  /** többlet életerő szintenként */
  hp: 12,
  /** többlet sebzés szintenként */
  damage: 0.08,
} as const;

/** A tank mérete az alapmérethez képest (1. szint = 1). */
/** A szint osztálya (0 … LEVEL.tiers.length − 1). */
export function tankTier(level: number): number {
  let tier = 0;
  for (let i = 1; i < LEVEL.tiers.length; i++) if (level >= LEVEL.tiers[i]) tier = i;
  return tier;
}
export const tankSize = (tank: { level: number }): number => 1 + LEVEL.size * (tank.level - 1) + LEVEL.tierSize * tankTier(tank.level);
export const tankRadius = (tank: { level: number }): number => TANK.radius * tankSize(tank);
export const tankMaxHp = (tank: { level: number }): number => TANK.maxHp + LEVEL.hp * (tank.level - 1);
/** A sebzés szorzója: a szinttel nő, a szupertárgy hatása alatt többszörös. */
const damageBoost = (tank: { level: number; effects?: Effects }): number => (1 + LEVEL.damage * (tank.level - 1)) * (tank.effects && tank.effects.super > 0 ? SUPER.power : 1);

/**
 * A tank az ütközésével is rombol. Az épületet minden szint sebzi, amíg
 * nekifeszül – a nagyobb tank gyorsabban –, a nehéz tanktól fölfelé pedig a
 * kisebb (vagy már megrongált) házakon megállás nélkül áthajt. A járműveket
 * és az ellenséges ágyúkat a nehéz tanktól (minLevel) rombolja.
 */
export const CRUSH = {
  /** az épületnek feszülő tank sebzése másodpercenként az 1. szinten (az épület életereje 80–600) */
  ramPerSecond: 14,
  /** ennyivel szorzódik szintenként */
  ramGrowth: 1.3,
  /**
   * Ekkora (vagy kisebb) életerejű épületen a tank megállás nélkül áthajt:
   * [első szint, életerő ezen a szinten, növekmény szintenként]. A 3. szinttől
   * a kis fészereken, a 6.-tól a kisebb családi házakon megy át.
   */
  through: [
    [3, 80, 15],
    [6, 170, 45],
  ],
  /** áthajtáskor ennyire lassul a tank */
  throughSlow: 0.75,
  /** ettől a szinttől rombolja a tank az ütközésével a járműveket és az ágyúkat */
  minLevel: 6,
  /** a járművek, ágyúk sebzése másodpercenként, a minLevel fölötti szintenként */
  perSecond: 45,
  /** ettől a szinttől minden épület, jármű és ágyú érintésre megsemmisül */
  instantLevel: 12,
} as const;

/** Az épületnek feszülő tank sebzése másodpercenként. */
export const ramPower = (level: number): number => CRUSH.ramPerSecond * CRUSH.ramGrowth ** (level - 1);

/** Ekkora (vagy kisebb) életerejű épületen a tank megállás nélkül áthajt (0: egyiken sem). */
export function ramThrough(level: number): number {
  if (level >= CRUSH.instantLevel) return Infinity;
  let limit = 0;
  for (const [from, hp, step] of CRUSH.through) if (level >= from) limit = hp + step * (level - from);
  return limit;
}

/** Időjárás: esőben a burkolatlan talaj sáros és csúszik. */
export type Weather = 'day' | 'rain' | 'night';
export const MUD = {
  /** a sár tovább lassít a terephez képest */
  speed: 0.82,
  /** a gyorsulás és a fékezés szorzója sárban: lassan indul, sokáig csúszik */
  accel: 0.45,
  brake: 0.28,
  /** ennél gyorsabban haladva (m/s) és ennél erősebben kanyarodva (rad/s) a tank megcsúszik */
  slipSpeed: 8,
  slipTurn: 0.95,
  slipTime: 0.9,
  /** két megcsúszás között legalább ennyi idő telik el (mp) */
  slipCooldown: 2.2,
} as const;

/** Kilőtt tankok roncsai: ott maradnak, akadályként. */
export const WRECK = {
  radius: 1.5,
  /** ennyi roncs marad a pályán; fölötte a legrégebbiek tűnnek el */
  max: 150,
} as const;

/** A roncs akadályként akkora, amekkora a kilőtt tank volt. */
export const wreckRadius = (wreck: { level: number }): number => WRECK.radius * tankSize(wreck);

export const BULLET = {
  speed: 75,
  life: 1.1,
} as const;

/** Sebzés találatonként (a tank életereje 100). */
export const DAMAGE = {
  shell: 25,
  heavy: 50,
  rocket: 55,
  laser: 18,
  /** a rakéta robbanása ekkora körben sebez (m), ennyit */
  splashRadius: 7,
  splash: 30,
} as const;

/** Csapatok: az azonos csapatban lévők nem sebzik egymást. */
export const TEAM = { player: 0, bots: 1 } as const;
/** freeSpot: minden ember vezérelte tanktól távol (nem egyetlen csapattól). */
export const ANY_PLAYER = -2;

export interface TankInput {
  /** gáz a tank saját iránya szerint: 1 = előre, −1 = tolatás, 0 = nincs gáz */
  throttle: number;
  /** a test forgatása: −1 = balra, 1 = jobbra (az óramutató járása szerint) */
  turn: number;
  /** a torony kívánt iránya radiánban; null = a test irányát követi */
  aim: number | null;
  fire: boolean;
  /** olajfolt lerakása a tank mögé (ha van töltet) */
  drop?: boolean;
  /** gyorsító (amíg nem melegszik túl) */
  boost?: boolean;
  /** ágyú telepítése a tank mögé (ha van töltet) */
  deploy?: boolean;
  /** akna lerakása a tank mögé (ha van töltet) */
  mine?: boolean;
  /** füst a tank köré (ha van töltet) */
  smoke?: boolean;
  /** tüzérségi csapás kérése a megadott helyre (ha jár neki) */
  strike?: { x: number; y: number } | null;
}

/** Az időzített bónuszok hátralévő ideje másodpercben (0 = nem aktív). */
export type Effects = Record<TimedKind, number>;

export interface TankState {
  id: number;
  team: number;
  /** gép vezérli-e */
  bot: boolean;
  x: number;
  y: number;
  hullAngle: number;
  turretAngle: number;
  /** a test pillanatnyi forgási sebessége (rad/s) */
  turnSpeed: number;
  speed: number;
  cooldown: number;
  /** megtett út méterben (lánctalp-animációhoz) */
  odometer: number;
  hp: number;
  alive: boolean;
  /** újraéledésig hátralévő idő (mp), ha a tank ki van lőve */
  respawn: number;
  kills: number;
  deaths: number;
  /** szint: 1-ről indul, minden kilövéssel eggyel nő (LEVEL.max-ig) */
  level: number;
  /** hátralévő életek száma; −1: korlátlan */
  lives: number;
  /** kiesett: elfogytak az életei, nem éled újra */
  out: boolean;
  /** sárban a következő megcsúszásig hátralévő idő (mp) */
  grip: number;
  /** az újraéledés helye (a játékosnál a kezdőpont) */
  homeX: number;
  homeY: number;
  homeAngle: number;
  effects: Effects;
  /** a felvett fegyver (null: alaplövedék); megmarad, amíg másikat nem vesz fel, vagy ki nem lövik */
  weapon: WeaponKind | null;
  /** ennyi lövésig hármas még a lövés */
  tripleShots: number;
  /** pattanó lövedék: megmaradó képesség, a kilövésig tart */
  ricochet: boolean;
  /** pajzstöltetek száma */
  shield: number;
  /** lerakható olajfoltok száma */
  oil: number;
  /** telepíthető ágyúk száma */
  turrets: number;
  /** lerakható aknák és füsttöltetek száma */
  mines: number;
  smokes: number;
  /** kérhető tüzérségi csapások száma (kilövéssorozatért jár) */
  strikes: number;
  /** kilövések az utolsó halál óta, és a meccs legjobb sorozata */
  streak: number;
  bestStreak: number;
  /** leadott lövések és az ellenséges tankot ért közvetlen találatok (a pontossághoz) */
  shots: number;
  hits: number;
  /** ennyi épületet döntött össze */
  wrecked: number;
  dropCooldown: number;
  /** megcsúszás hátralévő ideje (mp); közben a tank irányíthatatlanul sodródik */
  slip: number;
  /** a sodródás iránya és a pörgés sebessége megcsúszás közben */
  slideAngle: number;
  spin: number;
  /** a gyorsító hőfoka: 0 = hideg, BOOSTER.duration = túlmelegedett */
  heat: number;
  /** túlmelegedett: amíg teljesen le nem hűl, a gyorsító nem használható */
  overheated: boolean;
  /** éppen gyorsít-e */
  boosting: boolean;
}

export interface WreckState {
  id: number;
  x: number;
  y: number;
  hullAngle: number;
  turretAngle: number;
  team: number;
  /** a kilőtt tank szintje: a roncs mérete és kinézete ehhez igazodik */
  level: number;
  /** a kilövés óta eltelt idő (mp) – a füstöléshez */
  age: number;
}

/** A lövedék fajtája: sima, nehéz vagy rakéta. */
export type ShellKind = 'shell' | 'heavy' | 'rocket';
export type ShotKind = ShellKind | 'laser';

export interface BulletState {
  id: number;
  owner: number;
  team: number;
  kind: ShellKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  /** ennyiszer pattanhat még vissza falról */
  bounces: number;
  /** telepített ágyú lőtte ki (a találata nem számít a tank pontosságába) */
  auto?: boolean;
}

export interface PickupState {
  id: number;
  kind: PickupKind;
  x: number;
  y: number;
  /** ráadás (pl. teherautó rakománya): felvétel után nem pótlódik */
  extra?: boolean;
}

export interface OilState {
  id: number;
  owner: number;
  x: number;
  y: number;
  life: number;
  /** a lerakója addig védett tőle, amíg egyszer le nem hajt róla */
  ownerSafe: boolean;
}

export type SimEvent =
  | { type: 'shot'; tank: number; kind: ShotKind; x: number; y: number; angle: number }
  | { type: 'impact'; kind: ShotKind; x: number; y: number }
  | { type: 'laser'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'ricochet'; x: number; y: number }
  | { type: 'pickup'; tank: number; kind: PickupKind; x: number; y: number }
  | { type: 'oil'; tank: number; x: number; y: number }
  | { type: 'slip'; tank: number; x: number; y: number }
  | { type: 'bump'; tank: number; x: number; y: number }
  /** a tank egy épületnek feszül és rombolja (por, recsegés) */
  | { type: 'ram'; tank: number; x: number; y: number }
  /** egy épület megsérült, de még áll; left: a megmaradt életereje (0..1), x, y: a közepe */
  | { type: 'structure'; index: number; x: number; y: number; left: number }
  /** kidőlt egy fa vagy oszlop (index: a pálya kidönthető tárgyainak sorszáma) */
  | { type: 'felled'; index: number; x: number; y: number; angle: number; shot: boolean }
  /** találat: `absorbed` jelzi, ha pajzs vagy sebezhetetlenség fogta fel */
  | { type: 'hit'; tank: number; by: number; x: number; y: number; absorbed: 'shield' | 'invulnerable' | null; amount: number }
  | { type: 'destroyed'; tank: number; by: number; x: number; y: number }
  | { type: 'respawn'; tank: number; x: number; y: number }
  /** a gyorsító túlmelegedett */
  | { type: 'overheat'; tank: number }
  | { type: 'levelup'; tank: number; level: number }
  /** összedőlt egy épület (index: az épület sorszáma a pályán) */
  | { type: 'collapse'; index: number; x: number; y: number }
  /** a tanknak elfogytak az életei: kiesett */
  | { type: 'eliminated'; tank: number; by: number }
  /** felrobbant egy jármű */
  | { type: 'blast'; kind: VehicleKind; x: number; y: number; radius: number }
  /** egy magas szintű tank összelapított egy járművet */
  | { type: 'crushed'; x: number; y: number }
  /** egy feltartott jármű dudál */
  | { type: 'honk'; x: number; y: number }
  /** a tank ágyút telepített */
  | { type: 'deploy'; tank: number; x: number; y: number }
  /** megsemmisült egy telepített ágyú (owner: a lerakója) */
  | { type: 'turretDown'; owner: number; x: number; y: number }
  /** a tank aknát rakott le, illetve füstöt eresztett */
  | { type: 'mine'; tank: number; x: number; y: number }
  | { type: 'smoke'; tank: number; x: number; y: number }
  /** tüzérségi csapás érkezik: delay mp múlva lövedékek hullanak a radius sugarú körbe */
  | { type: 'strike'; tank: number; x: number; y: number; radius: number; delay: number }
  /** robbanás: akna, gázpalack vagy tüzérségi lövedék */
  | { type: 'boom'; kind: BoomKind; x: number; y: number; radius: number }
  /** kilövéssorozat: a tank ennyi kilövésnél tart halál nélkül, és ennyi tüzérségi csapást kérhet */
  | { type: 'streak'; tank: number; streak: number; strikes: number }
  /** szupertárgy: seconds mp múlva megjelenik, illetve megjelent a megadott helyen */
  | { type: 'superSoon'; x: number; y: number; seconds: number }
  | { type: 'superHere'; x: number; y: number };

export interface RoadGuide {
  /** az út tengelyének legközelebbi pontja */
  x: number;
  y: number;
  /** az út iránya ezen a ponton (radián) */
  angle: number;
  width: number;
}

export interface Terrain {
  /** a pálya mérete méterben */
  readonly width: number;
  readonly height: number;
  readonly walls: SegmentGrid;
  /** fák és oszlopok: nem akadályok, a tank és a lövedék kidönti őket */
  readonly fellables?: Fellables;
  /** ledönthető épületek; a falaik gazdája az ütközési rácsban az épület sorszáma */
  readonly structures?: Structures;
  /** a játéktér, ha kisebb a teljes pályánál (méter) */
  readonly bounds?: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** 1 = burkolt út, kisebb érték = lassabb terep */
  speedFactor(x: number, y: number): number;
  /** Véletlen, járművel elérhető hely (felvehető tárgynak, újraéledő botnak), ha a pálya tud ilyet adni. */
  pickupSpot?(rnd: () => number): { x: number; y: number } | null;
  /** A legközelebbi közút a botok útkövetéséhez. */
  roadGuide?(x: number, y: number): RoadGuide | null;
  /** A járművel járható közutak (a forgalom úthálózatához). */
  driveRoads?(): NetRoad[];
  /** stopvonalak lapítva: x, y, irány (rad), fél hossz */
  readonly stopLines?: readonly number[];
  /** Véletlen hely egy ház fala mellett (gázpalacknak), ha a pálya tud ilyet adni. */
  barrelSpot?(rnd: () => number): { x: number; y: number } | null;
}

/** A meccs szabályai. */
export interface WorldRules {
  weather: Weather;
  /** ennyi élete van egy játékosnak (a botoké korlátlan); 0: korlátlan */
  lives: number;
  /** a játékosok ennyire születnek (újra) egymástól, ha van rá hely (m); 0: a kezdőpontjukon */
  spawnGap: number;
  /** tükörvilág (a kliens előrejelzése): a járműveket és az ágyúkat csak akadályként kezeli, nem sebzi */
  mirror: boolean;
}

/** A világgal együtt léptetett rendszer (pl. a forgalom). */
export interface Stepper {
  step(dt: number): void;
}

export const NO_INPUT: TankInput = { throttle: 0, turn: 0, aim: null, fire: false, drop: false };

const clampUnit = (v: number): number => Math.max(-1, Math.min(1, v));

export function angleDiff(to: number, from: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function rotateToward(current: number, target: number, maxStep: number): number {
  const d = angleDiff(target, current);
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

function noEffects(): Effects {
  return { rapid: 0, speed: 0, allTerrain: 0, invulnerable: 0, radar: 0, super: 0 };
}

/**
 * Az (ax,ay)→(bx,by) szakasz első metszése a (cx,cy) középpontú, r sugarú körrel,
 * a szakasz mentén 0..1 paraméterként; −1, ha nincs. Ha a kezdőpont a körben van, 0.
 */
function segmentCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a === 0) return -1;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

export class World {
  readonly tanks: TankState[] = [];
  readonly bullets: BulletState[] = [];
  readonly pickups: PickupState[] = [];
  readonly oils: OilState[] = [];
  readonly wrecks: WreckState[] = [];
  /** a civil forgalom járművei (a roncsaikkal együtt) */
  readonly vehicles: VehicleState[] = [];
  /** a telepített ágyúk */
  readonly turrets: TurretState[] = [];
  /** lerakott aknák, füstfelhők, folyamatban lévő tüzérségi csapások, gázpalackok */
  readonly mines: MineState[] = [];
  readonly smokes: SmokeState[] = [];
  readonly strikes: StrikeState[] = [];
  readonly barrels: BarrelState[] = [];
  /** a forgalom irányítója: a lépés végén fut, így látja a lépés eseményeit */
  traffic: Stepper | null = null;
  /** az utolsó step() eseményei (hang, effektek) */
  events: SimEvent[] = [];
  tick = 0;
  private nextId = 1;
  /** a felvett tárgyak pótlásáig hátralévő idők (mp) */
  private readonly respawns: number[] = [];
  readonly rnd: () => number;

  readonly rules: WorldRules;

  /** `seed`: a véletlen elemek (tárgyak helye, típusa) magja – azonos magból azonos játék. */
  constructor(
    readonly terrain: Terrain,
    seed = 1,
    rules: Partial<WorldRules> = {},
  ) {
    this.rnd = mulberry32(seed);
    this.rules = { weather: 'day', lives: 0, spawnGap: 0, mirror: false, ...rules };
  }

  /** A játéktér határai (a teljes pálya, ha nincs szűkítve). */
  private area(): { minX: number; minY: number; maxX: number; maxY: number } {
    return this.terrain.bounds ?? { minX: 0, minY: 0, maxX: this.terrain.width, maxY: this.terrain.height };
  }

  addTank(x: number, y: number, angle: number, options: { team?: number; bot?: boolean } = {}): TankState {
    const tank: TankState = {
      id: this.nextId++,
      team: options.team ?? TEAM.player,
      bot: options.bot ?? false,
      x,
      y,
      hullAngle: angle,
      turretAngle: angle,
      turnSpeed: 0,
      speed: 0,
      cooldown: 0,
      odometer: 0,
      hp: TANK.maxHp,
      alive: true,
      respawn: 0,
      kills: 0,
      deaths: 0,
      level: 1,
      lives: options.bot ? -1 : this.rules.lives > 0 ? this.rules.lives : -1,
      out: false,
      grip: 0,
      homeX: x,
      homeY: y,
      homeAngle: angle,
      effects: noEffects(),
      weapon: null,
      tripleShots: 0,
      ricochet: false,
      shield: 0,
      oil: 0,
      turrets: 0,
      mines: 0,
      smokes: 0,
      strikes: 0,
      streak: 0,
      bestStreak: 0,
      shots: 0,
      hits: 0,
      wrecked: 0,
      dropCooldown: 0,
      slip: 0,
      slideAngle: 0,
      spin: 0,
      heat: 0,
      overheated: false,
      boosting: false,
    };
    this.tanks.push(tank);
    return tank;
  }

  removeTank(id: number): void {
    const at = this.tanks.findIndex((t) => t.id === id);
    if (at >= 0) this.tanks.splice(at, 1);
  }

  tank(id: number): TankState | undefined {
    return this.tanks.find((t) => t.id === id);
  }

  /**
   * Végképp beragadt bot áthelyezése egy szabad útpontra. Csak akkor történik
   * meg, ha `clear` méteren belül nincs ellenséges tank (hogy senki ne lássa),
   * és az új hely is távol van tőlük.
   */
  relocate(id: number, clear: number): boolean {
    const tank = this.tank(id);
    if (!tank || !tank.alive || !tank.bot) return false;
    if (this.tanks.some((t) => t.alive && t.team !== tank.team && Math.hypot(t.x - tank.x, t.y - tank.y) < clear)) return false;
    const spot = this.findSpot((t) => (t.team !== tank.team ? clear : 8));
    if (!spot) return false;
    tank.x = spot.x;
    tank.y = spot.y;
    tank.speed = 0;
    tank.turnSpeed = 0;
    tank.hullAngle = this.rnd() * Math.PI * 2;
    tank.turretAngle = tank.hullAngle;
    this.events.push({ type: 'respawn', tank: tank.id, x: tank.x, y: tank.y });
    return true;
  }

  /** Tárgy elhelyezése megadott helyre (pályaszerkesztéshez, tesztekhez). */
  addPickup(kind: PickupKind, x: number, y: number): PickupState {
    const pickup: PickupState = { id: this.nextId++, kind, x, y };
    this.pickups.push(pickup);
    return pickup;
  }

  /**
   * Véletlenszerűen szétszór `count` tárgyat a pályán. `near`: ennyi közülük a
   * megadott pont körül jelenjen meg (hogy a kezdőpont közelében is legyen mit felvenni).
   */
  scatterPickups(count: number, near?: { x: number; y: number; radius: number; count: number }): void {
    for (let i = 0; i < count; i++) this.spawnPickup(near && i < near.count ? near : undefined);
  }

  /**
   * Véletlen, szabad hely az utakon. `avoidTeam`: ettől a csapattól legalább
   * `minDist` méterre legyen (a botok ne a játékos orra előtt éledjenek).
   */
  freeSpot(minDist = 0, avoidTeam = -1): { x: number; y: number } | null {
    const far = Math.max(minDist, 8);
    return this.findSpot((t) => ((avoidTeam === ANY_PLAYER ? !t.bot : t.team === avoidTeam) ? far : 8));
  }

  /** Véletlen, szabad hely az utakon; `distOf`: az adott élő tanktól legalább ennyire legyen (m). */
  private findSpot(distOf: (tank: TankState) => number): { x: number; y: number } | null {
    const spotOf = this.terrain.pickupSpot?.bind(this.terrain);
    if (!spotOf) return null;
    for (let attempt = 0; attempt < 80; attempt++) {
      const spot = spotOf(this.rnd);
      if (!spot) continue;
      if (this.tanks.some((t) => t.alive && Math.hypot(t.x - spot.x, t.y - spot.y) < distOf(t))) continue;
      if (this.wrecks.some((w) => Math.hypot(w.x - spot.x, w.y - spot.y) < 7)) continue;
      if (this.vehicles.some((v) => Math.hypot(v.x - spot.x, v.y - spot.y) < 12)) continue;
      if (this.turrets.some((t) => Math.hypot(t.x - spot.x, t.y - spot.y) < 7)) continue;
      if (this.barrels.some((b) => Math.abs(b.x - spot.x) < 7 && Math.abs(b.y - spot.y) < 7)) continue;
      if (this.mines.some((m) => Math.abs(m.x - spot.x) < 7 && Math.abs(m.y - spot.y) < 7)) continue;
      return spot;
    }
    return null;
  }

  /**
   * Születési hely egy játékosnak: véletlen útpont, minden más játékostól
   * legalább `rules.spawnGap` méterre (a botoktól 35 m-re). Ha ekkora szabad
   * hely nincs, fokozatosan kisebb távolsággal is beéri.
   */
  spawnSpot(self: TankState | null = null): { x: number; y: number } | null {
    const gap = this.rules.spawnGap;
    if (gap <= 0) return null;
    for (const k of [1, 0.75, 0.5, 0.3, 0.12]) {
      const spot = this.findSpot((t) => (t === self ? 0 : t.bot ? Math.min(35, gap * k) : gap * k));
      if (spot) return spot;
    }
    return this.findSpot(() => 8);
  }

  private spawnPickup(near?: { x: number; y: number; radius: number }): PickupState | null {
    const spotOf = this.terrain.pickupSpot?.bind(this.terrain);
    if (!spotOf) return null;
    for (let attempt = 0; attempt < 80; attempt++) {
      const spot = spotOf(this.rnd);
      if (!spot) continue;
      if (near && Math.hypot(spot.x - near.x, spot.y - near.y) > near.radius) continue;
      // ne kerüljön másik tárgy mellé, sem közvetlenül egy tank elé
      if (this.pickups.some((p) => Math.hypot(p.x - spot.x, p.y - spot.y) < PICKUP.minGap)) continue;
      if (this.tanks.some((t) => Math.hypot(t.x - spot.x, t.y - spot.y) < PICKUP.minGap)) continue;
      return this.addPickup(pickKind(this.rnd), spot.x, spot.y);
    }
    return null;
  }

  step(inputs: ReadonlyMap<number, TankInput>, dt = SIM_DT): void {
    this.events = [];
    this.tick++;
    for (const tank of this.tanks) {
      if (tank.alive) this.stepTank(tank, inputs.get(tank.id) ?? NO_INPUT, dt);
      else this.stepRespawn(tank, dt);
    }
    this.separateTanks();
    for (const w of this.wrecks) w.age += dt;
    this.stepBullets(dt);
    this.stepPickups(dt);
    this.stepOil(dt);
    if (!this.rules.mirror) {
      this.stepVehicles(dt);
      this.stepTurrets(dt);
      this.stepGadgets(dt);
      this.traffic?.step(dt);
    }
  }

  /** Újraéledő bot helye: az ellenségtől távol; kis pályán, ahol ekkora hely nincs, közelebb is beéri. */
  private botSpot(tank: TankState): { x: number; y: number } | null {
    for (const far of [120, 80, 50, 30]) {
      const spot = this.findSpot((t) => (t.team !== tank.team ? far : 8));
      if (spot) return spot;
    }
    return this.findSpot(() => 8);
  }

  private stepRespawn(tank: TankState, dt: number): void {
    if (tank.out) return; // kiesett: nem éled újra
    tank.respawn -= dt;
    if (tank.respawn > 0) return;
    // a botok véletlen helyen, a játékosoktól távol élednek újra; a játékos a többi
    // játékostól távol (ha a szabályok így szólnak), különben a kezdőpontján
    const spot = tank.bot ? this.botSpot(tank) : this.spawnSpot(tank);
    tank.x = spot?.x ?? tank.homeX;
    tank.y = spot?.y ?? tank.homeY;
    tank.hullAngle = spot ? this.rnd() * Math.PI * 2 : tank.homeAngle;
    tank.turretAngle = tank.hullAngle;
    tank.speed = 0;
    tank.turnSpeed = 0;
    tank.slip = 0;
    tank.grip = 0;
    tank.heat = 0;
    tank.overheated = false;
    tank.boosting = false;
    tank.hp = tankMaxHp(tank);
    tank.alive = true;
    tank.effects = noEffects();
    // a felvett fegyver a kilövéssel elveszett: újra az alaplövedék van
    tank.weapon = null;
    tank.tripleShots = 0;
    tank.ricochet = false;
    // rövid védelem újraéledés után
    tank.effects.invulnerable = 2.5;
    tank.shield = 0;
    tank.oil = 0;
    tank.turrets = 0;
    tank.mines = 0;
    tank.smokes = 0;
    this.events.push({ type: 'respawn', tank: tank.id, x: tank.x, y: tank.y });
  }

  private stepTank(tank: TankState, input: TankInput, dt: number): void {
    const { terrain } = this;
    const fx = tank.effects;
    const radius = tankRadius(tank);
    for (const kind of TIMED_KINDS) if (fx[kind] > 0) fx[kind] = Math.max(0, fx[kind] - dt);

    let heading: number;
    if (tank.slip > 0) {
      // megcsúszott: a tank pörög és arra sodródik, amerre a folthoz érkezett;
      // a kormány és a gáz nem hat, a lendület lassan elfogy
      tank.slip = Math.max(0, tank.slip - dt);
      tank.hullAngle += tank.spin * dt;
      tank.spin *= 1 - 1.2 * dt;
      tank.turnSpeed = 0;
      this.stepBooster(tank, false, dt);
      tank.speed = Math.sign(tank.speed) * Math.max(0, Math.abs(tank.speed) - OIL.friction * dt);
      heading = tank.slideAngle;
      // a csúszás végén a lendület a test iránya szerint számít tovább
      if (tank.slip === 0) tank.speed = Math.abs(tank.speed) * Math.cos(angleDiff(tank.slideAngle, tank.hullAngle));
    } else {
      // klasszikus tankirányítás: a test helyben is forog, a gáz a test iránya szerint hat
      const speedRatio = Math.min(1, Math.abs(tank.speed) / TANK.maxSpeed);
      const maxTurn = TANK.turnRate + (TANK.turnRateAtSpeed - TANK.turnRate) * speedRatio;
      const targetTurn = clampUnit(input.turn) * maxTurn;
      // felgyorsulás, ha a kért forgás azonos irányú és nagyobb; különben gyors lefékezés
      const turningUp = targetTurn * tank.turnSpeed >= 0 && Math.abs(targetTurn) > Math.abs(tank.turnSpeed);
      const turnStep = (turningUp ? TANK.turnAccel : TANK.turnDecel) * dt;
      if (tank.turnSpeed < targetTurn) tank.turnSpeed = Math.min(targetTurn, tank.turnSpeed + turnStep);
      else tank.turnSpeed = Math.max(targetTurn, tank.turnSpeed - turnStep);
      tank.hullAngle += tank.turnSpeed * dt;

      const throttle = clampUnit(input.throttle);
      this.stepBooster(tank, input.boost === true && throttle !== 0, dt);
      const boost = (fx.speed > 0 ? BOOST.speed : 1) * (tank.boosting ? BOOSTER.speed : 1);
      // terepjáró lánctalppal a terep nem lassít
      const terrainFactor = fx.allTerrain > 0 ? 1 : terrain.speedFactor(tank.x, tank.y);
      // esőben a burkolatlan talaj sár: lassabb, nehezen gyorsul és fékez, kanyarban megcsúszik
      const muddy = this.rules.weather === 'rain' && terrainFactor < 1;
      const ground = muddy ? terrainFactor * MUD.speed : terrainFactor;
      const targetSpeed = throttle * (throttle >= 0 ? TANK.maxSpeed : TANK.maxReverse) * boost * ground;
      // gyorsítás, ha a cél azonos irányú és nagyobb; különben fékezés
      const speedingUp = targetSpeed * tank.speed >= 0 && Math.abs(targetSpeed) > Math.abs(tank.speed);
      const traction = muddy ? (speedingUp ? MUD.accel : MUD.brake) : 1;
      const rate = (speedingUp ? TANK.accel * (fx.speed > 0 ? BOOST.accel : 1) : TANK.brake) * traction * dt;
      tank.grip = Math.max(0, tank.grip - dt);
      if (muddy && tank.grip === 0 && fx.invulnerable === 0 && Math.abs(tank.speed) > MUD.slipSpeed && Math.abs(tank.turnSpeed) > MUD.slipTurn) {
        // megcsúszik a sárban: rövid ideig irányíthatatlanul sodródik (mint az olajon, csak enyhébben)
        tank.grip = MUD.slipCooldown;
        tank.slip = MUD.slipTime;
        tank.slideAngle = tank.speed >= 0 ? tank.hullAngle : tank.hullAngle + Math.PI;
        tank.spin = Math.sign(tank.turnSpeed) * (2.4 + this.rnd() * 1.2);
        tank.speed = Math.abs(tank.speed);
        this.events.push({ type: 'slip', tank: tank.id, x: tank.x, y: tank.y });
      }
      if (tank.speed < targetSpeed) tank.speed = Math.min(targetSpeed, tank.speed + rate);
      else tank.speed = Math.max(targetSpeed, tank.speed - rate);
      heading = tank.hullAngle;
    }

    const stepLen = tank.speed * dt;
    let nx = tank.x + Math.cos(heading) * stepLen;
    let ny = tank.y + Math.sin(heading) * stepLen;

    let res = terrain.walls.resolveCircle(nx, ny, radius);
    // A tank az ütközésével rombolja az épületet, amelynek nekifeszül: minden szinten, a
    // nagyobb tank gyorsabban; a kisebb házakon a nehéz tank megállás nélkül áthajt.
    // (A botok nem rombolnak így: ők csak véletlenül mennek falnak.)
    const structures = terrain.structures;
    if (res.owner >= 0 && structures && !tank.bot && Math.abs(stepLen) > 0.001 && structures.maxHp[res.owner] !== Infinity) {
      const index = res.owner;
      if (structures.hp[index] <= ramThrough(tank.level)) {
        this.damageStructure(index, Infinity, false, tank.id);
        // a falai eltűntek: a tank továbbmegy, csak kicsit lelassul
        tank.speed *= CRUSH.throughSlow;
        res = terrain.walls.resolveCircle(nx, ny, radius);
      } else {
        // a folyamatos rombolásról csak időnként megy esemény (por, hang, az épület életerősávja)
        const pulse = (this.tick + tank.id * 7) % 14 === 0;
        this.damageStructure(index, ramPower(tank.level) * dt, !pulse, tank.id);
        if (pulse && !structures.collapsed[index]) {
          this.events.push({ type: 'ram', tank: tank.id, x: tank.x + Math.cos(heading) * radius * Math.sign(stepLen), y: tank.y + Math.sin(heading) * radius * Math.sign(stepLen) });
        }
      }
    }
    const area = this.area();
    nx = Math.max(area.minX + radius, Math.min(area.maxX - radius, res.x));
    ny = Math.max(area.minY + radius, Math.min(area.maxY - radius, res.y));
    let blocked = res.hit || nx !== res.x || ny !== res.y;
    // a roncsokat ki kell kerülni
    for (const w of this.wrecks) {
      const dx = nx - w.x;
      const dy = ny - w.y;
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12) continue;
      const clear = radius + wreckRadius(w);
      const d2 = dx * dx + dy * dy;
      if (d2 >= clear * clear) continue;
      const d = Math.sqrt(d2) || 0.001;
      // a roncsról letolva a tank ne kerüljön falba
      const out = terrain.walls.resolveCircle(w.x + (dx / d) * clear, w.y + (dy / d) * clear, radius);
      nx = out.x;
      ny = out.y;
      blocked = true;
    }
    // a magas szintű tank az ütközésével a járműveket és az ellenséges ágyúkat is rombolja
    const crush =
      tank.level >= CRUSH.minLevel && Math.abs(stepLen) > 0.001
        ? tank.level >= CRUSH.instantLevel
          ? Infinity
          : CRUSH.perSecond * (tank.level - CRUSH.minLevel + 1) * dt
        : 0;
    // a járművek (és a roncsaik) akadályok: kapszula alakúak
    for (const v of this.vehicles) {
      const rx = nx - v.x;
      const ry = ny - v.y;
      // a leghosszabb jármű (busz) fele sem ér el ennél messzebbre
      if (rx > 10 || rx < -10 || ry > 10 || ry < -10 || v.state === VSTATE.flat) continue;
      const spec = VEHICLES[v.kind];
      const reach = radius + spec.half + spec.r;
      if (rx * rx + ry * ry >= reach * reach) continue;
      const cos = Math.cos(v.angle);
      const sin = Math.sin(v.angle);
      // a jármű tengelyének a tankhoz legközelebbi pontja
      const along = Math.max(-spec.half, Math.min(spec.half, rx * cos + ry * sin));
      const px = v.x + cos * along;
      const py = v.y + sin * along;
      const dx = nx - px;
      const dy = ny - py;
      const d2 = dx * dx + dy * dy;
      const gap = radius + spec.r;
      if (d2 >= gap * gap) continue;
      const d = Math.sqrt(d2) || 0.001;
      const out = terrain.walls.resolveCircle(px + (dx / d) * gap, py + (dy / d) * gap, radius);
      nx = out.x;
      ny = out.y;
      blocked = true;
      if (crush > 0) this.crushVehicle(v, crush);
    }
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      const dx = nx - t.x;
      const dy = ny - t.y;
      const d2 = dx * dx + dy * dy;
      const gap = radius + TURRET.radius;
      if (d2 >= gap * gap) continue;
      const d = Math.sqrt(d2) || 0.001;
      const out = terrain.walls.resolveCircle(t.x + (dx / d) * gap, t.y + (dy / d) * gap, radius);
      nx = out.x;
      ny = out.y;
      blocked = true;
      if (crush > 0 && t.team !== tank.team) this.damageTurret(t, crush);
    }

    const moved = Math.hypot(nx - tank.x, ny - tank.y);
    if (blocked) {
      if (Math.abs(tank.speed) > TANK.maxSpeed * 0.5 && moved < Math.abs(stepLen) * 0.5) {
        this.events.push({ type: 'bump', tank: tank.id, x: nx, y: ny });
      }
      // falnak csúszva a tényleges elmozdulás szabja meg a sebességet
      const limit = moved / dt + TANK.accel * dt * 0.5;
      tank.speed = Math.max(-limit, Math.min(limit, tank.speed));
    }
    tank.odometer += moved * (tank.speed < 0 ? -1 : 1);
    tank.x = nx;
    tank.y = ny;

    // az útba kerülő fák és oszlopok kidőlnek – kicsit lassítanak, de nem állítják meg a tankot
    const props = terrain.fellables;
    if (props && Math.abs(tank.speed) > 0.5) {
      const dir = tank.speed >= 0 ? heading : heading + Math.PI;
      props.forEachTouching(nx, ny, radius, (i) => {
        if (!this.fell(i, dir, false)) return;
        tank.speed *= props.kind[i] === FELLABLE.pole ? 0.8 : 0.9;
      });
    }

    const aim = input.aim ?? tank.hullAngle;
    tank.turretAngle = rotateToward(tank.turretAngle, aim, TANK.turretRate * dt);

    tank.cooldown = Math.max(0, tank.cooldown - dt);
    if (input.fire && tank.cooldown === 0) this.fire(tank);

    tank.dropCooldown = Math.max(0, tank.dropCooldown - dt);
    if (input.drop && tank.oil > 0 && tank.dropCooldown === 0) this.dropOil(tank);
    if (input.deploy && tank.turrets > 0 && tank.dropCooldown === 0) this.deployTurret(tank);
    if (this.rules.mirror) return;
    if (input.mine && tank.mines > 0 && tank.dropCooldown === 0) this.layMine(tank);
    if (input.smoke && tank.smokes > 0 && tank.dropCooldown === 0) this.dropSmoke(tank);
    if (input.strike && tank.strikes > 0 && tank.dropCooldown === 0) this.callStrike(tank, input.strike.x, input.strike.y);
  }

  /** A gyorsító hőfoka: használat közben nő, különben csökken; a végén túlmelegszik. */
  private stepBooster(tank: TankState, wanted: boolean, dt: number): void {
    if (wanted && !tank.overheated) {
      tank.boosting = true;
      tank.heat += dt;
      if (tank.heat >= BOOSTER.duration) {
        tank.heat = BOOSTER.duration;
        tank.overheated = true;
        tank.boosting = false;
        this.events.push({ type: 'overheat', tank: tank.id });
      }
      return;
    }
    tank.boosting = false;
    tank.heat = Math.max(0, tank.heat - (dt * BOOSTER.duration) / BOOSTER.cooldown);
    if (tank.heat === 0) tank.overheated = false;
  }

  /** A szakasz első találata egy roncson (0..limit), vagy −1. */
  private wreckOnPath(ax: number, ay: number, bx: number, by: number, limit: number): number {
    let best = -1;
    for (const w of this.wrecks) {
      const t = segmentCircle(ax, ay, bx, by, w.x, w.y, wreckRadius(w));
      if (t >= 0 && t <= limit && (best < 0 || t < best)) best = t;
    }
    return best;
  }

  /** Fa vagy oszlop kidöntése a megadott irányba; false, ha már ki volt döntve. */
  private fell(index: number, angle: number, shot = true): boolean {
    const props = this.terrain.fellables;
    if (!props || !props.fell(index, angle)) return false;
    this.events.push({ type: 'felled', index, x: props.x[index], y: props.y[index], angle, shot });
    return true;
  }

  /** Épület sebzése; ha ettől összedől, a falai eltűnnek az ütközési rácsból. */
  /**
   * Épület sebzése; `silent`: a sérülésről ne menjen esemény (az összedőlésről mindig megy);
   * `by`: a tank, amelyik okozta (ha összedől, neki íródik jóvá).
   */
  private damageStructure(index: number, amount: number, silent = false, by = 0): void {
    const structures = this.terrain.structures;
    if (!structures || index < 0 || index >= structures.count) return;
    if (structures.damage(index, amount)) {
      const wrecker = this.tank(by);
      if (wrecker) wrecker.wrecked++;
      this.terrain.walls.setOwnerEnabled(index, false);
      this.events.push({ type: 'collapse', index, x: structures.x[index], y: structures.y[index] });
    } else if (!silent && !structures.collapsed[index] && structures.maxHp[index] !== Infinity) {
      this.events.push({ type: 'structure', index, x: structures.x[index], y: structures.y[index], left: structures.hp[index] / structures.maxHp[index] });
    }
  }

  /** Az egymásba csúszott tankok szétválasztása. */
  private separateTanks(): void {
    const { tanks, terrain } = this;
    for (let i = 0; i < tanks.length; i++) {
      const a = tanks[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < tanks.length; j++) {
        const b = tanks[j];
        if (!b.alive) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        const min = tankRadius(a) + tankRadius(b);
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 0.001;
        const push = (min - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        // a szétválasztás után egyik se kerüljön falba
        const ra = terrain.walls.resolveCircle(a.x - ux * push, a.y - uy * push, tankRadius(a));
        const rb = terrain.walls.resolveCircle(b.x + ux * push, b.y + uy * push, tankRadius(b));
        a.x = ra.x;
        a.y = ra.y;
        b.x = rb.x;
        b.y = rb.y;
        // az ütközés megtöri a lendületet
        a.speed *= 0.6;
        b.speed *= 0.6;
      }
    }
  }

  private fire(tank: TankState): void {
    const { terrain } = this;
    const fx = tank.effects;
    const laser = tank.weapon === 'laser';
    const rocket = tank.weapon === 'rocket';
    const kind: ShellKind = rocket ? 'rocket' : tank.weapon === 'heavy' ? 'heavy' : 'shell';
    tank.cooldown = TANK.fireCooldown * (fx.rapid > 0 ? BOOST.rapidCooldown : 1) * (laser ? LASER.cooldown : rocket ? ROCKET.cooldown : 1);

    const barrel = TANK.barrelLength * tankSize(tank);
    const mx = tank.x + Math.cos(tank.turretAngle) * barrel;
    const my = tank.y + Math.sin(tank.turretAngle) * barrel;
    this.events.push({ type: 'shot', tank: tank.id, kind: laser ? 'laser' : kind, x: mx, y: my, angle: tank.turretAngle });
    // ha a cső vége falban van, a lövés azonnal becsapódik
    const blocked = terrain.walls.raycast(tank.x, tank.y, mx, my);
    if (blocked) {
      this.events.push({ type: 'impact', kind: laser ? 'laser' : kind, x: blocked.x, y: blocked.y });
      this.damageStructure(blocked.owner, DAMAGE[laser ? 'laser' : kind] * damageBoost(tank), false, tank.id);
      return;
    }

    // hármas lövésnél a lövedékek (sugarak) legyezőben indulnak; lövésenként egy töltet fogy
    const triple = tank.tripleShots > 0;
    if (triple) tank.tripleShots--;
    const spread = triple ? [-BOOST.tripleSpread, 0, BOOST.tripleSpread] : [0];
    tank.shots += spread.length;
    for (const offset of spread) {
      const angle = tank.turretAngle + offset;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      if (laser) {
        this.fireLaser(tank, mx, my, cos, sin);
        continue;
      }
      const speed = rocket ? ROCKET.startSpeed : BULLET.speed * (kind === 'heavy' ? BOOST.heavySpeed : 1);
      this.bullets.push({
        id: this.nextId++,
        owner: tank.id,
        team: tank.team,
        kind,
        x: mx,
        y: my,
        vx: cos * speed,
        vy: sin * speed,
        life: rocket ? ROCKET.life : BULLET.life * (kind === 'heavy' ? BOOST.heavyLife : 1),
        bounces: tank.ricochet && !rocket ? BOOST.ricochetBounces : 0,
      });
    }
  }

  /** Lézer: azonnal célba ér – az első ellenséges tankig, falig vagy a lőtáv végéig. */
  private fireLaser(tank: TankState, mx: number, my: number, cos: number, sin: number): void {
    let ex = mx + cos * LASER.range;
    let ey = my + sin * LASER.range;
    const wall = this.terrain.walls.raycast(mx, my, ex, ey);
    let reach = wall ? wall.t : 1;
    const wreckT = this.wreckOnPath(mx, my, ex, ey, reach);
    if (wreckT >= 0) reach = wreckT;
    const vehicle = this.vehicleOnPath(mx, my, ex, ey, reach);
    if (vehicle) reach = vehicle.t;
    const turret = this.turretOnPath(mx, my, ex, ey, tank.team, reach);
    if (turret) reach = turret.t;
    const barrel = this.barrelOnPath(mx, my, ex, ey, reach);
    if (barrel) reach = barrel.t;
    const target = this.firstTankOnPath(mx, my, ex, ey, tank.team, reach);
    if (target) reach = target.t;
    // a sugár az útjába eső első fát vagy oszlopot kidönti, és ott megáll
    const prop = this.terrain.fellables?.raycast(mx, my, ex, ey, reach) ?? null;
    if (prop) reach = prop.t;
    ex = mx + cos * LASER.range * reach;
    ey = my + sin * LASER.range * reach;
    if (target || wall || prop || vehicle || turret || barrel || wreckT >= 0) this.events.push({ type: 'impact', kind: 'laser', x: ex, y: ey });
    this.events.push({ type: 'laser', x1: mx, y1: my, x2: ex, y2: ey });
    // a legközelebbi találat számít: a keresés sorrendje miatt mindig a később talált van közelebb
    if (prop) this.fell(prop.index, Math.atan2(sin, cos));
    else if (target) {
      tank.hits++;
      this.damage(target.tank, DAMAGE.laser, tank.id, ex, ey);
    } else if (barrel) this.igniteBarrel(barrel.barrel, tank.id, 0);
    else if (turret) this.damageTurret(turret.turret, DAMAGE.laser * damageBoost(tank));
    else if (vehicle) this.damageVehicle(vehicle.vehicle, DAMAGE.laser * damageBoost(tank), tank.id);
    else if (wall && wreckT < 0) this.damageStructure(wall.owner, DAMAGE.laser * damageBoost(tank), false, tank.id);
  }

  /** Az útvonal első ellenséges (más csapatbeli) tankja a `limit` paraméterig. */
  private firstTankOnPath(ax: number, ay: number, bx: number, by: number, team: number, limit: number): { tank: TankState; t: number } | null {
    let best: { tank: TankState; t: number } | null = null;
    for (const other of this.tanks) {
      if (!other.alive || other.team === team) continue;
      const t = segmentCircle(ax, ay, bx, by, other.x, other.y, tankRadius(other) + 0.3);
      if (t >= 0 && t <= limit && (!best || t < best.t)) best = { tank: other, t };
    }
    return best;
  }

  /** Sebzés: a sebezhetetlenség és a pajzs felfogja, különben fogy az életerő. */
  private damage(tank: TankState, amount: number, by: number, x: number, y: number): void {
    if (!tank.alive) return;
    if (tank.effects.invulnerable > 0) {
      this.events.push({ type: 'hit', tank: tank.id, by, x, y, absorbed: 'invulnerable', amount: 0 });
      return;
    }
    if (tank.shield > 0) {
      tank.shield--;
      this.events.push({ type: 'hit', tank: tank.id, by, x, y, absorbed: 'shield', amount: 0 });
      return;
    }
    // a támadó szintje növeli a sebzést
    const attacker = this.tank(by);
    const dealt = amount * (attacker ? damageBoost(attacker) : 1);
    tank.hp -= dealt;
    this.events.push({ type: 'hit', tank: tank.id, by, x, y, absorbed: null, amount: Math.round(dealt) });
    if (tank.hp > 0) return;
    tank.hp = 0;
    tank.alive = false;
    tank.respawn = TANK.respawnDelay;
    tank.speed = 0;
    tank.deaths++;
    tank.streak = 0;
    if (tank.lives > 0 && --tank.lives === 0) {
      tank.out = true;
      this.events.push({ type: 'eliminated', tank: tank.id, by });
    }
    this.wrecks.push({ id: this.nextId++, x: tank.x, y: tank.y, hullAngle: tank.hullAngle, turretAngle: tank.turretAngle, team: tank.team, level: tank.level, age: 0 });
    if (this.wrecks.length > WRECK.max) this.wrecks.shift();
    if (attacker && attacker !== tank) {
      attacker.kills++;
      attacker.streak++;
      attacker.bestStreak = Math.max(attacker.bestStreak, attacker.streak);
      // kilövéssorozatért tüzérségi csapás jár (csak a játékosoknak)
      if (!attacker.bot && attacker.streak % STRIKE.every === 0) {
        attacker.strikes = Math.min(STRIKE.max, attacker.strikes + 1);
        this.events.push({ type: 'streak', tank: attacker.id, streak: attacker.streak, strikes: attacker.strikes });
      }
      // csak a játékosok tankja fejlődik, a botoké nem
      if (!attacker.bot && attacker.level < LEVEL.max) {
        // szintlépés: a többlet életerőt azonnal megkapja
        attacker.level++;
        attacker.hp = Math.min(tankMaxHp(attacker), attacker.hp + LEVEL.hp);
        this.events.push({ type: 'levelup', tank: attacker.id, level: attacker.level });
      }
    }
    this.events.push({ type: 'destroyed', tank: tank.id, by, x: tank.x, y: tank.y });
  }

  // --- civil járművek ---------------------------------------------------------------

  addVehicle(kind: VehicleKind, look: number, x: number, y: number, angle: number): VehicleState {
    const vehicle: VehicleState = { id: this.nextId++, kind, look, x, y, angle, speed: 0, hp: VEHICLES[kind].hp, state: VSTATE.driving, timer: 0, by: 0 };
    this.vehicles.push(vehicle);
    return vehicle;
  }

  removeVehicle(id: number): void {
    const at = this.vehicles.findIndex((v) => v.id === id);
    if (at >= 0) this.vehicles.splice(at, 1);
  }

  /** A szakasz első találata egy járművön (vagy a roncsán) a `limit` paraméterig. */
  private vehicleOnPath(ax: number, ay: number, bx: number, by: number, limit: number): { vehicle: VehicleState; t: number } | null {
    let best: { vehicle: VehicleState; t: number } | null = null;
    const len = Math.hypot(bx - ax, by - ay);
    for (const v of this.vehicles) {
      if (v.state === VSTATE.flat) continue;
      const spec = VEHICLES[v.kind];
      const far = len + spec.half + spec.r;
      if (Math.abs(v.x - ax) > far || Math.abs(v.y - ay) > far) continue;
      const cos = Math.cos(v.angle);
      const sin = Math.sin(v.angle);
      for (const off of spec.circles) {
        const t = segmentCircle(ax, ay, bx, by, v.x + cos * off, v.y + sin * off, spec.r);
        if (t >= 0 && t <= limit && (!best || t < best.t)) best = { vehicle: v, t };
      }
    }
    return best;
  }

  /** Jármű sebzése: ha elfogy az életereje, kigyullad, és rövid idő múlva felrobban. */
  private damageVehicle(v: VehicleState, amount: number, by: number): void {
    if (this.rules.mirror || v.state >= VSTATE.wreck) return;
    if (v.state === VSTATE.burning) {
      // az égő járművet érő újabb találat sietteti a robbanást
      v.timer = Math.min(v.timer, VEHICLE.hurry);
      return;
    }
    v.hp -= amount;
    if (v.hp > 0) return;
    v.hp = 0;
    v.state = VSTATE.burning;
    v.timer = VEHICLES[v.kind].fuse;
    v.by = by;
  }

  /** A magas szintű tank összelapítja a járművet: nem robban fel, és át lehet hajtani rajta. */
  private crushVehicle(v: VehicleState, power: number): void {
    if (this.rules.mirror || v.state === VSTATE.flat) return;
    v.hp -= power;
    if (v.hp > 0 && v.state === VSTATE.driving) return;
    const loaded = v.state !== VSTATE.wreck;
    v.state = VSTATE.flat;
    v.timer = 0;
    v.speed = 0;
    this.events.push({ type: 'crushed', x: v.x, y: v.y });
    if (loaded) this.dropCargo(v);
  }

  /** Az ellátó teherautó rakománya a jármű mellé, az út közepe felé esik ki. */
  private dropCargo(v: VehicleState): void {
    if (v.kind !== 'truck') return;
    const cos = Math.cos(v.angle);
    const sin = Math.sin(v.angle);
    for (let i = 0; i < VEHICLE.cargo; i++) {
      const along = (i - (VEHICLE.cargo - 1) / 2) * 4;
      const spot = this.terrain.walls.resolveCircle(v.x + cos * along + sin * 4.2, v.y + sin * along - cos * 4.2, PICKUP.radius);
      const kind = CARGO_KINDS[Math.floor(this.rnd() * CARGO_KINDS.length)];
      this.pickups.push({ id: this.nextId++, kind, x: spot.x, y: spot.y, extra: true });
    }
  }

  /** A kigyulladt jármű felrobban: sebzi a közeli tankokat, járműveket és ágyúkat, kidönti a fákat. */
  private blast(v: VehicleState): void {
    const spec = VEHICLES[v.kind];
    const radius = spec.blastRadius;
    v.state = VSTATE.wreck;
    v.timer = 0;
    v.speed = 0;
    this.events.push({ type: 'blast', kind: v.kind, x: v.x, y: v.y, radius });
    const falloff = (dist: number): number => spec.blastDamage * (1 - 0.6 * Math.min(1, dist / radius));
    for (const tank of this.tanks) {
      if (!tank.alive) continue;
      const dist = Math.hypot(tank.x - v.x, tank.y - v.y) - tankRadius(tank);
      // a robbanás azt is sebzi, aki a járművet felgyújtotta – de önmaga kilövéséért nem jár neki pont
      if (dist <= radius) this.damage(tank, falloff(Math.max(0, dist)), tank.id === v.by ? 0 : v.by, v.x, v.y);
    }
    for (const other of this.vehicles) {
      if (other === v) continue;
      if (Math.hypot(other.x - v.x, other.y - v.y) <= radius + VEHICLES[other.kind].half) this.damageVehicle(other, spec.blastDamage, v.by);
    }
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      const dist = Math.hypot(t.x - v.x, t.y - v.y);
      if (dist <= radius) this.damageTurret(t, falloff(dist));
    }
    const props = this.terrain.fellables;
    props?.forEachTouching(v.x, v.y, radius * 0.8, (i) => {
      this.fell(i, Math.atan2(props.y[i] - v.y, props.x[i] - v.x));
    });
    this.igniteNear(v.x, v.y, radius, v.by);
    this.dropCargo(v);
  }

  private stepVehicles(dt: number): void {
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (v.state === VSTATE.burning) {
        // az égő jármű kigurul és megáll
        v.speed = Math.max(0, v.speed - 16 * dt);
        v.x += Math.cos(v.angle) * v.speed * dt;
        v.y += Math.sin(v.angle) * v.speed * dt;
        v.timer -= dt;
        if (v.timer <= 0) this.blast(v);
      } else if (v.state >= VSTATE.wreck) {
        v.timer += dt;
        if (v.timer >= (v.state === VSTATE.wreck ? VEHICLE.wreckLife : VEHICLE.flatLife)) this.vehicles.splice(i, 1);
      }
    }
  }

  // --- telepíthető ágyúk --------------------------------------------------------------

  /** Az útvonal első ellenséges (más csapatbeli) ágyúja a `limit` paraméterig. */
  private turretOnPath(ax: number, ay: number, bx: number, by: number, team: number, limit: number): { turret: TurretState; t: number } | null {
    let best: { turret: TurretState; t: number } | null = null;
    for (const turret of this.turrets) {
      if (turret.team === team) continue;
      const t = segmentCircle(ax, ay, bx, by, turret.x, turret.y, TURRET.radius);
      if (t >= 0 && t <= limit && (!best || t < best.t)) best = { turret, t };
    }
    return best;
  }

  private damageTurret(turret: TurretState, amount: number): void {
    if (this.rules.mirror) return;
    turret.hp -= amount;
    if (turret.hp > 0) return;
    const at = this.turrets.indexOf(turret);
    if (at >= 0) this.turrets.splice(at, 1);
    this.events.push({ type: 'turretDown', owner: turret.owner, x: turret.x, y: turret.y });
  }

  /** Ágyú lerakása a tank mögé; ha már túl sok áll a pályán, a legrégebbi eltűnik. */
  private deployTurret(tank: TankState): void {
    if (this.rules.mirror) return;
    tank.turrets--;
    tank.dropCooldown = OIL.dropCooldown;
    const back = tankRadius(tank) + TURRET.radius + 1.6;
    const spot = this.terrain.walls.resolveCircle(tank.x - Math.cos(tank.hullAngle) * back, tank.y - Math.sin(tank.hullAngle) * back, TURRET.radius);
    const mine = this.turrets.filter((t) => t.owner === tank.id);
    if (mine.length >= TURRET.maxPerOwner) this.damageTurret(mine[0], Infinity);
    this.turrets.push({ id: this.nextId++, owner: tank.id, team: tank.team, x: spot.x, y: spot.y, angle: tank.turretAngle, hp: TURRET.hp, cooldown: TURRET.fireInterval, target: -1 });
    this.events.push({ type: 'deploy', tank: tank.id, x: spot.x, y: spot.y });
  }

  private stepTurrets(dt: number): void {
    const { walls } = this.terrain;
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const turret = this.turrets[i];
      const owner = this.tank(turret.owner);
      // a kiesett vagy kilépett játékos ágyúi eltűnnek
      if (!owner || owner.out) {
        this.damageTurret(turret, Infinity);
        continue;
      }
      turret.cooldown = Math.max(0, turret.cooldown - dt);
      // célpont: a legközelebbi ellenséges tank, amelyre rálát (néhány lépésenként keresi újra)
      if ((this.tick + turret.id) % TURRET.scanEvery === 0) {
        let best: number = TURRET.range;
        turret.target = -1;
        for (const other of this.tanks) {
          if (!other.alive || other.team === turret.team) continue;
          const dist = Math.hypot(other.x - turret.x, other.y - turret.y);
          if (dist >= best || walls.raycast(turret.x, turret.y, other.x, other.y)) continue;
          if (dist > 9 && this.inSmoke(other.x, other.y)) continue; // a füstbe nem lát be
          best = dist;
          turret.target = other.id;
        }
      }
      const target = turret.target >= 0 ? this.tank(turret.target) : undefined;
      if (!target || !target.alive) continue;
      const aim = Math.atan2(target.y - turret.y, target.x - turret.x);
      turret.angle = rotateToward(turret.angle, aim, TURRET.turnRate * dt);
      if (turret.cooldown > 0 || Math.abs(angleDiff(aim, turret.angle)) > 0.05) continue;
      turret.cooldown = TURRET.fireInterval;
      const cos = Math.cos(turret.angle);
      const sin = Math.sin(turret.angle);
      const mx = turret.x + cos * TURRET.barrelLength;
      const my = turret.y + sin * TURRET.barrelLength;
      this.events.push({ type: 'shot', tank: 0, kind: 'shell', x: mx, y: my, angle: turret.angle });
      this.bullets.push({ id: this.nextId++, owner: turret.owner, team: turret.team, kind: 'shell', x: mx, y: my, vx: cos * BULLET.speed, vy: sin * BULLET.speed, life: BULLET.life, bounces: 0, auto: true });
    }
  }

  // --- akna, füst, tüzérség, gázpalack ----------------------------------------------------

  /** Van-e a pont füstfelhőben (a botok és az ágyúk nem látnak be). */
  inSmoke(x: number, y: number): boolean {
    for (const s of this.smokes) {
      const dx = x - s.x;
      const dy = y - s.y;
      if (dx * dx + dy * dy < SMOKE.radius * SMOKE.radius) return true;
    }
    return false;
  }

  /** Gázpalackok szétszórása a házak mellé (a pálya adja a helyeket). */
  scatterBarrels(count: number): void {
    const spotOf = this.terrain.barrelSpot?.bind(this.terrain);
    if (!spotOf) return;
    for (let attempt = 0; attempt < count * 6 && this.barrels.length < count; attempt++) {
      const spot = spotOf(this.rnd);
      if (!spot) continue;
      if (this.barrels.some((b) => Math.abs(b.x - spot.x) < 5 && Math.abs(b.y - spot.y) < 5)) continue;
      if (this.tanks.some((t) => Math.hypot(t.x - spot.x, t.y - spot.y) < 12)) continue;
      this.barrels.push({ id: this.nextId++, x: spot.x, y: spot.y, fuse: -1, by: 0 });
    }
  }

  /** A megadott ponthoz legközelebbi, járművel elérhető szabad hely (a szupertárgynak). */
  nearestSpot(x: number, y: number): { x: number; y: number } {
    const spotOf = this.terrain.pickupSpot?.bind(this.terrain);
    let best: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (let attempt = 0; spotOf && attempt < 90; attempt++) {
      const spot = spotOf(this.rnd);
      if (!spot) continue;
      const dist = Math.hypot(spot.x - x, spot.y - y);
      if (dist < bestDist) {
        best = spot;
        bestDist = dist;
      }
    }
    if (best) return best;
    const free = this.terrain.walls.resolveCircle(x, y, PICKUP.radius + 1);
    return { x: free.x, y: free.y };
  }

  /** Akna lerakása a tank mögé; ha már túl sok van kint, a legrégebbi eltűnik. */
  private layMine(tank: TankState): void {
    tank.mines--;
    tank.dropCooldown = OIL.dropCooldown;
    const back = tankRadius(tank) + 1.6;
    const spot = this.terrain.walls.resolveCircle(tank.x - Math.cos(tank.hullAngle) * back, tank.y - Math.sin(tank.hullAngle) * back, 0.7);
    const mine = this.mines.filter((m) => m.owner === tank.id);
    if (mine.length >= MINE.maxPlaced) this.mines.splice(this.mines.indexOf(mine[0]), 1);
    this.mines.push({ id: this.nextId++, owner: tank.id, team: tank.team, x: spot.x, y: spot.y, arm: MINE.arm, life: MINE.life, fuse: -1 });
    this.events.push({ type: 'mine', tank: tank.id, x: spot.x, y: spot.y });
  }

  /** Füstfelhő a tank köré. */
  private dropSmoke(tank: TankState): void {
    tank.smokes--;
    tank.dropCooldown = OIL.dropCooldown;
    this.smokes.push({ id: this.nextId++, x: tank.x, y: tank.y, life: SMOKE.life });
    this.events.push({ type: 'smoke', tank: tank.id, x: tank.x, y: tank.y });
  }

  /** Tüzérségi csapás kérése a megadott helyre (a játéktéren belülre igazítva). */
  private callStrike(tank: TankState, tx: number, ty: number): void {
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
    tank.strikes--;
    tank.dropCooldown = OIL.dropCooldown;
    const area = this.area();
    const x = Math.max(area.minX, Math.min(area.maxX, tx));
    const y = Math.max(area.minY, Math.min(area.maxY, ty));
    this.strikes.push({ id: this.nextId++, owner: tank.id, team: tank.team, x, y, delay: STRIKE.delay, shells: STRIKE.shells, next: 0 });
    this.events.push({ type: 'strike', tank: tank.id, x, y, radius: STRIKE.spread, delay: STRIKE.delay });
  }

  /** A szakasz első találata egy (még be nem indított) gázpalackon. */
  private barrelOnPath(ax: number, ay: number, bx: number, by: number, limit: number): { barrel: BarrelState; t: number } | null {
    if (this.barrels.length === 0) return null;
    const minX = Math.min(ax, bx) - 1;
    const maxX = Math.max(ax, bx) + 1;
    const minY = Math.min(ay, by) - 1;
    const maxY = Math.max(ay, by) + 1;
    let best: { barrel: BarrelState; t: number } | null = null;
    for (const barrel of this.barrels) {
      if (barrel.x < minX || barrel.x > maxX || barrel.y < minY || barrel.y > maxY) continue;
      const t = segmentCircle(ax, ay, bx, by, barrel.x, barrel.y, BARREL.radius);
      if (t >= 0 && t <= limit && (!best || t < best.t)) best = { barrel, t };
    }
    return best;
  }

  /** A gázpalack beindítása: `delay` mp múlva robban; `by`: akinek a robbanás számít. */
  private igniteBarrel(barrel: BarrelState, by: number, delay: number): void {
    if (this.rules.mirror || barrel.fuse >= 0) return;
    barrel.fuse = delay;
    barrel.by = by;
  }

  /** A robbanás beindítja a közeli gázpalackokat és aknákat (láncreakció, kis késéssel). */
  private igniteNear(x: number, y: number, radius: number, by: number): void {
    for (const barrel of this.barrels) {
      if (barrel.fuse >= 0 || Math.abs(barrel.x - x) > radius || Math.abs(barrel.y - y) > radius) continue;
      if (Math.hypot(barrel.x - x, barrel.y - y) <= radius) this.igniteBarrel(barrel, by, BARREL.chainDelay * (0.7 + this.rnd() * 0.8));
    }
    for (const mine of this.mines) {
      if (mine.fuse < 0 && Math.hypot(mine.x - x, mine.y - y) <= radius * 0.8) mine.fuse = BARREL.chainDelay;
    }
  }

  /**
   * Robbanás (akna, gázpalack, tüzérségi lövedék): a távolsággal gyengülve sebzi a
   * közeli tankokat – a `spare` csapatét nem –, a járműveket és az ágyúkat,
   * kidönti a fákat, és beindítja a közeli palackokat, aknákat. Aki a saját
   * robbanásában hal meg, annak a kilövéséért nem jár pont.
   */
  private boom(kind: BoomKind, x: number, y: number, radius: number, damage: number, by: number, spare = -1): void {
    this.events.push({ type: 'boom', kind, x, y, radius });
    const falloff = (dist: number): number => damage * (1 - 0.6 * Math.min(1, Math.max(0, dist) / radius));
    for (const tank of this.tanks) {
      if (!tank.alive || tank.team === spare) continue;
      const dist = Math.hypot(tank.x - x, tank.y - y) - tankRadius(tank);
      if (dist <= radius) this.damage(tank, falloff(dist), tank.id === by ? 0 : by, x, y);
    }
    for (const v of this.vehicles) {
      if (Math.hypot(v.x - x, v.y - y) <= radius + VEHICLES[v.kind].half) this.damageVehicle(v, damage, by);
    }
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      const dist = Math.hypot(t.x - x, t.y - y);
      if (t.team !== spare && dist <= radius) this.damageTurret(t, falloff(dist));
    }
    const props = this.terrain.fellables;
    props?.forEachTouching(x, y, radius * 0.8, (i) => {
      this.fell(i, Math.atan2(props.y[i] - y, props.x[i] - x));
    });
    this.igniteNear(x, y, radius, by);
  }

  /** A tüzérségi lövedék a becsapódás közelében álló épületeket is rombolja. */
  private shellStructures(x: number, y: number, by: number): void {
    const hit = new Set<number>();
    const reach = STRIKE.blastRadius * 0.75;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const wall = this.terrain.walls.raycast(x, y, x + Math.cos(a) * reach, y + Math.sin(a) * reach);
      if (wall && wall.owner >= 0) hit.add(wall.owner);
    }
    for (const index of hit) this.damageStructure(index, STRIKE.structureDamage, false, by);
  }

  private stepGadgets(dt: number): void {
    // aknák: élesedés után az ellenséges tank érintésére robbannak
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const mine = this.mines[i];
      mine.life -= dt;
      mine.arm = Math.max(0, mine.arm - dt);
      let go = false;
      if (mine.fuse >= 0) {
        mine.fuse -= dt;
        go = mine.fuse <= 0;
      } else if (mine.life <= 0) {
        this.mines.splice(i, 1);
        continue;
      } else if (mine.arm === 0) {
        for (const tank of this.tanks) {
          if (!tank.alive || tank.team === mine.team) continue;
          const dx = tank.x - mine.x;
          const dy = tank.y - mine.y;
          const reach = tankRadius(tank) + MINE.trigger;
          if (dx * dx + dy * dy <= reach * reach) {
            go = true;
            break;
          }
        }
      }
      if (!go) continue;
      this.mines.splice(i, 1);
      this.boom('mine', mine.x, mine.y, MINE.blastRadius, MINE.damage, mine.owner, mine.team);
    }

    for (let i = this.smokes.length - 1; i >= 0; i--) {
      this.smokes[i].life -= dt;
      if (this.smokes[i].life <= 0) this.smokes.splice(i, 1);
    }

    // tüzérségi csapások: a figyelmeztetés után sorban hullanak a lövedékek
    const area = this.area();
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const strike = this.strikes[i];
      strike.delay -= dt;
      if (strike.delay > 0) continue;
      strike.next -= dt;
      while (strike.next <= 0 && strike.shells > 0) {
        strike.shells--;
        strike.next += STRIKE.interval;
        const angle = this.rnd() * Math.PI * 2;
        const dist = Math.sqrt(this.rnd()) * STRIKE.spread;
        const x = Math.max(area.minX, Math.min(area.maxX, strike.x + Math.cos(angle) * dist));
        const y = Math.max(area.minY, Math.min(area.maxY, strike.y + Math.sin(angle) * dist));
        this.boom('shell', x, y, STRIKE.blastRadius, STRIKE.damage, strike.owner, strike.team);
        this.shellStructures(x, y, strike.owner);
      }
      if (strike.shells === 0) this.strikes.splice(i, 1);
    }

    // gázpalackok: a beindított felrobban; amelyikre tank hajt, az is
    for (let i = this.barrels.length - 1; i >= 0; i--) {
      const barrel = this.barrels[i];
      let go = false;
      if (barrel.fuse >= 0) {
        barrel.fuse -= dt;
        go = barrel.fuse <= 0;
      } else {
        for (const tank of this.tanks) {
          if (!tank.alive || Math.abs(tank.speed) < 0.5) continue;
          const dx = tank.x - barrel.x;
          const dy = tank.y - barrel.y;
          if (dx > 6 || dx < -6 || dy > 6 || dy < -6) continue;
          const reach = tankRadius(tank) + BARREL.radius * 0.4;
          if (dx * dx + dy * dy <= reach * reach) {
            barrel.by = tank.id;
            go = true;
            break;
          }
        }
      }
      if (!go) continue;
      this.barrels.splice(i, 1);
      this.boom('barrel', barrel.x, barrel.y, BARREL.blastRadius, BARREL.damage, barrel.by);
    }
  }

  private dropOil(tank: TankState): void {
    tank.oil--;
    tank.dropCooldown = OIL.dropCooldown;
    // a folt a tank mögé kerül
    const x = tank.x - Math.cos(tank.hullAngle) * (tankRadius(tank) + OIL.radius * 0.6);
    const y = tank.y - Math.sin(tank.hullAngle) * (tankRadius(tank) + OIL.radius * 0.6);
    this.oils.push({ id: this.nextId++, owner: tank.id, x, y, life: OIL.life, ownerSafe: true });
    this.events.push({ type: 'oil', tank: tank.id, x, y });
  }

  private explode(b: BulletState, x: number, y: number, direct: TankState | null): void {
    this.events.push({ type: 'impact', kind: b.kind, x, y });
    if (direct) {
      const shooter = b.auto ? undefined : this.tank(b.owner);
      if (shooter) shooter.hits++;
      this.damage(direct, DAMAGE[b.kind], b.owner, x, y);
    }
    if (b.kind !== 'rocket') return;
    this.igniteNear(x, y, DAMAGE.splashRadius, b.owner);
    // a rakéta robbanása kidönti a közeli fákat és oszlopokat (a robbanástól elfelé dőlnek)
    const props = this.terrain.fellables;
    props?.forEachTouching(x, y, DAMAGE.splashRadius, (i) => {
      this.fell(i, Math.atan2(props.y[i] - y, props.x[i] - x));
    });
    // … és a közelben álló ellenséges tankokat is sebzi
    for (const other of this.tanks) {
      if (!other.alive || other === direct || other.team === b.team) continue;
      if (Math.hypot(other.x - x, other.y - y) <= DAMAGE.splashRadius) this.damage(other, DAMAGE.splash, b.owner, x, y);
    }
    // … a járműveket és az ellenséges ágyúkat is
    for (const v of this.vehicles) {
      if (Math.hypot(v.x - x, v.y - y) <= DAMAGE.splashRadius + VEHICLES[v.kind].half) this.damageVehicle(v, DAMAGE.splash, b.owner);
    }
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      if (t.team !== b.team && Math.hypot(t.x - x, t.y - y) <= DAMAGE.splashRadius) this.damageTurret(t, DAMAGE.splash);
    }
  }

  private stepBullets(dt: number): void {
    const { terrain } = this;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      if (b.kind === 'rocket') {
        // a rakéta menet közben gyorsul
        const v = Math.hypot(b.vx, b.vy);
        const next = Math.min(ROCKET.maxSpeed, v + ROCKET.accel * dt);
        b.vx *= next / v;
        b.vy *= next / v;
      }
      const nx = b.x + b.vx * dt;
      const ny = b.y + b.vy * dt;
      const wall = terrain.walls.raycast(b.x, b.y, nx, ny);
      const wreckT = this.wreckOnPath(b.x, b.y, nx, ny, wall ? wall.t : 1);
      let solid = wreckT >= 0 ? wreckT : wall ? wall.t : 1;
      // jármű vagy ellenséges ágyú az útban (a később talált mindig közelebb van)
      const vehicle = this.vehicleOnPath(b.x, b.y, nx, ny, solid);
      if (vehicle) solid = vehicle.t;
      const turret = this.turretOnPath(b.x, b.y, nx, ny, b.team, solid);
      if (turret) solid = turret.t;
      const barrel = this.barrelOnPath(b.x, b.y, nx, ny, solid);
      if (barrel) solid = barrel.t;
      const target = this.firstTankOnPath(b.x, b.y, nx, ny, b.team, solid);
      // fa vagy oszlop az útban: kidől, a lövedék ott robban
      const prop = terrain.fellables?.raycast(b.x, b.y, nx, ny, target ? target.t : solid) ?? null;
      if (prop) {
        this.fell(prop.index, Math.atan2(b.vy, b.vx));
        this.explode(b, b.x + (nx - b.x) * prop.t, b.y + (ny - b.y) * prop.t, null);
        this.bullets.splice(i, 1);
        continue;
      }
      if (target) {
        this.explode(b, b.x + (nx - b.x) * target.t, b.y + (ny - b.y) * target.t, target.tank);
        this.bullets.splice(i, 1);
        continue;
      }
      if (barrel) {
        // gázpalackot ért: a lövedék ott robban, a palack azonnal követi
        this.explode(b, b.x + (nx - b.x) * barrel.t, b.y + (ny - b.y) * barrel.t, null);
        this.igniteBarrel(barrel.barrel, b.owner, 0);
        this.bullets.splice(i, 1);
        continue;
      }
      if (turret || vehicle) {
        const boost = damageBoost(this.tank(b.owner) ?? { level: 1 });
        this.explode(b, b.x + (nx - b.x) * solid, b.y + (ny - b.y) * solid, null);
        if (turret) this.damageTurret(turret.turret, DAMAGE[b.kind] * boost);
        else if (vehicle) this.damageVehicle(vehicle.vehicle, DAMAGE[b.kind] * boost, b.owner);
        this.bullets.splice(i, 1);
        continue;
      }
      if (wreckT >= 0) {
        this.explode(b, b.x + (nx - b.x) * wreckT, b.y + (ny - b.y) * wreckT, null);
        this.bullets.splice(i, 1);
        continue;
      }
      if (wall) {
        if (b.bounces > 0) {
          // visszaverődés a fal normálisa szerint
          b.bounces--;
          const dot = b.vx * wall.nx + b.vy * wall.ny;
          b.vx -= 2 * dot * wall.nx;
          b.vy -= 2 * dot * wall.ny;
          b.x = wall.x + wall.nx * 0.05;
          b.y = wall.y + wall.ny * 0.05;
          b.life -= dt;
          this.events.push({ type: 'ricochet', x: wall.x, y: wall.y });
          continue;
        }
        this.explode(b, wall.x, wall.y, null);
        if (wall.owner >= 0) {
          const owner = this.tank(b.owner);
          this.damageStructure(wall.owner, DAMAGE[b.kind] * (owner ? damageBoost(owner) : 1), false, b.owner);
        }
        this.bullets.splice(i, 1);
        continue;
      }
      b.x = nx;
      b.y = ny;
      b.life -= dt;
      const area = this.area();
      const out = nx < area.minX || ny < area.minY || nx > area.maxX || ny > area.maxY;
      if (out || b.life <= 0) {
        if (!out) this.explode(b, nx, ny, null);
        this.bullets.splice(i, 1);
      }
    }
  }

  private stepPickups(dt: number): void {
    for (const tank of this.tanks) {
      if (!tank.alive) continue;
      const reach = tankRadius(tank) + PICKUP.radius;
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const p = this.pickups[i];
        const dx = p.x - tank.x;
        const dy = p.y - tank.y;
        if (dx * dx + dy * dy > reach * reach) continue;
        this.pickups.splice(i, 1);
        this.applyPickup(tank, p.kind);
        this.events.push({ type: 'pickup', tank: tank.id, kind: p.kind, x: p.x, y: p.y });
        if (!p.extra) this.respawns.push(PICKUP.respawnDelay);
      }
    }
    // a felvett tárgyak helyett idővel új jelenik meg, máshol
    for (let i = this.respawns.length - 1; i >= 0; i--) {
      this.respawns[i] -= dt;
      if (this.respawns[i] <= 0) {
        this.respawns.splice(i, 1);
        this.spawnPickup();
      }
    }
  }

  private applyPickup(tank: TankState, kind: PickupKind): void {
    if (kind === 'shield') tank.shield = Math.min(PICKUP.maxShield, tank.shield + 1);
    else if (kind === 'oil') tank.oil = Math.min(PICKUP.maxOil, tank.oil + PICKUP.oilPerPickup);
    else if (kind === 'turret') tank.turrets = Math.min(PICKUP.maxTurrets, tank.turrets + 1);
    else if (kind === 'mine') tank.mines = Math.min(MINE.max, tank.mines + MINE.perPickup);
    else if (kind === 'smoke') tank.smokes = Math.min(SMOKE.max, tank.smokes + SMOKE.perPickup);
    else if (kind === 'super') {
      // szupertárgy: teljes javítás, tele pajzs, és amíg tart, többszörös sebzés
      tank.hp = tankMaxHp(tank);
      tank.shield = PICKUP.maxShield;
      tank.effects.super = PICKUPS.super.duration;
    }
    else if (kind === 'repair') tank.hp = Math.min(tankMaxHp(tank), tank.hp + PICKUP.repairAmount);
    else if (isWeapon(kind)) tank.weapon = kind; // az előző fegyver helyére lép
    else if (kind === 'ricochet') tank.ricochet = true;
    else if (kind === 'triple') tank.tripleShots = Math.min(PICKUP.maxTripleShots, tank.tripleShots + PICKUP.tripleShots);
    else tank.effects[kind] = PICKUPS[kind].duration;
  }

  private stepOil(dt: number): void {
    for (let i = this.oils.length - 1; i >= 0; i--) {
      const oil = this.oils[i];
      oil.life -= dt;
      if (oil.life <= 0) {
        this.oils.splice(i, 1);
        continue;
      }
      for (const tank of this.tanks) {
        if (!tank.alive) continue;
        const dist = Math.hypot(tank.x - oil.x, tank.y - oil.y);
        if (tank.id === oil.owner && oil.ownerSafe) {
          // a lerakója csak azután csúszhat meg rajta, hogy egyszer lehajtott róla
          if (dist > OIL.radius + TANK.radius + 1) oil.ownerSafe = false;
          continue;
        }
        if (dist > OIL.radius || tank.slip > 0 || Math.abs(tank.speed) < OIL.minSpeed) continue;
        // a jó tapadás (terepjáró lánctalp) és a sebezhetetlenség megvéd
        if (tank.effects.allTerrain > 0 || tank.effects.invulnerable > 0) continue;
        tank.slip = OIL.slipTime;
        tank.slideAngle = tank.speed >= 0 ? tank.hullAngle : tank.hullAngle + Math.PI;
        tank.speed = Math.abs(tank.speed);
        // a pörgés iránya az éppen folyó kanyarodást követi, különben véletlenszerű
        const dir = tank.turnSpeed !== 0 ? Math.sign(tank.turnSpeed) : this.rnd() < 0.5 ? -1 : 1;
        tank.spin = dir * (4.5 + this.rnd() * 2);
        this.events.push({ type: 'slip', tank: tank.id, x: tank.x, y: tank.y });
      }
    }
  }
}
