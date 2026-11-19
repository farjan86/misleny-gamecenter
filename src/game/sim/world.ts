// Játékszimuláció: tankok, lövedékek, ütközés. Tiszta, determinisztikus logika
// rögzített időlépéssel – nincs benne Phaser- vagy DOM-függés, így a későbbi
// szerver-authoritatív multiplayerben a szerver ugyanezt a kódot futtathatja.
// A kliens csak TankInput-ot ad, az állapotot a World számolja.
// Mértékegységek: méter, másodperc, radián.

import { SegmentGrid } from './collision';

export const SIM_DT = 1 / 60;

export const TANK = {
  radius: 1.7,
  maxSpeed: 17,
  /** tolatás legnagyobb sebessége */
  maxReverse: 9,
  accel: 34,
  brake: 46,
  turnRate: 3,
  turretRate: 9,
  fireCooldown: 0.42,
  barrelLength: 3.9,
} as const;

export const BULLET = {
  speed: 75,
  life: 1.1,
} as const;

export interface TankInput {
  /** gáz a tank saját iránya szerint: 1 = előre, −1 = tolatás, 0 = nincs gáz */
  throttle: number;
  /** a test forgatása: −1 = balra, 1 = jobbra (az óramutató járása szerint) */
  turn: number;
  /** a torony kívánt iránya radiánban; null = a test irányát követi */
  aim: number | null;
  fire: boolean;
}

export interface TankState {
  id: number;
  x: number;
  y: number;
  hullAngle: number;
  turretAngle: number;
  speed: number;
  cooldown: number;
  /** megtett út méterben (lánctalp-animációhoz) */
  odometer: number;
}

export interface BulletState {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export type SimEvent =
  | { type: 'shot'; tank: number; x: number; y: number; angle: number }
  | { type: 'impact'; x: number; y: number }
  | { type: 'bump'; tank: number; x: number; y: number };

export interface Terrain {
  /** a pálya mérete méterben */
  readonly width: number;
  readonly height: number;
  readonly walls: SegmentGrid;
  /** 1 = burkolt út, kisebb érték = lassabb terep */
  speedFactor(x: number, y: number): number;
}

export const NO_INPUT: TankInput = { throttle: 0, turn: 0, aim: null, fire: false };

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

export class World {
  readonly tanks: TankState[] = [];
  readonly bullets: BulletState[] = [];
  /** az utolsó step() eseményei (hang, effektek) */
  events: SimEvent[] = [];
  tick = 0;
  private nextId = 1;

  constructor(readonly terrain: Terrain) {}

  addTank(x: number, y: number, angle: number): TankState {
    const tank: TankState = {
      id: this.nextId++,
      x,
      y,
      hullAngle: angle,
      turretAngle: angle,
      speed: 0,
      cooldown: 0,
      odometer: 0,
    };
    this.tanks.push(tank);
    return tank;
  }

  step(inputs: ReadonlyMap<number, TankInput>, dt = SIM_DT): void {
    this.events = [];
    this.tick++;
    for (const tank of this.tanks) this.stepTank(tank, inputs.get(tank.id) ?? NO_INPUT, dt);
    this.stepBullets(dt);
  }

  private stepTank(tank: TankState, input: TankInput, dt: number): void {
    const { terrain } = this;
    // klasszikus tankirányítás: a test helyben is forog, a gáz a test iránya szerint hat
    tank.hullAngle += clampUnit(input.turn) * TANK.turnRate * dt;
    const throttle = clampUnit(input.throttle);
    const targetSpeed = throttle * (throttle >= 0 ? TANK.maxSpeed : TANK.maxReverse) * terrain.speedFactor(tank.x, tank.y);
    // gyorsítás, ha a cél azonos irányú és nagyobb; különben fékezés
    const speedingUp = targetSpeed * tank.speed >= 0 && Math.abs(targetSpeed) > Math.abs(tank.speed);
    const rate = (speedingUp ? TANK.accel : TANK.brake) * dt;
    if (tank.speed < targetSpeed) tank.speed = Math.min(targetSpeed, tank.speed + rate);
    else tank.speed = Math.max(targetSpeed, tank.speed - rate);

    const stepLen = tank.speed * dt;
    let nx = tank.x + Math.cos(tank.hullAngle) * stepLen;
    let ny = tank.y + Math.sin(tank.hullAngle) * stepLen;

    const res = terrain.walls.resolveCircle(nx, ny, TANK.radius);
    nx = Math.max(TANK.radius, Math.min(terrain.width - TANK.radius, res.x));
    ny = Math.max(TANK.radius, Math.min(terrain.height - TANK.radius, res.y));
    const blocked = res.hit || nx !== res.x || ny !== res.y;

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

    const aim = input.aim ?? tank.hullAngle;
    tank.turretAngle = rotateToward(tank.turretAngle, aim, TANK.turretRate * dt);

    tank.cooldown = Math.max(0, tank.cooldown - dt);
    if (input.fire && tank.cooldown === 0) {
      tank.cooldown = TANK.fireCooldown;
      const cos = Math.cos(tank.turretAngle);
      const sin = Math.sin(tank.turretAngle);
      const mx = tank.x + cos * TANK.barrelLength;
      const my = tank.y + sin * TANK.barrelLength;
      this.events.push({ type: 'shot', tank: tank.id, x: mx, y: my, angle: tank.turretAngle });
      // ha a cső vége falban van, a lövedék azonnal becsapódik
      const hit = terrain.walls.raycast(tank.x, tank.y, mx, my);
      if (hit) {
        this.events.push({ type: 'impact', x: hit.x, y: hit.y });
      } else {
        this.bullets.push({
          id: this.nextId++,
          owner: tank.id,
          x: mx,
          y: my,
          vx: cos * BULLET.speed,
          vy: sin * BULLET.speed,
          life: BULLET.life,
        });
      }
    }
  }

  private stepBullets(dt: number): void {
    const { terrain } = this;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const nx = b.x + b.vx * dt;
      const ny = b.y + b.vy * dt;
      const hit = terrain.walls.raycast(b.x, b.y, nx, ny);
      if (hit) {
        this.events.push({ type: 'impact', x: hit.x, y: hit.y });
        this.bullets.splice(i, 1);
        continue;
      }
      b.x = nx;
      b.y = ny;
      b.life -= dt;
      const out = nx < 0 || ny < 0 || nx > terrain.width || ny > terrain.height;
      if (out || b.life <= 0) {
        if (!out) this.events.push({ type: 'impact', x: nx, y: ny });
        this.bullets.splice(i, 1);
      }
    }
  }
}
