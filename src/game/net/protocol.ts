// A kliens és a szerver közötti üzenetek. Minden üzenet JSON, a `t` mező a
// típusa. A protokoll verziózott: a szerver az eltérő verziójú klienst elutasítja.
//
// Elv: a kliens csak BEMENETET küld (TankInput), a szerver számol mindent, és
// állapot-pillanatképeket (snap) meg eseményeket (ev) küld vissza.

import { PICKUP_KINDS, TIMED_KINDS } from '../sim/pickups';
import type { MatchPlan, MatchSettings } from '../sim/match';
import type { BarrelState, MineState, SmokeState } from '../sim/gadgets';
import { VEHICLE_KINDS, type TurretState, type VehicleState } from '../sim/vehicles';
import type { BulletState, OilState, PickupState, ShellKind, SimEvent, TankInput, TankState, WreckState } from '../sim/world';

export const PROTOCOL_VERSION = 10;
/** a szimuláció ennyi lépésenként küld pillanatképet (60 Hz / 3 = 20 Hz) */
export const SNAPSHOT_EVERY = 3;

export type RoomStatus = 'waiting' | 'starting' | 'playing';

export interface RoomInfo {
  id: string;
  /** a szoba létrehozójának neve */
  host: string;
  /** a bent lévő játékosok nevei */
  players: string[];
  status: RoomStatus;
  /** privát játék: a belépéshez kód kell (magát a kódot a lista nem tartalmazza) */
  locked: boolean;
  settings: MatchSettings;
  plan: MatchPlan;
}

/** Szöveges üzenet: az előszobában mindenkinek, szobában és meccsen a szobatársaknak megy. */
export const CHAT = {
  /** egy üzenet legnagyobb hossza (karakter) */
  maxLength: 200,
  /** ennyi üzenet küldhető ennyi ezredmásodperc (window) alatt; fölötte a szerver eldobja */
  burst: 5,
  window: 8000,
  /** az előszoba ennyi utolsó üzenetét kapja meg, aki belép */
  history: 30,
} as const;

/** Az üzenet szövegének megtisztítása: vezérlőkarakterek és HTML-jelek nélkül, levágva. */
export function cleanChat(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT.maxLength) : '';
}

/**
 * Hang (adóvevő): a beszélő a gomb nyomva tartása alatt rövid hangdarabokat küld,
 * a szerver továbbadja a szobatársaknak. Egy darab: 8 bites μ-law minták
 * base64-ben, `rate` mintavétellel.
 */
export const VOICE = {
  /** mintavétel (Hz) és egy darab hossza (minta) – 50 ezredmásodperc */
  rate: 12000,
  frame: 600,
  /** egy darab legnagyobb mérete base64-ben (karakter) */
  maxChars: 1400,
  /** egy beszélőtől másodpercenként legfeljebb ennyi darab megy tovább */
  maxPerSecond: 30,
  /** egy szobában egyszerre ennyien beszélhetnek; a többiek hangja addig nem megy át */
  speakers: 3,
  /** ennyi szünet után a beszélő már nem számít beszélőnek (ms) */
  quiet: 400,
} as const;

/** A privát játék belépőkódjának hossza. */
export const ROOM_CODE = { min: 3, max: 16 } as const;

/** A belépőkód egységes alakja: szóközök nélkül, a kis- és nagybetű nem számít. */
export function cleanCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, '').toLowerCase().slice(0, ROOM_CODE.max) : '';
}

/** Egy bejelentkezett játékos: a neve és hogy éppen hol van. */
export interface OnlinePlayer {
  name: string;
  where: 'lobby' | 'room' | 'game';
}

export interface PlayerInfo {
  id: string;
  name: string;
  tank: number;
}

export interface Standing {
  id: string;
  name: string;
  place: number;
  kills: number;
  deaths: number;
  level: number;
  /** a leghosszabb kilövéssorozat, a ledöntött épületek száma, a pontosság százalékban (−1: nem lőtt) */
  streak: number;
  wrecked: number;
  accuracy: number;
}

/**
 * [gáz, forgatás, célzás (rad) vagy null, jelzők: 1 = tűz, 2 = olaj, 4 = gyorsító, 8 = ágyú telepítése,
 * 16 = akna, 32 = füst, 64 = álcázás; ha tüzérségi csapást kér: a célpont x, y koordinátája]
 */
export type PackedInput = [number, number, number | null, number, number?, number?];

