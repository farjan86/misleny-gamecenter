// Játékszimuláció: tankok, lövedékek, sebzés, felvehető tárgyak, olajfoltok,
// ütközés. Tiszta, determinisztikus logika rögzített időlépéssel – nincs benne
// Phaser- vagy DOM-függés, így a későbbi szerver-authoritatív multiplayerben a
// szerver ugyanezt a kódot futtathatja. A kliens (és a botok „agya”) csak
// TankInput-ot ad, az állapotot a World számolja.
// Mértékegységek: méter, másodperc, radián.

import { SegmentGrid } from './collision';
import { FELLABLE, type Fellables } from './props';
import { BARREL, CLOAK, FLAME, MG, MINE, SMOKE, STRIKE, SUPER, WORKSHOP, insideSmoke, type WorkshopState, type BarrelState, type BoomKind, type MineState, type SmokeState, type StrikeState } from './gadgets';
import type { Structures } from './structures';
import { BOSS, isPack, ROLE } from './bossRules';
import { BOOST, CARGO_KINDS, isWeapon, LASER, mulberry32, OIL, PICKUP, pickKind, PICKUPS, ROCKET, TIMED_KINDS, type PickupKind, type TimedKind, type WeaponKind } from './pickups';
import type { NetRoad } from './roadnet';
import { TURRET, VEHICLE, VEHICLES, VSTATE, type TurretState, type VehicleKind, type VehicleState, turretInterval, turretMaxHp, turretRange } from './vehicles';

export const SIM_DT = 1 / 60;

/**
 * Választható alaptankok száma. A tank fajtája csak megjelenés: a játékszabályokra semmilyen
 * hatása nincs (méret, életerő, sebesség, sebzés ugyanaz), a szintekkel mindegyik a saját
 * formavilágában fejlődik.
 */
/** az alaptankok száma: 3 modern és 3 klasszikus (II. világháborús) – csak megjelenés */
export const TANK_LOOKS = 6;
export const cleanLook = (raw: unknown): number => (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < TANK_LOOKS ? raw : 0);

export const TANK = {
  /** újraéledés után ennyi másodpercig teljes védelem (sebezhetetlenség) */
  spawnShield: 3,
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
  /** a kezdő tank életereje: nyolc sima lövedéket bír ki */
  maxHp: 200,
  /** kilövés után ennyi idővel éled újra a tank (mp) */
  respawnDelay: 4,
} as const;

/**
 * Önjavítás: ha a tankot egy ideje nem érte sebzés, az életereje nagyon lassan
 * visszatöltődik. Szándékosan szerény: harc közben nem számít, a javítókészletet
 * nem pótolja – csak a hosszú bujkálás után nem kell fél életerővel folytatni.
 */
export const REGEN = {
  /** az utolsó sebzés után ennyi idővel indul (mp) */
  delay: 8,
  /** másodpercenként a legnagyobb életerő ekkora részét adja vissza (1% – a nulláról 100 mp alatt töltene fel) */
  rate: 0.01,
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
  hp: 24,
  /** többlet sebzés szintenként */
  damage: 0.08,
  /** a kilőtt tank ennyi szintet veszít (az 1. szint alá nem megy) */
  deathLoss: 1,
  /** ennyi bot kilövése ér egy szintet (egy játékos kilövése egyből egyet) */
  botKills: 3,
  /**
   * Játékos kilövése egy szintet ér. Ha a kilőtt játékos jóval magasabb szintű
   * volt – legalább `upsetGap` szinttel –, a győztes `upsetGain` szintet lép.
   */
  upsetGap: 3,
  upsetGain: 2,
} as const;

/**
 * A botok szívóssága (csúszka, 1–5): minél szívósabb, annál nagyobbat lő (damage: a
 * sebzésének szorzója a játékosok ellen) és annál erősebb a páncélja (armor: ennyiszer
 * nagyobb sebzést kap). A legszívósabb bot egyenrangú a játékossal.
 */
export const BOT_TOUGHNESS = [
  { damage: 0.4, armor: 2.0 },
  { damage: 0.5, armor: 1.8 },
  { damage: 0.6, armor: 1.6 },
  { damage: 0.8, armor: 1.25 },
  { damage: 1.0, armor: 1.0 },
] as const;
export const BOT_TOUGHNESS_LEVELS = { min: 1, max: 5, normal: 3 } as const;
/** a közepes szívósság (az alapérték) */
export const BOT_POWER = BOT_TOUGHNESS[BOT_TOUGHNESS_LEVELS.normal - 1];
/** ettől az ügyességi szinttől (nagyon ügyes, ultra ügyes) a bot tárgyat vesz fel és a kilövésekkel szintet lép */
export const BOT_PERKS_SKILL = 5;

/** A botokra vonatkozó szabályok egy meccsben. */
export interface BotRules {
  damage: number;
  armor: number;
  /** tárgyat vehet fel és szintet léphet */
  perks: boolean;
}
export function botRules(toughness: number = BOT_TOUGHNESS_LEVELS.normal, skill = 3): BotRules {
  const t = BOT_TOUGHNESS[Math.max(BOT_TOUGHNESS_LEVELS.min, Math.min(BOT_TOUGHNESS_LEVELS.max, Math.round(toughness))) - 1] ?? BOT_POWER;
  return { damage: t.damage, armor: t.armor, perks: skill >= BOT_PERKS_SKILL };
}

/**
 * Az épületekben okozott kár a fegyver sebzésének ennyiszerese: a nagyobb, erősebb lövedék
 * jóval jobban rombol. A rakéta robbanása ROCKET_BLAST méteren belül a szomszédos házakat is rombolja.
 */
export const STRUCTURE_MULT: Record<ShotKind, number> = { shell: 1, heavy: 2.4, rocket: 3, laser: 1.4 };
export const ROCKET_BLAST = { radius: 6, damage: 70 } as const;

