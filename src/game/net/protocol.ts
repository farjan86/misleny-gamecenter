// A kliens és a szerver közötti üzenetek. Minden üzenet JSON, a `t` mező a
// típusa. A protokoll verziózott: a szerver az eltérő verziójú klienst elutasítja.
//
// Elv: a kliens csak BEMENETET küld (TankInput), a szerver számol mindent, és
// állapot-pillanatképeket (snap) meg eseményeket (ev) küld vissza.

import { PICKUP_KINDS } from '../sim/pickups';
import type { MatchPlan, MatchSettings } from '../sim/match';
import type { BarrelState, MineState, SmokeState } from '../sim/gadgets';
import { VEHICLE_KINDS, type TurretState, type VehicleState } from '../sim/vehicles';
import type { BulletState, OilState, PickupState, ShellKind, SimEvent, TankInput, TankState, WreckState } from '../sim/world';

export const PROTOCOL_VERSION = 5;
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

/** A privát játék belépőkódjának hossza. */
export const ROOM_CODE = { min: 3, max: 16 } as const;

/** A belépőkód egységes alakja: szóközök nélkül, a kis- és nagybetű nem számít. */
export function cleanCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, '').toLowerCase().slice(0, ROOM_CODE.max) : '';
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
 * 16 = akna, 32 = füst; ha tüzérségi csapást kér: a célpont x, y koordinátája]
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
  | { t: 'ping'; c: number };

/** a saját (vagy a nézett) tank teljes állapota */
export type MeState = TankState;

/** [id, x, y, test szöge, torony szöge, sebesség, életerő, szint, jelzők, csapat, megtett út] */
export type PackedTank = number[];
export const TANK_FLAG = { alive: 1, bot: 2, boosting: 4, invulnerable: 8, shield: 16, out: 32, super: 64 } as const;

export interface Snapshot {
  t: 'snap';
  /** a szimuláció lépésszáma */
  k: number;
  /** az utolsó feldolgozott bemenet sorszáma */
  a: number;
  /** a saját tank teljes állapota (null, ha már nincs tankja) */
  me: MeState | null;
  /** annak a tanknak az azonosítója, amelyet a kamera követ (kiesés után egy másik játékosé) */
  v: number;
  T: PackedTank[];
  /** lövedékek: [id, fajta (0 sima, 1 nehéz, 2 rakéta), x, y, vx, vy, a kilövő tank] */
  B: number[][];
  /** tárgyak: [id, fajta sorszáma, x, y] */
  P: number[][];
  /** olajfoltok: [id, x, y] */
  O: number[][];
  /** roncsok: [id, x, y, test szöge, torony szöge, kor, szint] */
  W: number[][];
  /** civil járművek: [id, fajta, megjelenés, x, y, szög, sebesség, állapot] */
  V: number[][];
  /** telepített ágyúk: [id, lerakó tank, csapat, x, y, szög, életerő] */
  U: number[][];
  /** aknák: [id, lerakó tank, csapat, x, y]; füstfelhők: [id, x, y, hátralévő idő]; gázpalackok: [id, x, y] */
  M: number[][];
  K: number[][];
  G: number[][];
  /** játékosok állása: [tank, kilövések, halálok, kilépett-e] */
  S: number[][];
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
  | { t: 'start'; room: RoomInfo; tank: number; players: PlayerInfo[] }
  | Snapshot
  | { t: 'ev'; e: SimEvent[] }
  | { t: 'over'; winner: string | null; standings: Standing[] }
  | { t: 'pong'; c: number };

// --- tömörítés ------------------------------------------------------------------

export function packInput(input: TankInput): PackedInput {
  const flags = (input.fire ? 1 : 0) | (input.drop ? 2 : 0) | (input.boost ? 4 : 0) | (input.deploy ? 8 : 0) | (input.mine ? 16 : 0) | (input.smoke ? 32 : 0);
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
    (t.effects.super > 0 ? TANK_FLAG.super : 0);
  return [t.id, t.x, t.y, t.hullAngle, t.turretAngle, t.speed, t.hp, t.level, flags, t.team, t.odometer];
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
    effects: { rapid: 0, speed: 0, allTerrain: 0, invulnerable: 0, radar: 0, super: 0 },
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
export const packWreck = (w: WreckState): number[] => [w.id, w.x, w.y, w.hullAngle, w.turretAngle, w.age, w.level];
export const unpackWreck = (p: number[]): WreckState => ({ id: p[0], x: p[1], y: p[2], hullAngle: p[3], turretAngle: p[4], team: 0, level: p[6] ?? 1, age: p[5] });

export const packVehicle = (v: VehicleState): number[] => [v.id, VEHICLE_KINDS.indexOf(v.kind), v.look, v.x, v.y, v.angle, v.speed, v.state];
export const unpackVehicle = (p: number[]): VehicleState => ({ id: p[0], kind: VEHICLE_KINDS[p[1]] ?? 'car', look: p[2], x: p[3], y: p[4], angle: p[5], speed: p[6], hp: 1, state: p[7], timer: 0, by: 0 });
export const packTurret = (t: TurretState): number[] => [t.id, t.owner, t.team, t.x, t.y, t.angle, t.hp];
export const unpackTurret = (p: number[]): TurretState => ({ id: p[0], owner: p[1], team: p[2], x: p[3], y: p[4], angle: p[5], hp: p[6], cooldown: 0, target: -1 });

export const packMine = (m: MineState): number[] => [m.id, m.owner, m.team, m.x, m.y];
export const unpackMine = (p: number[]): MineState => ({ id: p[0], owner: p[1], team: p[2], x: p[3], y: p[4], arm: 0, life: 1, fuse: -1 });
export const packSmoke = (s: SmokeState): number[] => [s.id, s.x, s.y, s.life];
export const unpackSmoke = (p: number[]): SmokeState => ({ id: p[0], x: p[1], y: p[2], life: p[3] });
export const packBarrel = (b: BarrelState): number[] => [b.id, b.x, b.y];
export const unpackBarrel = (p: number[]): BarrelState => ({ id: p[0], x: p[1], y: p[2], fuse: -1, by: 0 });

/** JSON-kódolás a számok kerekítésével (a pillanatképek így jóval kisebbek). */
export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message, (_key, value: unknown) => (typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 100) / 100 : value));
}