export type ClientMessage =
  // belépés: regisztráció, név + jelszó, vagy a böngészőben megőrzött kulcs
  | { t: 'register'; v: number; name: string; password: string }
  | { t: 'login'; v: number; name: string; password: string }
  | { t: 'resume'; v: number; token: string }
  | { t: 'logout' }
  /** a szerver kapuja küldi a szobakezelőnek a sikeres belépés után (a kliensé nem jut el odáig) */
  | { t: 'hello'; v: number; name: string }
  /** code: ha meg van adva, a játék privát – csak ezzel a kóddal lehet belépni */
  | { t: 'create'; settings: Partial<MatchSettings>; code?: string }
  | { t: 'join'; room: string; code?: string }
  | { t: 'leave' }
  /** s: a bemenet sorszáma (a szerver ezzel nyugtáz) */
  | { t: 'input'; s: number; i: PackedInput }
  /** szöveges üzenet: az előszobában mindenkinek, szobában a szobatársaknak */
  | { t: 'chat'; text: string }
  /** hangdarab a szobatársaknak (lásd VOICE) */
  | { t: 'voice'; d: string }
  | { t: 'ping'; c: number };

/** a saját (vagy a nézett) tank teljes állapota */
export type MeState = TankState;

/**
 * A pillanatkép KÜLÖNBSÉGI: a szerver csak azt küldi el, ami az előző, ugyanennek
 * a kliensnek küldött pillanatkép óta megváltozott. A kapcsolat megbízható és
 * sorrendtartó (WebSocket), így a kliens a hiányzó mezőket az előző állapotából
 * tudja (lásd mergeSnapshot). Mindig megy: a lépésszám, a nyugta, a tankok.
 * Csak változáskor megy: a saját tank egyes mezői, és a ritkán változó listák
 * (tárgyak, foltok, roncsok, aknák, palackok, lövegek, állás…).
 */

/** [id, x, y, test szöge, torony szöge, sebesség, életerő, szint, jelzők, csapat, megtett út] */
export type PackedTank = number[];
export const TANK_FLAG = { alive: 1, bot: 2, boosting: 4, invulnerable: 8, shield: 16, out: 32, super: 64, cloak: 128, gun: 256 } as const;

export interface Snapshot {
  t: 'snap';
  /** a szimuláció lépésszáma */
  k: number;
  /** az utolsó feldolgozott bemenet sorszáma */
  a: number;
  /** a saját tank megváltozott mezői (null: már nincs tankja; hiányzik: semmi nem változott) */
  me?: Partial<MeState> | null;
  /** annak a tanknak az azonosítója, amelyet a kamera követ (kiesés után egy másik játékosé) */
  v: number;
  T: PackedTank[];
  /** lövedékek: [id, fajta (0 sima, 1 nehéz, 2 rakéta), x, y, vx, vy, a kilövő tank] */
  B?: number[][];
  /** tárgyak: [id, fajta sorszáma, x, y] */
  P?: number[][];
  /** olajfoltok: [id, x, y] */
  O?: number[][];
  /** roncsok: [id, x, y, test szöge, torony szöge, kor, szint] */
  W?: number[][];
  /** civil járművek: [id, fajta, megjelenés, x, y, szög, sebesség, állapot] */
  V?: number[][];
  /** telepített lövegek: [id, lerakó tank, csapat, x, y, szög, életerő, szint] */
  U?: number[][];
  /** aknák: [id, lerakó tank, csapat, x, y]; füstfelhők: [id, x, y, hátralévő idő]; gázpalackok: [id, x, y] */
  M?: number[][];
  K?: number[][];
  G?: number[][];
  /** játékosok állása: [tank, kilövések, halálok, kilépett-e] */
  S?: number[][];
  /** a hátralévő játékidő (mp) */
  r: number;
}