/** Áll-e (vagy ér-e bele) egy r sugarú kör az alaprajzba (lapított x, y párok). */
function ringBlocks(ring: readonly number[], x: number, y: number, r: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    // a kör a falhoz ér
    const dx = xi - xj;
    const dy = yi - yj;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - xj) * dx + (y - yj) * dy) / len2));
    if (Math.hypot(x - (xj + dx * t), y - (yj + dy * t)) < r) return true;
  }
  return inside;
}

/** Ennyi szintet lép, aki `level` szinten kilő egy `victim` szintű játékost. */
export function killGain(level: number, victim: number): number {
  return victim - level >= LEVEL.upsetGap ? LEVEL.upsetGain : 1;
}

/** A tank mérete az alapmérethez képest (1. szint = 1). */
/** A szint osztálya (0 … LEVEL.tiers.length − 1). */
export function tankTier(level: number): number {
  let tier = 0;
  for (let i = 1; i < LEVEL.tiers.length; i++) if (level >= LEVEL.tiers[i]) tier = i;
  return tier;
}
export const tankSize = (tank: { level: number; role?: number }): number =>
  (1 + LEVEL.size * (tank.level - 1) + LEVEL.tierSize * tankTier(tank.level)) * (tank.role === ROLE.boss ? BOSS.sizeMult : 1);
export const tankRadius = (tank: { level: number; role?: number }): number => TANK.radius * tankSize(tank);
export const tankMaxHp = (tank: { level: number; role?: number }): number => (TANK.maxHp + LEVEL.hp * (tank.level - 1)) * (tank.role === ROLE.boss ? BOSS.hpMult : 1);
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
export const wreckRadius = (wreck: { level: number; role?: number }): number => WRECK.radius * tankSize(wreck);

/**
 * Az ágyúlövedék. Egyik fegyver sem lő messzebb SHOT_RANGE méternél (kb. a képernyő
 * szélessége): a pálya túlsó végéről nem lehet eltalálni senkit.
 */
export const BULLET = {
  speed: 75,
  life: 2.1,
} as const;
export const SHOT_RANGE = 160;
/** a játékos tankja újraéledéskor és belépéskor a térkép teteje felé néz */
export const SPAWN_ANGLE = -Math.PI / 2;

/** Sebzés találatonként (a tank életereje 100). */
export const DAMAGE = {
  shell: 25,
  heavy: 50,
  rocket: 55,
  laser: 24,
  /** a rakéta robbanása ekkora körben sebez (m), ennyit */
  splashRadius: 7,
  splash: 30,
} as const;

/** Csapatok: az azonos csapatban lévők nem sebzik egymást. */
export const TEAM = { player: 0, bots: 1, boss: 2 } as const;
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
  /** álcázás bekapcsolása (ha éppen használható) */
  cloak?: boolean;
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
  /** kilőtt ellenséges játékosok (a botok nem számítanak bele: azok a botsDown-ban vannak) */
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
  /** az ellenséges tankoknak okozott, illetve az elszenvedett sebzés összesen (a meccs végi statisztikához) */
  dealt: number;
  taken: number;
  /** az utolsó sebzés óta eltelt idő (mp) – az önjavításhoz */
  calm: number;
  /** az álcázásból hátralévő idő (mp; 0: nincs álcázva), és ennyi idő múlva használható újra */
  cloak: number;
  cloakReady: number;
  /** a kilőtt botok száma a következő szintlépésig (LEVEL.botKills-nél szintet lép) */
  botKills: number;
  /** az összes kilőtt bot (statisztika: a kilövések közé – kills – nem számít) */
  botsDown: number;
  /** a kiegészítő géppuska következő lövéséig hátralévő idő (mp) */
  gunCooldown: number;
  dropCooldown: number;
  /** az alaptank fajtája (0 … TANK_LOOKS − 1): csak megjelenés */
  look: number;
  /** szerep: közönséges tank, a főgonosz vagy a testőre (ROLE) */
  role: number;
  /** hányszor győzte le a főgonoszt */
  bossKills: number;
  /** megcsúszás hátralévő ideje (mp); közben a tank irányíthatatlanul sodródik */
  slip: number;
  /** olajos a lánctalp (mp): kipörög – lassabb, nehezen gyorsul és nehezen áll meg */
  oily: number;
  /** a lángszóró üzemanyaga (mp), éppen szórja-e a lángot, és a következő sebzésig hátralévő idő */
  fuel: number;
  flaming: boolean;
  flameTick: number;
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
  /** a kilőtt tank szintje és fajtája: a roncs mérete és kinézete ehhez igazodik */
  level: number;
  look: number;
  /** a főgonosz roncsa nagyobb (ROLE) */
  role?: number;
  /** a kilövés óta eltelt idő (mp) – a füstöléshez */
  age: number;
}

