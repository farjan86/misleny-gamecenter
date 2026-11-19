// Gép vezérelte tankok. A bot ugyanazt a TankInput-ot adja, mint egy játékos –
// a szimuláció számára nincs különbség, így a botok a szerveren is futtathatók.
//
// Viselkedés:
//   járőr   – az utakat követve halad, a jobb oldali sávban;
//   támadás – ha meglát egy ellenséges (más csapatbeli) tankot, tornyát ráfordítja,
//             lő, és lőtávolságon belülre megy;
//   üldözés – ha szem elől téveszti, egy ideig az utolsó ismert helye felé tart.
// A botok egymást nem sebzik (azonos csapat), és egymásra nem is céloznak.

import { angleDiff, type TankInput, type TankState, type World } from './world';

export const BOT = {
  /** ilyen messziről veszi észre az ellenfelet, ha rálát (m) */
  sight: 75,
  /** az észleléstől az első lövésig eltelő idő (mp) */
  reaction: 0.7,
  /** két lövés között legalább ennyi idő telik el (mp) – a bot lassabban lő, mint a játékos */
  fireInterval: 1.2,
  /** a célzás pontatlansága (rad) */
  aimError: 0.07,
  /** ennél közelebb nem megy a célponthoz (m) */
  keepDistance: 22,
  /** járőrözés közben a gáz állása */
  patrolThrottle: 0.7,
  /** ennyi ideig keresi az ellenfelet az utolsó ismert helyén (mp) */
  chaseTime: 7,
  /** ennyi lépésenként ellenőrzi, rálát-e az ellenfélre */
  sightEvery: 8,
} as const;

type Mode = 'patrol' | 'attack' | 'chase';

const clamp = (v: number): number => Math.max(-1, Math.min(1, v));

export class BotBrain {
  private mode: Mode = 'patrol';
  private readonly input: TankInput = { throttle: 0, turn: 0, aim: null, fire: false, drop: false };
  /** a kiszemelt ellenfél, illetve az utolsó ismert helye */
  private targetId = -1;
  private lastSeenX = 0;
  private lastSeenY = 0;
  private sees = false;
  private reaction = 0;
  private fireWait = 0;
  private chase = 0;
  private aimOffset = 0;
  /** az út melyik irányába halad (az útirány vagy annak ellentettje) */
  private travel: number;
  // elakadás kezelése
  private stuck = 0;
  private reverse = 0;
  private reverseTurn = 1;
  private readonly phase: number;

  constructor(
    private readonly world: World,
    readonly tankId: number,
  ) {
    const tank = world.tank(tankId);
    this.travel = tank?.hullAngle ?? 0;
    this.phase = Math.floor(world.rnd() * BOT.sightEvery);
  }

  /** A bot bemenete a következő szimulációs lépéshez. */
  update(dt: number): TankInput {
    const input = this.input;
    const tank = this.world.tank(this.tankId);
    input.throttle = 0;
    input.turn = 0;
    input.fire = false;
    input.aim = null;
    if (!tank || !tank.alive) {
      this.mode = 'patrol';
      this.sees = false;
      return input;
    }

    this.look(tank);
    this.fireWait = Math.max(0, this.fireWait - dt);

    if (this.sees) {
      this.attack(tank, dt);
    } else if (this.mode === 'chase' && this.chase > 0) {
      this.chase -= dt;
      const dist = Math.hypot(this.lastSeenX - tank.x, this.lastSeenY - tank.y);
      if (dist < 8) this.chase = 0;
      else this.steerToward(tank, Math.atan2(this.lastSeenY - tank.y, this.lastSeenX - tank.x), 0.85);
      // a torony arra néz, amerre az ellenfelet utoljára látta
      input.aim = Math.atan2(this.lastSeenY - tank.y, this.lastSeenX - tank.x);
    } else {
      this.mode = 'patrol';
      this.patrol(tank);
    }

    this.avoidWalls(tank);
    this.unstick(tank, dt);
    return input;
  }

  /** Ellenfél keresése: a legközelebbi, látótávolságon belüli, takarásban nem lévő más csapatbeli tank. */
  private look(tank: TankState): void {
    if ((this.world.tick + this.phase) % BOT.sightEvery !== 0) return;
    let best: TankState | null = null;
    let bestDist: number = BOT.sight;
    for (const other of this.world.tanks) {
      if (!other.alive || other.team === tank.team) continue;
      const dist = Math.hypot(other.x - tank.x, other.y - tank.y);
      if (dist >= bestDist) continue;
      if (this.world.terrain.walls.raycast(tank.x, tank.y, other.x, other.y)) continue; // fal takarja
      best = other;
      bestDist = dist;
    }
    if (best) {
      if (!this.sees) this.reaction = BOT.reaction;
      this.sees = true;
      this.mode = 'attack';
      this.targetId = best.id;
      this.lastSeenX = best.x;
      this.lastSeenY = best.y;
    } else if (this.sees) {
      // szem elől tévesztette: az utolsó ismert hely felé indul
      this.sees = false;
      this.mode = 'chase';
      this.chase = BOT.chaseTime;
    }
  }

