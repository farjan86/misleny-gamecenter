// A főgonosz (a Vasóriás) és a testőrei: mikor és hol jelennek meg, és ki kit támad.
//
// - Csak elég hosszú (vagy nyitott) meccsben, elég nagy játéktéren jön (bossAllowed). Az első a
//   meccs 3–5. percében érkezik, az újabbak a legyőzése után 8–10 perccel – de csak akkor, ha a
//   meccsből utána még legalább 5 perc hátravan. Előtte 20 másodperccel bejelenti a játék.
// - A tanya egy tágas hely a játékosoktól távol. A boss lassan araszol rajta, a testőrök körben
//   állnak körülötte.
// - Riadó (méhraj): ha valaki a bosst vagy egy testőrt megtámadja, két testőr üldözi (a tanyától
//   legfeljebb BOSS.leash méterig), a többi a bossnál marad, és csak a közelébe jövőket támadja.
//   A boss csak védekezik: azt lövi, aki megtámadta a falkát, vagy aki túl közel jön.
// - A botokat békén hagyják (és azok is őket), amíg egy bot meg nem támadja őket.

import { BotBrain, botTuning, type BotPost } from './bots';
import { BOSS, ROLE } from './bossRules';
import { tankMaxHp, TEAM, type TankInput, type TankState, type World } from './world';

/** Másodperc a meccs kezdete óta (60 lépés = 1 mp). */
const SIM_HZ = 60;

export class BossPack {
  /** a meccs kezdete óta eltelt idő (mp) */
  private clock = 0;
  /** a következő érkezés ideje (mp; Infinity: nem jön több) */
  private nextAt: number;
  /** a bejelentett tanya (a bejelentéstől a megérkezésig) */
  private announced: { x: number; y: number } | null = null;
  /** a tanya közepe, a boss és a testőrök (amíg a falka a pályán van) */
  private lair: { x: number; y: number } | null = null;
  private bossId = -1;
  private guardIds: number[] = [];
  private readonly brains = new Map<number, BotBrain>();
  /** a kilőtt tagok: mikor tűnik el a tankjuk */
  private readonly removals = new Map<number, number>();
  /** a boss mostani célhelye a tanyán belül, és mikor választ újat */
  private wander = { x: 0, y: 0, until: 0 };

  constructor(
    private readonly world: World,
    /** jöhet-e egyáltalán főgonosz ebben a meccsben */
    readonly enabled: boolean,
  ) {
    this.nextAt = enabled ? this.between(BOSS.first) : Infinity;
  }

  private between(range: readonly [number, number]): number {
    return range[0] + this.world.rnd() * (range[1] - range[0]);
  }

  /** A boss tankja (ha a pályán van és él). */
  get boss(): TankState | undefined {
    const tank = this.bossId >= 0 ? this.world.tank(this.bossId) : undefined;
    return tank && tank.alive ? tank : undefined;
  }

  /** A falka tagjai (élők és a még el nem tűnt kilőttek). */
  get members(): number[] {
    return [...this.brains.keys()];
  }

  /** A következő érkezés ideje (mp a meccs kezdetétől; tesztekhez). */
  get due(): number {
    return this.nextAt;
  }

  /** A falka tagjainak bemenete a következő lépéshez. */
  update(inputs: Map<number, TankInput>, dt: number): void {
    for (const [id, brain] of this.brains) inputs.set(id, brain.update(dt));
  }

  /**
   * Lépésenként, a világ lépése után (az eseményei ebbe a lépésbe kerülnek): időzítés,
   * bejelentés, érkezés, a kilőttek eltüntetése. `timeLeft`: a meccsből hátralévő idő (mp).
   */
  step(dt: number, timeLeft: number): void {
    const { world } = this;
    this.clock += dt;
    // a kilőtt tagok tankja kis idő múlva eltűnik (a roncsuk marad)
    for (const id of this.brains.keys()) {
      const tank = world.tank(id);
      if (!tank || tank.alive) continue;
      const due = this.removals.get(id) ?? this.clock + BOSS.removeAfter;
      this.removals.set(id, due);
      if (this.clock >= due) this.remove(id);
    }
    // a boss legyőzése után a testőrök is elvonulnak, és később új falka jöhet
    if (this.lair && !this.boss && this.bossId >= 0 && !this.brains.has(this.bossId)) {
      for (const id of [...this.brains.keys()]) this.remove(id);
      this.lair = null;
      this.bossId = -1;
      this.guardIds = [];
      world.packThreats.clear();
      world.bossDamage.clear();
      this.nextAt = this.clock + this.between(BOSS.again);
    }
    if (this.lair || this.nextAt === Infinity) return;
    // ha a megérkezése után már nem maradna elég idő, ebben a meccsben nem jön (több)
    if (timeLeft - (this.nextAt - this.clock) < BOSS.minLeft) {
      this.nextAt = Infinity;
      this.announced = null;
      return;
    }
    if (!this.announced && this.clock >= this.nextAt - BOSS.warn) {
      const spot = this.findLair();
      if (!spot) {
        // most nincs alkalmas hely: egy perc múlva újra próbálja
        this.nextAt += 60;
        return;
      }
      this.announced = spot;
      world.events.push({ type: 'bossSoon', x: spot.x, y: spot.y, seconds: Math.max(1, Math.round(this.nextAt - this.clock)) });
    }
    if (this.announced && this.clock >= this.nextAt) {
      this.spawn(this.announced);
      this.announced = null;
    }
  }