/** A lövedék fajtája: sima, nehéz vagy rakéta. */
export type ShellKind = 'shell' | 'heavy' | 'rocket';
export type ShotKind = ShellKind | 'laser';
/** Ami egy tankot kilőhet: a fő fegyver lövedékei, a géppuska, a telepített löveg, és a robbanások. */
export type KillCause = ShotKind | 'flame' | 'gun' | 'turret' | 'mine' | 'strike' | 'barrel' | 'vehicle';
const BOOM_CAUSE: Record<BoomKind, KillCause> = { mine: 'mine', barrel: 'barrel', shell: 'strike' };

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
  | { type: 'laser'; tank: number; x1: number; y1: number; x2: number; y2: number }
  | { type: 'ricochet'; x: number; y: number }
  /** a lángszóró lángja falat ért: az épület ott lángra kap */
  | { type: 'burn'; x: number; y: number }
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
  | { type: 'hit'; tank: number; by: number; x: number; y: number; absorbed: 'shield' | 'invulnerable' | null; amount: number; light?: boolean }
  /** kilőtt tank; by: akinek a kilövés jár (0: senkinek), cause: mi végzett vele, self: a saját maga okozta robbanás */
  | { type: 'destroyed'; tank: number; by: number; x: number; y: number; cause: KillCause; self?: boolean }
  | { type: 'respawn'; tank: number; x: number; y: number }
  /** a gyorsító túlmelegedett */
  | { type: 'overheat'; tank: number }
  /** szintlépés; gain: hány szintet lépett egyszerre */
  | { type: 'levelup'; tank: number; level: number; gain: number }
  /** a kilőtt tank szintet vesztett (level: az új szintje) */
  | { type: 'leveldown'; tank: number; level: number; lost: number }
  /** a kiegészítő géppuska lövése: nyomjelző a csőtől a célig */
  | { type: 'mg'; tank: number; x1: number; y1: number; x2: number; y2: number }
  /** összedőlt egy épület (index: az épület sorszáma a pályán) */
  | { type: 'collapse'; index: number; x: number; y: number }
  /** a nyitott játékban a ledöntött épület, illetve a kidőlt fa, oszlop idővel újra megjelenik */
  | { type: 'regrow'; what: 'building' | 'prop'; index: number; x: number; y: number }
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
  /** a tank álcázása be-, illetve kikapcsolt */
  | { type: 'cloak'; tank: number; on: boolean }
  /** szupertárgy: seconds mp múlva megjelenik, illetve megjelent a megadott helyen */
  | { type: 'superSoon'; x: number; y: number; seconds: number }
  | { type: 'superHere'; x: number; y: number }
  /** főgonosz: seconds mp múlva megérkezik a megadott helyre; megérkezett; legyőzték (by: a legyőző, helpers: a segítők) */
  | { type: 'bossSoon'; x: number; y: number; seconds: number }
  | { type: 'bossSpawn'; tank: number; x: number; y: number }
  | { type: 'bossDown'; tank: number; by: number; x: number; y: number; helpers: number[] }
  /** riadó: valaki megtámadta a főgonoszt vagy egy testőrét (by: a támadó) */
  | { type: 'bossAlarm'; by: number; x: number; y: number };

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
  /** Véletlen, elég nagy szabad hely egy javítóműhelynek (nem úttesten, nem épületben), ha a pálya tud ilyet adni. */
  workshopSpot?(rnd: () => number, radius: number): { x: number; y: number } | null;
  /** Véletlen hely egy ház fala mellett (gázpalacknak), ha a pálya tud ilyet adni. */
  barrelSpot?(rnd: () => number): { x: number; y: number } | null;
  /** Az épület alaprajza (a visszaépüléshez), illetve az összedőltnek újraállítása. */
  buildingRing?(index: number): readonly number[] | null;
  restoreBuilding?(index: number): boolean;
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
  return { rapid: 0, ricochet: 0, speed: 0, allTerrain: 0, invulnerable: 0, radar: 0, super: 0, gun: 0 };
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
  /** a javítóműhelyek (a meccs alatt nem változnak) */
  readonly workshops: WorkshopState[] = [];
  /** a botok szívóssága és hogy vehetnek-e fel tárgyat, léphetnek-e szintet (a meccs állítja be) */
  botRules: BotRules = botRules();
  /** a főgonosz csapatának támadói: tankazonosító → az utolsó támadás lépésszáma (tick) */
  readonly packThreats = new Map<number, number>();
  /** a bossnak okozott sebzés játékosonként (a segítők jutalmához) */
  readonly bossDamage = new Map<number, number>();
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

  addTank(x: number, y: number, angle: number, options: { team?: number; bot?: boolean; look?: number; role?: number } = {}): TankState {
    const id = this.nextId++;
    const tank: TankState = {
      id,
      // a botok (és akinek nincs megadva) az azonosítójuk szerint kapnak fajtát: a kliens ugyanígy számol
      look: options.look ?? id % TANK_LOOKS,
      role: options.role ?? ROLE.tank,
      bossKills: 0,
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
      shield: 0,
      oil: 0,
      // a botok nem telepítenek löveget
      turrets: options.bot ? 0 : TURRET.base,
      mines: 0,
      smokes: 0,
      strikes: 0,
      streak: 0,
      bestStreak: 0,
      shots: 0,
      hits: 0,
      wrecked: 0,
      dealt: 0,
      taken: 0,
      calm: 0,
      cloak: 0,
      cloakReady: 0,
      botKills: 0,
      botsDown: 0,
      gunCooldown: 0,
      dropCooldown: 0,
      slip: 0,
      oily: 0,
      fuel: 0,
      flaming: false,
      flameTick: 0,
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
      return this.addPickup(pickKind(this.rnd, this.rules.weather === 'rain'), spot.x, spot.y);
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
      this.stepWorkshops(dt);
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
    // a játékos tankja felfelé (a térkép teteje felé) néz, a botoké véletlen irányba
    tank.hullAngle = !tank.bot ? SPAWN_ANGLE : spot ? this.rnd() * Math.PI * 2 : tank.homeAngle;
    tank.turretAngle = tank.hullAngle;
    tank.speed = 0;
    tank.turnSpeed = 0;
    tank.slip = 0;
    tank.oily = 0;
    tank.grip = 0;
    tank.heat = 0;
    tank.overheated = false;
    tank.boosting = false;
    tank.hp = tankMaxHp(tank);
    tank.alive = true;
    tank.effects = noEffects();
    // a felvett fegyver a kilövéssel elveszett: újra az alaplövedék van
    tank.weapon = null;
    tank.fuel = 0;
    tank.flaming = false;
    tank.tripleShots = 0;
    // teljes védelem újraéledés után: semmi nem sebzi (lövés, akna, robbanás, tüzérség, ütközés)
    tank.effects.invulnerable = TANK.spawnShield;
    tank.shield = 0;
    tank.oil = 0;
    // az alap lövegkészlet újra jár (a már lerakott lövegek megmaradnak)
    tank.turrets = tank.bot ? 0 : TURRET.base;
    tank.mines = 0;
    tank.smokes = 0;
    this.events.push({ type: 'respawn', tank: tank.id, x: tank.x, y: tank.y });
  }

  private stepTank(tank: TankState, input: TankInput, dt: number): void {
    const { terrain } = this;
    const fx = tank.effects;
    const radius = tankRadius(tank);
    for (const kind of TIMED_KINDS) if (fx[kind] > 0) fx[kind] = Math.max(0, fx[kind] - dt);
    // álcázás: lejár magától; a következő használatig idő kell
    tank.cloakReady = Math.max(0, tank.cloakReady - dt);
    if (tank.cloak > 0) {
      tank.cloak = Math.max(0, tank.cloak - dt);
      if (tank.cloak === 0) this.events.push({ type: 'cloak', tank: tank.id, on: false });
    }
    // önjavítás: ha egy ideje nem érte sebzés, az életerő nagyon lassan visszatöltődik
    tank.calm += dt;
    const pack = isPack(tank);
    if (tank.calm >= (pack ? BOSS.healDelay : REGEN.delay)) {
      const max = tankMaxHp(tank);
      if (tank.hp < max) tank.hp = Math.min(max, tank.hp + max * (pack ? BOSS.healRate : REGEN.rate) * dt);
    }

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
      // olajos lánctalp: kipörög, mint a jégen – lassabb, nehezen gyorsul és nehezen áll meg
      tank.oily = Math.max(0, tank.oily - dt);
      const greasy = tank.oily > 0;
      const targetSpeed = throttle * (throttle >= 0 ? TANK.maxSpeed : TANK.maxReverse) * boost * ground * (greasy ? OIL.spinSpeed : 1);
      // gyorsítás, ha a cél azonos irányú és nagyobb; különben fékezés
      const speedingUp = targetSpeed * tank.speed >= 0 && Math.abs(targetSpeed) > Math.abs(tank.speed);
      const traction = (muddy ? (speedingUp ? MUD.accel : MUD.brake) : 1) * (greasy ? (speedingUp ? OIL.spinAccel : OIL.spinBrake) : 1);
      // a kipörgő lánctalp gyorsabban forog, mint ahogy a tank halad (a megjelenítéshez)
      if (greasy && throttle !== 0) tank.odometer += throttle * TANK.maxSpeed * 0.9 * dt;
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
    if (tank.weapon === 'flame') this.stepFlame(tank, input.fire === true, dt);
    else {
      tank.flaming = false;
      if (input.fire && tank.cooldown === 0) this.fire(tank);
    }

    tank.dropCooldown = Math.max(0, tank.dropCooldown - dt);
    if (input.drop && tank.oil > 0 && tank.dropCooldown === 0) this.dropOil(tank);
    if (input.deploy && tank.turrets > 0 && tank.dropCooldown === 0) this.deployTurret(tank);
    if (this.rules.mirror) return;
    // kiegészítő géppuska: magától lő (álcázva nem, hogy ne leplezze le a tankot)
    if (fx.gun > 0 && tank.cloak === 0) this.stepGun(tank, dt);
    if (input.cloak && tank.cloakReady === 0) {
      tank.cloak = CLOAK.duration;
      tank.cloakReady = CLOAK.cooldown;
      this.events.push({ type: 'cloak', tank: tank.id, on: true });
    }
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

  /**
   * Visszanövés (nyitott játék): a ledöntött épület, illetve a kidőlt fa, oszlop újra megjelenik –
   * de csak ha nem áll rajta tank, jármű, roncs vagy löveg (senki ne szoruljon bele). Igazat ad, ha megtörtént.
   */
  regrow(what: 'building' | 'prop', index: number): boolean {
    const { terrain } = this;
    // ami a helyét foglalja: tankok, járművek, roncsok, lövegek (középpont és sugár, méterben)
    const blockers: { x: number; y: number; r: number }[] = [];
    for (const t of this.tanks) if (t.alive && !t.out) blockers.push({ x: t.x, y: t.y, r: tankRadius(t) + 1 });
    for (const v of this.vehicles) blockers.push({ x: v.x, y: v.y, r: 4 });
    for (const w of this.wrecks) blockers.push({ x: w.x, y: w.y, r: wreckRadius(w) + 0.5 });
    for (const u of this.turrets) blockers.push({ x: u.x, y: u.y, r: 2 });
    if (what === 'prop') {
      const props = terrain.fellables;
      if (!props || index < 0 || index >= props.count || !props.fallen[index]) return false;
      const x = props.x[index];
      const y = props.y[index];
      if (blockers.some((b) => Math.hypot(b.x - x, b.y - y) < b.r + 2.5)) return false;
      props.restore(index);
      this.events.push({ type: 'regrow', what, index, x, y });
      return true;
    }
    const structures = terrain.structures;
    const ring = terrain.buildingRing?.(index);
    if (!structures || !ring || !structures.collapsed[index] || !terrain.restoreBuilding) return false;
    if (blockers.some((b) => ringBlocks(ring, b.x, b.y, b.r))) return false;
    if (!terrain.restoreBuilding(index)) return false;
    this.events.push({ type: 'regrow', what, index, x: structures.x[index], y: structures.y[index] });
    return true;
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

  /**
   * Lángszóró: amíg a tűzgomb le van nyomva és van üzemanyag, ég a lángcsóva; a sebzés
   * rövid időközönként hat mindenre, ami a kúpjában van és amire a tank rálát.
   */
  private stepFlame(tank: TankState, firing: boolean, dt: number): void {
    if (tank.fuel <= 0) {
      // kifogyott: a tank visszakapja az alapágyút
      tank.fuel = 0;
      tank.flaming = false;
      tank.weapon = null;
      return;
    }
    if (!firing) {
      tank.flaming = false;
      tank.flameTick = 0;
      return;
    }
    // a láng leleplez: az álcázás azonnal megszűnik
    if (tank.cloak > 0 && !this.rules.mirror) {
      tank.cloak = 0;
      this.events.push({ type: 'cloak', tank: tank.id, on: false });
    }
    tank.flaming = true;
    tank.fuel = Math.max(0, tank.fuel - dt);
    // a kliens tükörvilága csak a lángot és az üzemanyagot számolja előre, sebzést nem oszt
    if (this.rules.mirror) return;
    tank.flameTick -= dt;
    if (tank.flameTick > 0) return;
    tank.flameTick += FLAME.pulse;

    const { terrain } = this;
    const angle = tank.turretAngle;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const barrel = TANK.barrelLength * tankSize(tank);
    const mx = tank.x + cos * barrel;
    const my = tank.y + sin * barrel;
    const amount = FLAME.dps * FLAME.pulse;
    const reach = barrel + FLAME.range;

    // épületek: a láng a falnál megáll, a ház ott lángra kap és ég
    const burning = new Set<number>();
    for (const off of [-FLAME.halfAngle, 0, FLAME.halfAngle]) {
      const wall = terrain.walls.raycast(tank.x, tank.y, tank.x + Math.cos(angle + off) * reach, tank.y + Math.sin(angle + off) * reach);
      if (!wall) continue;
      if (wall.owner >= 0) burning.add(wall.owner);
      this.events.push({ type: 'burn', x: wall.x, y: wall.y });
    }
    for (const index of burning) this.damageStructure(index, FLAME.structureDps * FLAME.pulse * damageBoost(tank), false, tank.id);

    /** A lángkúpban van-e a pont (a célpont sugarával együtt), és rálát-e a tank. */
    const inFlame = (x: number, y: number, radius: number): boolean => {
      const dx = x - mx;
      const dy = y - my;
      const dist = Math.hypot(dx, dy);
      if (dist > FLAME.range + radius) return false;
      if (dist > radius) {
        const off = Math.abs(angleDiff(Math.atan2(dy, dx), angle));
        if (off > FLAME.halfAngle + Math.asin(Math.min(1, radius / dist))) return false;
      }
      return !terrain.walls.raycast(tank.x, tank.y, x, y);
    };
    for (const other of this.tanks) {
      if (!other.alive || other.team === tank.team) continue;
      if (inFlame(other.x, other.y, tankRadius(other))) this.damage(other, amount, tank.id, other.x, other.y, 'flame');
    }
    for (const turret of [...this.turrets]) {
      if (turret.team !== tank.team && inFlame(turret.x, turret.y, TURRET.radius)) this.damageTurret(turret, amount * damageBoost(tank));
    }
    for (const v of this.vehicles) {
      if (v.state !== VSTATE.wreck && inFlame(v.x, v.y, VEHICLES[v.kind].half)) this.damageVehicle(v, amount, tank.id);
    }
    // fák, oszlopok, gázpalackok, aknák a csóva mentén: a fa lángra kap és kidől, a palack berobban
    const props = terrain.fellables;
    for (const part of [0.12, 0.3, 0.48, 0.66, 0.83, 0.97]) {
      const d = FLAME.range * part;
      const x = mx + cos * d;
      const y = my + sin * d;
      if (terrain.walls.raycast(tank.x, tank.y, x, y)) break;
      const r = d * Math.tan(FLAME.halfAngle) + 1.3;
      props?.forEachTouching(x, y, r, (i) => {
        this.fell(i, Math.atan2(props.y[i] - tank.y, props.x[i] - tank.x));
      });
      this.igniteNear(x, y, r, tank.id);
    }
  }

  private fire(tank: TankState): void {
    const { terrain } = this;
    const fx = tank.effects;
    const laser = tank.weapon === 'laser';
    const rocket = tank.weapon === 'rocket';
    const kind: ShellKind = rocket ? 'rocket' : tank.weapon === 'heavy' ? 'heavy' : 'shell';
    // a lövés leleplez: az álcázás azonnal megszűnik
    if (tank.cloak > 0 && !this.rules.mirror) {
      tank.cloak = 0;
      this.events.push({ type: 'cloak', tank: tank.id, on: false });
    }
    tank.cooldown = tank.role === ROLE.boss ? BOSS.fireInterval : TANK.fireCooldown * (fx.rapid > 0 ? BOOST.rapidCooldown : 1) * (laser ? LASER.cooldown : rocket ? ROCKET.cooldown : 1);

    const barrel = TANK.barrelLength * tankSize(tank);
    const mx = tank.x + Math.cos(tank.turretAngle) * barrel;
    const my = tank.y + Math.sin(tank.turretAngle) * barrel;
    this.events.push({ type: 'shot', tank: tank.id, kind: laser ? 'laser' : kind, x: mx, y: my, angle: tank.turretAngle });
    // ha a cső vége falban van, a lövés azonnal becsapódik
    const blocked = terrain.walls.raycast(tank.x, tank.y, mx, my);
    if (blocked) {
      this.events.push({ type: 'impact', kind: laser ? 'laser' : kind, x: blocked.x, y: blocked.y });
      this.damageStructure(blocked.owner, DAMAGE[laser ? 'laser' : kind] * STRUCTURE_MULT[laser ? 'laser' : kind] * damageBoost(tank), false, tank.id);
      if (kind === 'rocket' && !laser) this.blastStructures(blocked.x, blocked.y, ROCKET_BLAST.radius, ROCKET_BLAST.damage * damageBoost(tank), tank.id, blocked.owner);
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
        bounces: tank.effects.ricochet > 0 && !rocket ? BOOST.ricochetBounces : 0,
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
    this.events.push({ type: 'laser', tank: tank.id, x1: mx, y1: my, x2: ex, y2: ey });
    // a legközelebbi találat számít: a keresés sorrendje miatt mindig a később talált van közelebb
    if (prop) this.fell(prop.index, Math.atan2(sin, cos));
    else if (target) {
      tank.hits++;
      this.damage(target.tank, DAMAGE.laser, tank.id, ex, ey, 'laser');
    } else if (barrel) this.igniteBarrel(barrel.barrel, tank.id, 0);
    else if (turret) this.damageTurret(turret.turret, DAMAGE.laser * damageBoost(tank));
    else if (vehicle) this.damageVehicle(vehicle.vehicle, DAMAGE.laser * damageBoost(tank), tank.id);
    else if (wall && wreckT < 0) this.damageStructure(wall.owner, DAMAGE.laser * STRUCTURE_MULT.laser * damageBoost(tank), false, tank.id);
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

  /**
   * A kiegészítő géppuska: a legközelebbi ellenséges tankra (ha nincs, ágyúra) lő,
   * amelyre rálát. Azonnal célba ér; a lövés nyomjelzőjét esemény viszi.
   */
  private stepGun(tank: TankState, dt: number): void {
    tank.gunCooldown = Math.max(0, tank.gunCooldown - dt);
    if (tank.gunCooldown > 0) return;
    const { walls } = this.terrain;
    let target: { x: number; y: number } | null = null;
    let enemy: TankState | null = null;
    let post: TurretState | null = null;
    let best: number = MG.range;
    for (const other of this.tanks) {
      if (!other.alive || other.team === tank.team || isPack(other)) continue;
      const dist = Math.hypot(other.x - tank.x, other.y - tank.y);
      if (dist >= best) continue;
      if (other.cloak > 0 && dist > CLOAK.botSight) continue;
      if (dist > 9 && this.inSmoke(other.x, other.y)) continue;
      if (walls.raycast(tank.x, tank.y, other.x, other.y)) continue;
      best = dist;
      target = other;
      enemy = other;
    }
    if (!enemy) {
      for (const other of this.turrets) {
        if (other.team === tank.team) continue;
        const dist = Math.hypot(other.x - tank.x, other.y - tank.y);
        if (dist >= best || walls.raycast(tank.x, tank.y, other.x, other.y)) continue;
        best = dist;
        target = other;
        post = other;
      }
    }
    if (!target) return;
    tank.gunCooldown = MG.interval;
    // a géppuska a tank jobb oldalán ül; a csöve a cél felé néz
    const size = tankSize(tank);
    const sx = tank.x + Math.cos(tank.hullAngle + Math.PI / 2) * MG.side * size;
    const sy = tank.y + Math.sin(tank.hullAngle + Math.PI / 2) * MG.side * size;
    const aim = Math.atan2(target.y - sy, target.x - sx);
    // a találat helye kicsit szór a célon
    const hx = target.x + (this.rnd() - 0.5) * 1.6;
    const hy = target.y + (this.rnd() - 0.5) * 1.6;
    this.events.push({ type: 'mg', tank: tank.id, x1: sx + Math.cos(aim) * MG.barrel * size, y1: sy + Math.sin(aim) * MG.barrel * size, x2: hx, y2: hy });
    if (enemy) this.damage(enemy, MG.damage, tank.id, hx, hy, 'gun', true);
    else if (post) this.damageTurret(post, MG.damage * damageBoost(tank));
  }

  /**
   * Sebzés: a sebezhetetlenség és a pajzs felfogja, különben fogy az életerő.
   * `light`: apró, sorozatos találat (géppuska) – a megjelenítő visszafogottabban jelzi.
   */
  private damage(tank: TankState, amount: number, by: number, x: number, y: number, cause: KillCause, light = false, self = false): void {
    if (!tank.alive) return;
    if (tank.effects.invulnerable > 0) {
      this.events.push({ type: 'hit', tank: tank.id, by, x, y, absorbed: 'invulnerable', amount: 0, ...(light ? { light } : {}) });
      return;
    }
    // a pajzs egy töltete egy komoly találatot fog fel; a géppuska apró lövései nem fogyasztják, de át sem jutnak rajta
    if (tank.shield > 0 && light) {
      this.events.push({ type: 'hit', tank: tank.id, by, x, y, absorbed: 'shield', amount: 0, light });
      return;
    }
    if (tank.shield > 0) {
      tank.shield--;
      this.events.push({ type: 'hit', tank: tank.id, by, x, y, absorbed: 'shield', amount: 0 });
      return;
    }
    // a támadó szintje növeli a sebzést; a bot gyengébben lő, és a páncélja is gyengébb
    const attacker = this.tank(by);
    const packAttacker = attacker !== undefined && isPack(attacker);
    const dealt =
      amount *
      (attacker ? damageBoost(attacker) : 1) *
      (attacker?.bot && !packAttacker && !tank.bot ? this.botRules.damage : 1) *
      (attacker?.role === ROLE.guard ? BOSS.guardDamage : 1) *
      (tank.bot && !isPack(tank) ? this.botRules.armor : 1);
    // a főgonosz csapatát megtámadták: a támadót megjegyzik (riadó), a bossnak okozott sebzést számolják
    if (isPack(tank) && attacker && attacker !== tank && !packAttacker) {
      if (!this.packThreats.has(attacker.id) || this.tick - (this.packThreats.get(attacker.id) ?? 0) > 60) this.events.push({ type: 'bossAlarm', by: attacker.id, x: tank.x, y: tank.y });
      this.packThreats.set(attacker.id, this.tick);
      if (tank.role === ROLE.boss && !attacker.bot) this.bossDamage.set(attacker.id, (this.bossDamage.get(attacker.id) ?? 0) + Math.min(dealt, tank.hp));
    }
    // a statisztikába csak a ténylegesen elvett életerő számít (a túllövés nem)
    const real = Math.min(dealt, tank.hp);
    tank.taken += real;
    if (attacker && attacker !== tank) attacker.dealt += real;
    tank.hp -= dealt;
    tank.calm = 0;
    this.events.push({ type: 'hit', tank: tank.id, by, x, y, absorbed: null, amount: Math.round(dealt), ...(light ? { light } : {}) });
    if (tank.hp > 0) return;
    tank.hp = 0;
    tank.alive = false;
    tank.respawn = TANK.respawnDelay;
    tank.speed = 0;
    tank.deaths++;
    tank.streak = 0;
    tank.cloak = 0;
    if (tank.lives > 0 && --tank.lives === 0) {
      tank.out = true;
      this.events.push({ type: 'eliminated', tank: tank.id, by });
    }
    // a főgonosz és a testőrei nem élednek újra
    if (isPack(tank)) tank.out = true;
    // a roncs akkora, amekkora a tank a kilövésekor volt; a győztes jutalma is ehhez a szinthez igazodik
    const victimLevel = tank.level;
    this.wrecks.push({ id: this.nextId++, x: tank.x, y: tank.y, hullAngle: tank.hullAngle, turretAngle: tank.turretAngle, team: tank.team, level: victimLevel, look: tank.look, age: 0, ...(tank.role ? { role: tank.role } : {}) });
    // a kilőtt tank szintet veszít (a botok nem fejlődnek, nekik nincs mit veszteniük; a főgonosz csapata nem éled újra)
    const lost = isPack(tank) ? 0 : Math.min(LEVEL.deathLoss, tank.level - 1);
    if (lost > 0) {
      tank.level -= lost;
      this.events.push({ type: 'leveldown', tank: tank.id, level: tank.level, lost });
    }
    if (this.wrecks.length > WRECK.max) this.wrecks.shift();
    if (attacker && attacker !== tank) {
      // kilövésnek csak az ellenséges játékos számít; a kilőtt bot külön statisztika
      if (tank.bot) attacker.botsDown++;
      else attacker.kills++;
      attacker.streak++;
      attacker.bestStreak = Math.max(attacker.bestStreak, attacker.streak);
      // kilövéssorozatért tüzérségi csapás jár (csak a játékosoknak)
      if (!attacker.bot && attacker.streak % STRIKE.every === 0) {
        attacker.strikes = Math.min(STRIKE.max, attacker.strikes + 1);
        this.events.push({ type: 'streak', tank: attacker.id, streak: attacker.streak, strikes: attacker.strikes });
      }
      // a játékosok tankja fejlődik; a botoké csak a két legügyesebb szinten
      if (!attacker.bot || this.botRules.perks) {
        let gain = 0;
        if (tank.role === ROLE.boss) {
          // a főgonosz legyőzése: nagy ugrás
          attacker.bossKills++;
          gain = BOSS.reward;
        } else if (tank.bot) {
          // botokból több kell egy szinthez
          if (++attacker.botKills >= LEVEL.botKills) {
            attacker.botKills = 0;
            gain = 1;
          }
        } else {
          // játékos kilövése: egy szint, magasabb szintű ellenfélért több
          gain = killGain(attacker.level, victimLevel);
        }
        gain = Math.min(gain, LEVEL.max - attacker.level);
        if (gain > 0) {
          // szintlépés: a többlet életerőt azonnal megkapja
          attacker.level += gain;
          attacker.hp = Math.min(tankMaxHp(attacker), attacker.hp + LEVEL.hp * gain);
          this.events.push({ type: 'levelup', tank: attacker.id, level: attacker.level, gain });
        }
      }
    }
    this.events.push({ type: 'destroyed', tank: tank.id, by, x: tank.x, y: tank.y, cause, ...(self ? { self } : {}) });
    if (tank.role === ROLE.boss) this.bossDefeated(tank, attacker && attacker !== tank ? attacker : undefined);
  }

  /**
   * A főgonosz legyőzése: a legyőző a jutalmát már megkapta (damage); aki legalább a boss
   * életerejének BOSS.helperShare részét lebontotta, BOSS.helperReward szintet lép.
   */
  private bossDefeated(boss: TankState, killer: TankState | undefined): void {
    const helpers: number[] = [];
    const share = tankMaxHp(boss) * BOSS.helperShare;
    for (const [id, dealt] of this.bossDamage) {
      if (dealt < share || id === killer?.id) continue;
      const helper = this.tank(id);
      if (!helper || helper.out) continue;
      helpers.push(id);
      const gain = Math.min(BOSS.helperReward, LEVEL.max - helper.level);
      if (gain <= 0) continue;
      helper.level += gain;
      helper.hp = Math.min(tankMaxHp(helper), helper.hp + LEVEL.hp * gain);
      this.events.push({ type: 'levelup', tank: helper.id, level: helper.level, gain });
    }
    this.bossDamage.clear();
    this.events.push({ type: 'bossDown', tank: boss.id, by: killer?.id ?? 0, x: boss.x, y: boss.y, helpers });
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
      if (dist <= radius) this.damage(tank, falloff(Math.max(0, dist)), tank.id === v.by ? 0 : v.by, v.x, v.y, 'vehicle', false, tank.id === v.by);
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
    this.turrets.push({ id: this.nextId++, owner: tank.id, team: tank.team, x: spot.x, y: spot.y, angle: tank.turretAngle, hp: turretMaxHp(tank.level), level: tank.level, cooldown: turretInterval(tank.level), target: -1 });
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
      // a löveg a gazdája szintjét követi: szintlépéskor a többlet életerőt megkapja, szintvesztéskor a határa csökken
      if (owner.level !== turret.level) {
        const gain = turretMaxHp(owner.level) - turretMaxHp(turret.level);
        turret.hp = Math.min(turretMaxHp(owner.level), turret.hp + Math.max(0, gain));
        turret.level = owner.level;
      }
      turret.cooldown = Math.max(0, turret.cooldown - dt);
      // célpont: a legközelebbi ellenséges tank, amelyre rálát (néhány lépésenként keresi újra)
      if ((this.tick + turret.id) % TURRET.scanEvery === 0) {
        let best: number = turretRange(turret.level);
        turret.target = -1;
        for (const other of this.tanks) {
          if (!other.alive || other.team === turret.team || isPack(other)) continue;
          const dist = Math.hypot(other.x - turret.x, other.y - turret.y);
          if (dist >= best || walls.raycast(turret.x, turret.y, other.x, other.y)) continue;
          if (dist > 9 && this.inSmoke(other.x, other.y)) continue; // a füstbe nem lát be
          if (other.cloak > 0 && dist > CLOAK.botSight) continue; // az álcázott tankot csak közelről veszi észre
          best = dist;
          turret.target = other.id;
        }
      }
      const target = turret.target >= 0 ? this.tank(turret.target) : undefined;
      if (!target || !target.alive) continue;
      const aim = Math.atan2(target.y - turret.y, target.x - turret.x);
      turret.angle = rotateToward(turret.angle, aim, TURRET.turnRate * dt);
      if (turret.cooldown > 0 || Math.abs(angleDiff(aim, turret.angle)) > 0.05) continue;
      turret.cooldown = turretInterval(turret.level);
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
    for (const s of this.smokes) if (insideSmoke(s, x, y)) return true;
    return false;
  }

  /** Javítóműhelyek kisorsolása a pályán: egymástól távol, szabad helyre. */
  scatterWorkshops(count: number): void {
    const spotOf = this.terrain.workshopSpot?.bind(this.terrain);
    if (!spotOf) return;
    // a hely a csarnok sarkainak is kell: a befoglaló kör sugara
    const reach = Math.hypot(WORKSHOP.width, WORKSHOP.height) / 2;
    for (const gap of [WORKSHOP.gap, WORKSHOP.gap / 2, 0]) {
      for (let attempt = 0; attempt < count * 150 && this.workshops.length < count; attempt++) {
        const spot = spotOf(this.rnd, reach);
        if (!spot) continue;
        if (this.workshops.some((w) => Math.hypot(w.x - spot.x, w.y - spot.y) < Math.max(gap, reach * 2.2))) continue;
        this.workshops.push({ id: this.nextId++, x: spot.x, y: spot.y });
      }
    }
  }

  /** A műhelyben álló tank életereje töltődik (a kilőtté nem). */
  private stepWorkshops(dt: number): void {
    if (this.workshops.length === 0) return;
    for (const tank of this.tanks) {
      if (!tank.alive) continue;
      const max = tankMaxHp(tank);
      if (tank.hp >= max) continue;
      for (const shop of this.workshops) {
        const dx = tank.x - shop.x;
        const dy = tank.y - shop.y;
        if (dx * dx + dy * dy > WORKSHOP.radius * WORKSHOP.radius) continue;
        tank.hp = Math.min(max, tank.hp + max * WORKSHOP.rate * dt);
        break;
      }
    }
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
      if (dist <= radius) this.damage(tank, falloff(dist), tank.id === by ? 0 : by, x, y, BOOM_CAUSE[kind], false, tank.id === by);
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
    this.blastStructures(x, y, STRIKE.blastRadius * 0.75, STRIKE.structureDamage, by);
  }

  /** Robbanás: a `reach` méteren belül álló épületek sérülnek (`except`: amelyiket a találat már sebezte). */
  private blastStructures(x: number, y: number, reach: number, amount: number, by: number, except = -1): void {
    const hit = new Set<number>();
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const wall = this.terrain.walls.raycast(x, y, x + Math.cos(a) * reach, y + Math.sin(a) * reach);
      if (wall && wall.owner >= 0 && wall.owner !== except) hit.add(wall.owner);
    }
    for (const index of hit) this.damageStructure(index, amount, false, by);
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
        // egyenletes elosztás („napraforgó” minta): a k. lövedék a kör k. egyforma területű sávjába esik,
        // kis véletlen eltolással; a sorrend összekevert, hogy ne körben haladva hulljanak
        const k = ((STRIKE.shells - strike.shells) * 7) % STRIKE.shells;
        strike.shells--;
        strike.next += STRIKE.interval;
        const ring = Math.sqrt((k + 0.5 + (this.rnd() - 0.5) * 0.6) / STRIKE.shells);
        const angle = k * 2.399963 + strike.id * 1.3 + (this.rnd() - 0.5) * 0.35;
        const dist = Math.min(1, Math.max(0, ring)) * STRIKE.spread;
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
      this.damage(direct, DAMAGE[b.kind], b.owner, x, y, b.auto ? 'turret' : b.kind);
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
      if (Math.hypot(other.x - x, other.y - y) <= DAMAGE.splashRadius) this.damage(other, DAMAGE.splash, b.owner, x, y, 'rocket');
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
        const owner = this.tank(b.owner);
        const boost = owner ? damageBoost(owner) : 1;
        if (wall.owner >= 0) this.damageStructure(wall.owner, DAMAGE[b.kind] * STRUCTURE_MULT[b.kind] * boost, false, b.owner);
        // a rakéta robbanása a szomszédos házakat is rombolja
        if (b.kind === 'rocket') this.blastStructures(wall.x, wall.y, ROCKET_BLAST.radius, ROCKET_BLAST.damage * boost, b.owner, wall.owner);
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
      // a botok (a két legügyesebb szint kivételével) nem vesznek fel tárgyat: áthajtanak rajta, és az ott marad
      if (!tank.alive || (tank.bot && !this.botRules.perks)) continue;
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
    else if (kind === 'flame') {
      // lángszóró: az üzemanyag összeadódik, ha már az van a tanknál
      tank.fuel = Math.min(FLAME.maxFuel, (tank.weapon === 'flame' ? tank.fuel : 0) + FLAME.fuel);
      tank.weapon = 'flame';
    } else if (isWeapon(kind)) tank.weapon = kind; // az előző fegyver helyére lép
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
        if (dist > OIL.radius) continue;
        // a jó tapadás (terepjáró lánctalp) és a sebezhetetlenség megvéd
        if (tank.effects.allTerrain > 0 || tank.effects.invulnerable > 0) continue;
        // aki belehajt (akár lassan), annak olajos lesz a lánctalpa: a folt után is kipörög még egy ideig
        // megcsúszni csak a ráhajtáskor csúszik meg: akinek már olajos a lánctalpa, az a folton csak kipörög
        const fresh = tank.oily === 0;
        tank.oily = OIL.spinTime;
        if (!fresh || tank.slip > 0 || Math.abs(tank.speed) < OIL.minSpeed) continue;
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