export type ServerMessage =
  /** sikeres belépés: a fiók neve és a belépve maradás kulcsa */
  | { t: 'auth'; name: string; token: string }
  | { t: 'authError'; message: string }
  | { t: 'welcome'; id: string; map: { width: number; height: number } }
  | { t: 'rooms'; rooms: RoomInfo[] }
  /** a szoba állapota, amíg a játékos a váróban van; countdown: az indulásig hátralévő mp */
  | { t: 'room'; room: RoomInfo; you: string; countdown: number; code?: string }
  | { t: 'left'; reason: string }
  | { t: 'error'; message: string }
  /** workshops: a javítóműhelyek helye, [x, y] párok (a meccs alatt nem változnak) */
  | { t: 'start'; room: RoomInfo; tank: number; players: PlayerInfo[]; workshops: number[][] }
  | Snapshot
  | { t: 'ev'; e: SimEvent[] }
  | { t: 'over'; winner: string | null; standings: Standing[] }
  /** a bejelentkezett játékosok és hogy hol vannak: előszobában, váróban vagy meccsen */
  | { t: 'online'; players: OnlinePlayer[] }
  /** szöveges üzenet; scope: az előszobából vagy a szobából (meccsről) jött-e; me: a sajátunk */
  | { t: 'chat'; from: string; text: string; scope: 'lobby' | 'room'; me?: boolean }
  /** az előszoba utolsó üzenetei (belépéskor) */
  | { t: 'chatHistory'; lines: { from: string; text: string }[] }
  /** egy szobatárs hangdarabja */
  | { t: 'voice'; from: string; d: string }
  | { t: 'pong'; c: number };

// --- tömörítés ------------------------------------------------------------------

export function packInput(input: TankInput): PackedInput {
  const flags = (input.fire ? 1 : 0) | (input.drop ? 2 : 0) | (input.boost ? 4 : 0) | (input.deploy ? 8 : 0) | (input.mine ? 16 : 0) | (input.smoke ? 32 : 0) | (input.cloak ? 64 : 0);
  const packed: PackedInput = [input.throttle, input.turn, input.aim === null ? null : Math.round(input.aim * 1000) / 1000, flags];
  if (input.strike) packed.push(Math.round(input.strike.x * 10) / 10, Math.round(input.strike.y * 10) / 10);
  return packed;
}

export function unpackInput(packed: unknown): TankInput | null {
  if (!Array.isArray(packed) || packed.length < 4) return null;
  const [throttle, turn, aim, flags, sx, sy] = packed as unknown[];
  if (typeof throttle !== 'number' || typeof turn !== 'number' || typeof flags !== 'number') return null;
  if (!Number.isFinite(throttle) || !Number.isFinite(turn)) return null;
  return {
    throttle: Math.max(-1, Math.min(1, throttle)),
    turn: Math.max(-1, Math.min(1, turn)),
    aim: typeof aim === 'number' && Number.isFinite(aim) ? aim : null,
    fire: (flags & 1) !== 0,
    drop: (flags & 2) !== 0,
    boost: (flags & 4) !== 0,
    deploy: (flags & 8) !== 0,
    mine: (flags & 16) !== 0,
    smoke: (flags & 32) !== 0,
    cloak: (flags & 64) !== 0,
    strike: typeof sx === 'number' && typeof sy === 'number' && Number.isFinite(sx) && Number.isFinite(sy) ? { x: sx, y: sy } : null,
  };
}

export function packTank(t: TankState): PackedTank {
  const flags =
    (t.alive ? TANK_FLAG.alive : 0) |
    (t.bot ? TANK_FLAG.bot : 0) |
    (t.boosting ? TANK_FLAG.boosting : 0) |
    (t.effects.invulnerable > 0 ? TANK_FLAG.invulnerable : 0) |
    (t.shield > 0 ? TANK_FLAG.shield : 0) |
    (t.out ? TANK_FLAG.out : 0) |
    (t.effects.super > 0 ? TANK_FLAG.super : 0) |
    (t.cloak > 0 ? TANK_FLAG.cloak : 0) |
    (t.effects.gun > 0 ? TANK_FLAG.gun : 0);
  // a többi tanknál a sebesség, az életerő és a megtett út csak a megjelenítéshez kell: kevesebb tizedessel megy
  return [t.id, t.x, t.y, t.hullAngle, t.turretAngle, Math.round(t.speed * 10) / 10, Math.round(t.hp), t.level, flags, t.team, Math.round(t.odometer * 10) / 10];
}

/** Üres tankállapot a kliens tükörvilágához (a pillanatkép tölti ki). */
export function blankTank(id: number): TankState {
  return {
    id,
    team: 0,
    bot: false,
    x: 0,
    y: 0,
    hullAngle: 0,
    turretAngle: 0,
    turnSpeed: 0,
    speed: 0,
    cooldown: 0,
    odometer: 0,
    hp: 100,
    alive: true,
    respawn: 0,
    kills: 0,
    deaths: 0,
    level: 1,
    lives: -1,
    out: false,
    grip: 0,
    homeX: 0,
    homeY: 0,
    homeAngle: 0,
    effects: { rapid: 0, speed: 0, allTerrain: 0, invulnerable: 0, radar: 0, super: 0, gun: 0 },
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
    calm: 0,
    cloak: 0,
    cloakReady: 0,
    botKills: 0,
    gunCooldown: 0,
    dropCooldown: 0,
    slip: 0,
    slideAngle: 0,
    spin: 0,
    heat: 0,
    overheated: false,
    boosting: false,
  };
}

