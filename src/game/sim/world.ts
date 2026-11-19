// Játékszimuláció: tankok, lövedékek, sebzés, felvehető tárgyak, olajfoltok,
// ütközés. Tiszta, determinisztikus logika rögzített időlépéssel – nincs benne
// Phaser- vagy DOM-függés, így a későbbi szerver-authoritatív multiplayerben a
// szerver ugyanezt a kódot futtathatja. A kliens (és a botok „agya”) csak
// TankInput-ot ad, az állapotot a World számolja.
// Mértékegységek: méter, másodperc, radián.

import { SegmentGrid } from './collision';
import { FELLABLE, type Fellables } from './props';
import { BOOST, isWeapon, LASER, mulberry32, OIL, PICKUP, pickKind, PICKUPS, ROCKET, TIMED_KINDS, type PickupKind, type TimedKind, type WeaponKind } from './pickups';

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
 * Fejlődés: minden kilőtt tank után egy szinttel erősebb a tank – kicsit
 * nagyobb, több az életereje, és nagyobbat sebez a lövedéke.
 */
export const LEVEL = {
  max: 20,
  /** méretnövekedés szintenként */
  size: 0.03,
  /** többlet életerő szintenként */
  hp: 12,
  /** többlet sebzés szintenként */
  damage: 0.08,
} as const;

/** A tank mérete az alapmérethez képest (1. szint = 1). */
export const tankSize = (tank: { level: number }): number => 1 + LEVEL.size * (tank.level - 1);
export const tankRadius = (tank: { level: number }): number => TANK.radius * tankSize(tank);
export const tankMaxHp = (tank: { level: number }): number => TANK.maxHp + LEVEL.hp * (tank.level - 1);
const damageBoost = (tank: { level: number }): number => 1 + LEVEL.damage * (tank.level - 1);

/** Kilőtt tankok roncsai: ott maradnak, akadályként. */
export const WRECK = {
  radius: 1.5,
  /** ennyi roncs marad a pályán; fölötte a legrégebbiek tűnnek el */
  max: 150,
} as const;

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
}

export interface PickupState {
  id: number;
  kind: PickupKind;
  x: number;
  y: number;
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
  /** kidőlt egy fa vagy oszlop (index: a pálya kidönthető tárgyainak sorszáma) */
  | { type: 'felled'; index: number; x: number; y: number; angle: number; shot: boolean }
  /** találat: `absorbed` jelzi, ha pajzs vagy sebezhetetlenség fogta fel */
  | { type: 'hit'; tank: number; by: number; x: number; y: number; absorbed: 'shield' | 'invulnerable' | null }
  | { type: 'destroyed'; tank: number; by: number; x: number; y: number }
  | { type: 'respawn'; tank: number; x: number; y: number }
  /** a gyorsító túlmelegedett */
  | { type: 'overheat'; tank: number }
  | { type: 'levelup'; tank: number; level: number };

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
  /** 1 = burkolt út, kisebb érték = lassabb terep */
  speedFactor(x: number, y: number): number;
  /** Véletlen, járművel elérhető hely (felvehető tárgynak, újraéledő botnak), ha a pálya tud ilyet adni. */
  pickupSpot?(rnd: () => number): { x: number; y: number } | null;
  /** A legközelebbi közút a botok útkövetéséhez. */
  roadGuide?(x: number, y: number): RoadGuide | null;
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
  return { rapid: 0, speed: 0, allTerrain: 0, invulnerable: 0, radar: 0 };
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
  /** az utolsó step() eseményei (hang, effektek) */
  events: SimEvent[] = [];
  tick = 0;
  private nextId = 1;
  /** a felvett tárgyak pótlásáig hátralévő idők (mp) */
  private readonly respawns: number[] = [];
  readonly rnd: () => number;

  /** `seed`: a véletlen elemek (tárgyak helye, típusa) magja – azonos magból azonos játék. */
  constructor(
    readonly terrain: Terrain,
    seed = 1,
  ) {
    this.rnd = mulberry32(seed);
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
      homeX: x,
      homeY: y,
      homeAngle: angle,
      effects: noEffects(),
      weapon: null,
      tripleShots: 0,
      ricochet: false,
      shield: 0,
      oil: 0,
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
    const enemyTeam = this.tanks.find((t) => t.team !== tank.team)?.team ?? -1;
    const spot = this.freeSpot(clear, enemyTeam);
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
    const spotOf = this.terrain.pickupSpot?.bind(this.terrain);
    if (!spotOf) return null;
    for (let attempt = 0; attempt < 80; attempt++) {
      const spot = spotOf(this.rnd);
      if (!spot) continue;
      if (this.tanks.some((t) => t.alive && Math.hypot(t.x - spot.x, t.y - spot.y) < (t.team === avoidTeam ? Math.max(minDist, 8) : 8))) continue;
      if (this.wrecks.some((w) => Math.hypot(w.x - spot.x, w.y - spot.y) < 7)) continue;
      return spot;
    }
    return null;
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
  }