  private remove(id: number): void {
    this.brains.delete(id);
    this.removals.delete(id);
    this.world.removeTank(id);
  }

  /**
   * A tanya helye: egy tágas, útmenti pont (minden irányban legalább BOSS.clearWalls méter
   * szabad hely), a játékosoktól távol, a játéktér szélétől beljebb. A legtágasabbat választja.
   */
  findLair(): { x: number; y: number } | null {
    const { world } = this;
    const spotOf = world.terrain.pickupSpot?.bind(world.terrain);
    if (!spotOf) return null;
    const area = world.terrain.bounds ?? { minX: 0, minY: 0, maxX: world.terrain.width, maxY: world.terrain.height };
    const players = world.tanks.filter((t) => t.alive && !t.bot);
    for (const far of [BOSS.clearPlayers, 100, 60]) {
      let best: { x: number; y: number } | null = null;
      let bestRoom = -1;
      for (let attempt = 0; attempt < 160; attempt++) {
        const spot = spotOf(world.rnd);
        if (!spot) continue;
        if (spot.x < area.minX + 30 || spot.y < area.minY + 30 || spot.x > area.maxX - 30 || spot.y > area.maxY - 30) continue;
        if (players.some((t) => Math.hypot(t.x - spot.x, t.y - spot.y) < far)) continue;
        if (world.tanks.some((t) => t.alive && Math.hypot(t.x - spot.x, t.y - spot.y) < 30)) continue;
        // a javítóműhelyt ne zárja el
        if (world.workshops.some((w) => Math.hypot(w.x - spot.x, w.y - spot.y) < 40)) continue;
        const room = this.room(spot.x, spot.y);
        if (room >= BOSS.clearWalls && room > bestRoom) {
          bestRoom = room;
          best = spot;
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Mennyi szabad hely (m) van a pont körül a legszűkebb irányban (legfeljebb 24 m-ig nézi). */
  private room(x: number, y: number): number {
    const { walls } = this.world.terrain;
    let least = 24;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const hit = walls.raycast(x, y, x + Math.cos(a) * 24, y + Math.sin(a) * 24);
      if (hit) least = Math.min(least, hit.t * 24);
    }
    return least;
  }

  /** A falka megérkezik: a boss a tanya közepén, a testőrök körben körülötte. */
  spawn(at: { x: number; y: number }): void {
    const { world } = this;
    this.lair = { x: at.x, y: at.y };
    this.wander = { x: at.x, y: at.y, until: this.clock + BOSS.wanderEvery };
    world.packThreats.clear();
    world.bossDamage.clear();
    const boss = world.addTank(at.x, at.y, world.rnd() * Math.PI * 2, { team: TEAM.boss, bot: true, look: 0, role: ROLE.boss });
    boss.level = BOSS.level;
    boss.hp = tankMaxHp(boss);
    boss.weapon = 'heavy';
    boss.turrets = 0;
    this.bossId = boss.id;
    this.brains.set(boss.id, new BotBrain(world, boss.id, botTuning(6, 3), this.bossPost()));
    this.guardIds = [];
    for (let i = 0; i < BOSS.guards; i++) {
      const a = (i / BOSS.guards) * Math.PI * 2;
      // a testőr a körön, de ha arra fal van, beljebb
      const hit = world.terrain.walls.raycast(at.x, at.y, at.x + Math.cos(a) * BOSS.ring, at.y + Math.sin(a) * BOSS.ring);
      const reach = hit ? Math.max(6, hit.t * BOSS.ring - 3) : BOSS.ring;
      const spot = world.terrain.walls.resolveCircle(at.x + Math.cos(a) * reach, at.y + Math.sin(a) * reach, 2.5);
      const guard = world.addTank(spot.x, spot.y, a, { team: TEAM.boss, bot: true, look: 0, role: ROLE.guard });
      guard.level = BOSS.guardLevel;
      guard.hp = tankMaxHp(guard);
      guard.turrets = 0;
      this.guardIds.push(guard.id);
      this.brains.set(guard.id, new BotBrain(world, guard.id, botTuning(5, 4), this.guardPost(i)));
    }
    world.events.push({ type: 'bossSpawn', tank: boss.id, x: at.x, y: at.y });
  }

  /** A falka élő támadói (az utolsó BOSS.alarm másodpercben támadtak), a legutóbbi elöl. */
  private threats(): TankState[] {
    const { world } = this;
    const since = world.tick - BOSS.alarm * SIM_HZ;
    const list: { tank: TankState; at: number }[] = [];
    for (const [id, at] of world.packThreats) {
      if (at < since) {
        world.packThreats.delete(id);
        continue;
      }
      const tank = world.tank(id);
      if (tank && tank.alive) list.push({ tank, at });
    }
    return list.sort((a, b) => b.at - a.at).map((e) => e.tank);
  }

  /** A legközelebbi tank a listából a ponttól `reach` méteren belül (−1: nincs ilyen). */
  private nearest(list: readonly TankState[], x: number, y: number, reach: number): number {
    let best = -1;
    let bestDist = reach;
    for (const t of list) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < bestDist) {
        bestDist = d;
        best = t.id;
      }
    }
    return best;
  }

  /** A túl közel merészkedő játékosok (a botok nem: őket csak akkor bántják, ha támadtak). */
  private intruders(x: number, y: number, reach: number): TankState[] {
    return this.world.tanks.filter((t) => t.alive && !t.bot && t.cloak === 0 && Math.hypot(t.x - x, t.y - y) < reach);
  }

  /** Hol áll most a boss (ha él), különben a tanya közepe. */
  private center(): { x: number; y: number } {
    return this.boss ?? this.lair ?? { x: 0, y: 0 };
  }

  private bossPost(): BotPost {
    return {
      chase: false,
      speed: BOSS.bossSpeed,
      home: () => {
        // időnként új helyet választ a tanyán belül (ahová a közepéből rálát)
        const lair = this.lair ?? this.center();
        if (this.clock >= this.wander.until) {
          this.wander.until = this.clock + BOSS.wanderEvery;
          for (let k = 0; k < 6; k++) {
            const a = this.world.rnd() * Math.PI * 2;
            const r = this.world.rnd() * BOSS.wander;
            const x = lair.x + Math.cos(a) * r;
            const y = lair.y + Math.sin(a) * r;
            if (!this.world.terrain.walls.raycast(lair.x, lair.y, x, y) && this.room(x, y) >= 6) {
              this.wander.x = x;
              this.wander.y = y;
              break;
            }
          }
        }
        return this.wander;
      },
      target: () => {
        const boss = this.boss;
        if (!boss) return -1;
        // aki megtámadta a falkát (lőtávon belül), különben aki túl közel jött
        const attacker = this.nearest(this.threats(), boss.x, boss.y, 160);
        return attacker >= 0 ? attacker : this.nearest(this.intruders(boss.x, boss.y, BOSS.defend), boss.x, boss.y, BOSS.defend);
      },
    };
  }

  /**
   * A testőr helye a boss körül. Riadókor minden második (a boss két ellentétes oldaláról, hogy ne
   * torlódjanak össze) üldöz – összesen BOSS.chasers –, a többi a bossnál marad.
   */
  private guardPost(slot: number): BotPost {
    const chaser = slot % Math.max(1, Math.round(BOSS.guards / BOSS.chasers)) === 0;
    return {
      chase: true,
      speed: BOSS.guardSpeed,
      home: () => {
        const c = this.center();
        const a = (slot / BOSS.guards) * Math.PI * 2 + this.clock * 0.04;
        return { x: c.x + Math.cos(a) * BOSS.ring, y: c.y + Math.sin(a) * BOSS.ring };
      },
      target: () => {
        const lair = this.lair;
        if (!lair) return -1;
        const threats = this.threats().filter((t) => Math.hypot(t.x - lair.x, t.y - lair.y) < BOSS.leash);
        const c = this.center();
        if (chaser) {
          // az üldöző a legutóbbi támadóra megy (amíg az a tanya közelében van)
          if (threats.length) return threats[0].id;
        } else {
          // a bossnál maradó csak a közelébe jövő támadót támadja
          const near = this.nearest(threats, c.x, c.y, BOSS.guardDefend);
          if (near >= 0) return near;
        }
        return this.nearest(this.intruders(c.x, c.y, BOSS.defend), c.x, c.y, BOSS.defend);
      },
    };
  }
}