export function unpackTank(p: PackedTank, into: TankState): TankState {
  const flags = p[8];
  into.x = p[1];
  into.y = p[2];
  into.hullAngle = p[3];
  into.turretAngle = p[4];
  into.speed = p[5];
  into.hp = p[6];
  into.level = p[7];
  into.alive = (flags & TANK_FLAG.alive) !== 0;
  into.bot = (flags & TANK_FLAG.bot) !== 0;
  into.boosting = (flags & TANK_FLAG.boosting) !== 0;
  into.effects.invulnerable = flags & TANK_FLAG.invulnerable ? 1 : 0;
  into.shield = flags & TANK_FLAG.shield ? 1 : 0;
  into.effects.super = flags & TANK_FLAG.super ? 1 : 0;
  into.cloak = flags & TANK_FLAG.cloak ? 1 : 0;
  into.effects.gun = flags & TANK_FLAG.gun ? 1 : 0;
  into.out = (flags & TANK_FLAG.out) !== 0;
  into.team = p[9];
  into.odometer = p[10];
  return into;
}

const SHELLS: ShellKind[] = ['shell', 'heavy', 'rocket'];
export const packBullet = (b: BulletState): number[] => [b.id, SHELLS.indexOf(b.kind), b.x, b.y, b.vx, b.vy, b.owner];
export const unpackBullet = (p: number[]): BulletState => ({ id: p[0], owner: p[6] ?? 0, team: 0, kind: SHELLS[p[1]] ?? 'shell', x: p[2], y: p[3], vx: p[4], vy: p[5], life: 1, bounces: 0 });
export const packPickup = (p: PickupState): number[] => [p.id, PICKUP_KINDS.indexOf(p.kind), p.x, p.y];
export const unpackPickup = (p: number[]): PickupState => ({ id: p[0], kind: PICKUP_KINDS[p[1]] ?? 'repair', x: p[2], y: p[3] });
export const packOil = (o: OilState): number[] => [o.id, o.x, o.y];
export const unpackOil = (p: number[]): OilState => ({ id: p[0], owner: 0, x: p[1], y: p[2], life: 10, ownerSafe: false });
// a roncs kora csak a füstöléshez kell: öt másodperces lépésekben megy, hogy a lista ritkán változzon
export const packWreck = (w: WreckState): number[] => [w.id, w.x, w.y, w.hullAngle, w.turretAngle, Math.min(30, Math.floor(w.age / 5) * 5), w.level];
export const unpackWreck = (p: number[]): WreckState => ({ id: p[0], x: p[1], y: p[2], hullAngle: p[3], turretAngle: p[4], team: 0, level: p[6] ?? 1, age: p[5] });

export const packVehicle = (v: VehicleState): number[] => [v.id, VEHICLE_KINDS.indexOf(v.kind), v.look, v.x, v.y, v.angle, v.speed, v.state];
export const unpackVehicle = (p: number[]): VehicleState => ({ id: p[0], kind: VEHICLE_KINDS[p[1]] ?? 'car', look: p[2], x: p[3], y: p[4], angle: p[5], speed: p[6], hp: 1, state: p[7], timer: 0, by: 0 });
export const packTurret = (t: TurretState): number[] => [t.id, t.owner, t.team, t.x, t.y, t.angle, t.hp, t.level];
export const unpackTurret = (p: number[]): TurretState => ({ id: p[0], owner: p[1], team: p[2], x: p[3], y: p[4], angle: p[5], hp: p[6], level: p[7] ?? 1, cooldown: 0, target: -1 });

export const packMine = (m: MineState): number[] => [m.id, m.owner, m.team, m.x, m.y];
export const unpackMine = (p: number[]): MineState => ({ id: p[0], owner: p[1], team: p[2], x: p[3], y: p[4], arm: 0, life: 1, fuse: -1 });
export const packSmoke = (s: SmokeState): number[] => [s.id, s.x, s.y, s.life];
export const unpackSmoke = (p: number[]): SmokeState => ({ id: p[0], x: p[1], y: p[2], life: p[3] });
export const packBarrel = (b: BarrelState): number[] => [b.id, b.x, b.y];
export const unpackBarrel = (p: number[]): BarrelState => ({ id: p[0], x: p[1], y: p[2], fuse: -1, by: 0 });