  private stepRespawn(tank: TankState, dt: number): void {
    tank.respawn -= dt;
    if (tank.respawn > 0) return;
    // a botok véletlen helyen, az ellenféltől távol élednek újra; a játékos a kezdőpontján
    const spot = tank.bot ? this.freeSpot(120, tank.team === TEAM.bots ? TEAM.player : TEAM.bots) : null;
    tank.x = spot?.x ?? tank.homeX;
    tank.y = spot?.y ?? tank.homeY;
    tank.hullAngle = spot ? this.rnd() * Math.PI * 2 : tank.homeAngle;
    tank.turretAngle = tank.hullAngle;
    tank.speed = 0;
    tank.turnSpeed = 0;
    tank.slip = 0;
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
      const ground = fx.allTerrain > 0 ? 1 : terrain.speedFactor(tank.x, tank.y);
      const targetSpeed = throttle * (throttle >= 0 ? TANK.maxSpeed : TANK.maxReverse) * boost * ground;
      // gyorsítás, ha a cél azonos irányú és nagyobb; különben fékezés
      const speedingUp = targetSpeed * tank.speed >= 0 && Math.abs(targetSpeed) > Math.abs(tank.speed);
      const rate = (speedingUp ? TANK.accel * (fx.speed > 0 ? BOOST.accel : 1) : TANK.brake) * dt;
      if (tank.speed < targetSpeed) tank.speed = Math.min(targetSpeed, tank.speed + rate);
      else tank.speed = Math.max(targetSpeed, tank.speed - rate);
      heading = tank.hullAngle;
    }

    const stepLen = tank.speed * dt;
    let nx = tank.x + Math.cos(heading) * stepLen;
    let ny = tank.y + Math.sin(heading) * stepLen;

    const res = terrain.walls.resolveCircle(nx, ny, radius);
    nx = Math.max(radius, Math.min(terrain.width - radius, res.x));
    ny = Math.max(radius, Math.min(terrain.height - radius, res.y));
    let blocked = res.hit || nx !== res.x || ny !== res.y;
    // a roncsokat ki kell kerülni
    const clear = radius + WRECK.radius;
    for (const w of this.wrecks) {
      const dx = nx - w.x;
      const dy = ny - w.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= clear * clear) continue;
      const d = Math.sqrt(d2) || 0.001;
      // a roncsról letolva a tank ne kerüljön falba
      const out = terrain.walls.resolveCircle(w.x + (dx / d) * clear, w.y + (dy / d) * clear, radius);
      nx = out.x;
      ny = out.y;
      blocked = true;
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
      const t = segmentCircle(ax, ay, bx, by, w.x, w.y, WRECK.radius);
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
      return;
    }

    // hármas lövésnél a lövedékek (sugarak) legyezőben indulnak; lövésenként egy töltet fogy
    const triple = tank.tripleShots > 0;
    if (triple) tank.tripleShots--;
    const spread = triple ? [-BOOST.tripleSpread, 0, BOOST.tripleSpread] : [0];
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
    const target = this.firstTankOnPath(mx, my, ex, ey, tank.team, reach);
    if (target) reach = target.t;
    // a sugár az útjába eső első fát vagy oszlopot kidönti, és ott megáll
    const prop = this.terrain.fellables?.raycast(mx, my, ex, ey, reach) ?? null;
    if (prop) reach = prop.t;
    ex = mx + cos * LASER.range * reach;
    ey = my + sin * LASER.range * reach;
    if (target || wall || prop || wreckT >= 0) this.events.push({ type: 'impact', kind: 'laser', x: ex, y: ey });
    this.events.push({ type: 'laser', x1: mx, y1: my, x2: ex, y2: ey });
    if (prop) this.fell(prop.index, Math.atan2(sin, cos));
    else if (target) this.damage(target.tank, DAMAGE.laser, tank.id, ex, ey);
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
      this.events.push({ type: 'hit', tank: tank.id, by, x, y, absorbed: 'invulnerable' });
      return;
    }
    if (tank.shield > 0) {
      tank.shield--;
      this.events.push({ type: 'hit', tank: tank.id, by, x, y, absorbed: 'shield' });
      return;
    }
    // a támadó szintje növeli a sebzést
    const attacker = this.tank(by);
    tank.hp -= amount * (attacker ? damageBoost(attacker) : 1);
    this.events.push({ type: 'hit', tank: tank.id, by, x, y, absorbed: null });
    if (tank.hp > 0) return;
    tank.hp = 0;
    tank.alive = false;
    tank.respawn = TANK.respawnDelay;
    tank.speed = 0;
    tank.deaths++;
    this.wrecks.push({ id: this.nextId++, x: tank.x, y: tank.y, hullAngle: tank.hullAngle, turretAngle: tank.turretAngle, team: tank.team, age: 0 });
    if (this.wrecks.length > WRECK.max) this.wrecks.shift();
    if (attacker) {
      attacker.kills++;
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
    if (direct) this.damage(direct, DAMAGE[b.kind], b.owner, x, y);
    if (b.kind !== 'rocket') return;
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
      const solid = wreckT >= 0 ? wreckT : wall ? wall.t : 1;
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
        this.bullets.splice(i, 1);
        continue;
      }
      b.x = nx;
      b.y = ny;
      b.life -= dt;
      const out = nx < 0 || ny < 0 || nx > terrain.width || ny > terrain.height;
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
        this.respawns.push(PICKUP.respawnDelay);
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