  private attack(tank: TankState, dt: number): void {
    const input = this.input;
    const target = this.world.tank(this.targetId);
    if (!target || !target.alive) {
      this.sees = false;
      this.mode = 'patrol';
      return;
    }
    const dx = target.x - tank.x;
    const dy = target.y - tank.y;
    const dist = Math.hypot(dx, dy);
    const bearing = Math.atan2(dy, dx);

    // a célzás hibája lassan vándorol, így a bot nem talál minden lövéssel
    this.aimOffset += (this.world.rnd() - 0.5) * 0.02;
    this.aimOffset = Math.max(-BOT.aimError, Math.min(BOT.aimError, this.aimOffset));
    input.aim = bearing + this.aimOffset;

    this.reaction = Math.max(0, this.reaction - dt);
    const aligned = Math.abs(angleDiff(input.aim, tank.turretAngle)) < 0.07;
    if (this.reaction === 0 && this.fireWait === 0 && aligned) {
      input.fire = true;
      this.fireWait = BOT.fireInterval;
    }

    // lőtávolságon belülre megy, de nem megy neki a célpontnak
    if (dist > BOT.keepDistance + 8) this.steerToward(tank, bearing, 0.8);
    else if (dist < BOT.keepDistance - 8) this.steerToward(tank, bearing, -0.5);
    else input.turn = clamp(angleDiff(bearing, tank.hullAngle) * 1.5);
  }

  /** Útkövetés: az út irányában, a jobb oldali sávban halad. */
  private patrol(tank: TankState): void {
    const guide = this.world.terrain.roadGuide?.(tank.x, tank.y) ?? null;
    if (!guide) {
      // nincs út a közelben: egyenesen megy tovább
      this.steerToward(tank, this.travel, BOT.patrolThrottle);
      return;
    }
    // az út két iránya közül azt választja, amerre eddig is haladt
    const along = Math.abs(angleDiff(guide.angle, this.travel)) <= Math.PI / 2 ? guide.angle : guide.angle + Math.PI;
    this.travel = along;
    // célpont: az úttengely előrébb lévő pontja, a jobb oldali sáv közepére tolva
    const ahead = 9;
    const lane = guide.width / 4;
    const tx = guide.x + Math.cos(along) * ahead - Math.sin(along) * lane;
    const ty = guide.y + Math.sin(along) * ahead + Math.cos(along) * lane;
    this.steerToward(tank, Math.atan2(ty - tank.y, tx - tank.x), BOT.patrolThrottle);
  }

  /** Kormányzás a megadott irányba; éles fordulónál lassít. */
  private steerToward(tank: TankState, angle: number, throttle: number): void {
    const diff = angleDiff(angle, tank.hullAngle);
    this.input.turn = clamp(diff * 2.2);
    const sharp = Math.abs(diff) > 0.9;
    this.input.throttle = sharp ? throttle * 0.35 : throttle;
  }

  /** Tapogatók: ha elöl fal van, arra fordul, amerre több a hely. */
  private avoidWalls(tank: TankState): void {
    const input = this.input;
    if (input.throttle <= 0 || this.reverse > 0) return;
    const walls = this.world.terrain.walls;
    const reach = 5 + Math.abs(tank.speed) * 0.35;
    const probe = (offset: number): number => {
      const a = tank.hullAngle + offset;
      const hit = walls.raycast(tank.x, tank.y, tank.x + Math.cos(a) * reach, tank.y + Math.sin(a) * reach);
      return hit ? hit.t : 1;
    };
    const front = probe(0);
    if (front >= 1) return;
    const left = probe(-0.6);
    const right = probe(0.6);
    input.turn = right >= left ? 1 : -1;
    input.throttle *= Math.max(0.25, front);
  }

  /** Ha gázt ad, de nem halad, rövid időre hátramenetbe kapcsol és elfordul. */
  private unstick(tank: TankState, dt: number): void {
    const input = this.input;
    if (this.reverse > 0) {
      this.reverse -= dt;
      input.throttle = -0.8;
      input.turn = this.reverseTurn;
      if (this.reverse <= 0) this.travel = tank.hullAngle;
      return;
    }
    if (Math.abs(input.throttle) > 0.2 && Math.abs(tank.speed) < 1 && tank.slip === 0) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.stuck > 0.9) {
      this.stuck = 0;
      this.reverse = 0.9 + this.world.rnd() * 0.6;
      this.reverseTurn = this.world.rnd() < 0.5 ? -1 : 1;
    }
  }
}

/** Botok kezelése: létrehozás, eltávolítás és a bemenetük előállítása lépésenként. */
export class BotManager {
  private readonly brains = new Map<number, BotBrain>();

  constructor(private readonly world: World) {}

  get count(): number {
    return this.brains.size;
  }

  /** A botok számának beállítása: a hiányzókat létrehozza, a fölöslegeseket eltávolítja. */
  setCount(count: number, team: number, avoidTeam: number): void {
    while (this.brains.size > count) {
      const id = [...this.brains.keys()].pop()!;
      this.brains.delete(id);
      this.world.removeTank(id);
    }
    while (this.brains.size < count) {
      const spot = this.world.freeSpot(140, avoidTeam);
      if (!spot) break;
      const tank = this.world.addTank(spot.x, spot.y, this.world.rnd() * Math.PI * 2, { team, bot: true });
      this.brains.set(tank.id, new BotBrain(this.world, tank.id));
    }
  }

  /** A botok bemenetének beírása a közös bemenet-táblába. */
  update(inputs: Map<number, TankInput>, dt: number): void {
    for (const [id, brain] of this.brains) inputs.set(id, brain.update(dt));
  }
}