/** JSON-kódolás a számok két tizedesre kerekítésével (a pillanatképek így jóval kisebbek). */
export function roundJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v));
}

export function encode(message: ServerMessage | ClientMessage): string {
  return roundJson(message);
}

/** Felfelé kerekítés a megadott lépésközre (a visszaszámláló idők ritkábban változzanak a hálózaton). */
const stepUp = (value: number, step: number): number => (value > 0 ? Math.ceil(value / step - 1e-6) * step : 0);

/**
 * A saját tank állapotából az, amire a kliensnek szüksége van: a mozgás (az
 * előrejelzéshez) pontosan, a kijelzett visszaszámlálók fél másodperces
 * lépésekben. Ami csak a szerver dolga (belső időzítők, statisztika), nem megy.
 */
export function packMe(t: TankState): Partial<TankState> {
  const effects = { ...t.effects };
  for (const kind of TIMED_KINDS) effects[kind] = stepUp(t.effects[kind], 0.5);
  return {
    x: t.x,
    y: t.y,
    hullAngle: t.hullAngle,
    turretAngle: t.turretAngle,
    turnSpeed: t.turnSpeed,
    speed: t.speed,
    odometer: t.odometer,
    heat: t.heat,
    overheated: t.overheated,
    boosting: t.boosting,
    slip: t.slip,
    slideAngle: t.slideAngle,
    spin: t.spin,
    grip: t.grip,
    hp: Math.round(t.hp * 10) / 10,
    alive: t.alive,
    respawn: stepUp(t.respawn, 0.5),
    team: t.team,
    bot: t.bot,
    kills: t.kills,
    deaths: t.deaths,
    level: t.level,
    lives: t.lives,
    out: t.out,
    effects,
    weapon: t.weapon,
    tripleShots: t.tripleShots,
    ricochet: t.ricochet,
    shield: t.shield,
    oil: t.oil,
    turrets: t.turrets,
    mines: t.mines,
    smokes: t.smokes,
    strikes: t.strikes,
    streak: t.streak,
    botKills: t.botKills,
    cloak: stepUp(t.cloak, 0.5),
    cloakReady: stepUp(t.cloakReady, 1),
  };
}

/**
 * Üzenetolvasó a különbségi pillanatképekhez (tesztekhez, mérésekhez): a szerver
 * szövegéből üzenetet ad, a pillanatképet az addigiakkal összefésülve, teljes
 * állapotként. A saját tank azonosítóját az indító üzenetből tudja.
 */
export function messageReader(): (text: string) => ServerMessage | FullSnapshot {
  let full: FullSnapshot | null = null;
  let myId = 0;
  return (text) => {
    const message = JSON.parse(text) as ServerMessage;
    if (message.t === 'start') {
      myId = message.tank;
      full = null;
    }
    if (message.t !== 'snap') return message;
    full = mergeSnapshot(full, message, myId);
    return full;
  };
}

/** A kliens oldalán összeállított teljes állapot: minden lista megvan benne. */
export type FullSnapshot = Required<Omit<Snapshot, 'me'>> & { me: MeState | null; mine: MeState };

/**
 * A különbségi pillanatkép összefésülése az előző teljes állapottal: ami az
 * újban nincs benne, az nem változott. `myId`: a saját tank azonosítója.
 */
export function mergeSnapshot(prev: FullSnapshot | null, snap: Snapshot, myId: number): FullSnapshot {
  // a saját tank teljes állapota akkor is megmarad, ha éppen nincs tank (me: null)
  let mine = prev?.mine ?? blankTank(myId);
  if (snap.me) mine = { ...mine, ...snap.me, id: myId, effects: { ...mine.effects, ...snap.me.effects } };
  return {
    t: 'snap',
    k: snap.k,
    a: snap.a,
    v: snap.v,
    r: snap.r,
    T: snap.T,
    B: snap.B ?? prev?.B ?? [],
    P: snap.P ?? prev?.P ?? [],
    O: snap.O ?? prev?.O ?? [],
    W: snap.W ?? prev?.W ?? [],
    V: snap.V ?? prev?.V ?? [],
    U: snap.U ?? prev?.U ?? [],
    M: snap.M ?? prev?.M ?? [],
    K: snap.K ?? prev?.K ?? [],
    G: snap.G ?? prev?.G ?? [],
    S: snap.S ?? prev?.S ?? [],
    me: snap.me === null ? null : snap.me === undefined && prev && prev.me === null ? null : mine,
    mine,
  };
}
