// Felvehető tárgyak, lövedékfajták, olajfolt, sebzés és botok – a szimuláció szintjén.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GameMap, pointInPolygon } from '../src/game/maps/GameMap';
import type { MapData } from '../src/game/maps/types';
import { packBullet, unpackBullet } from '../src/game/net/protocol';
import { TURRET } from '../src/game/sim/vehicles';
import { BOT, BotBrain, BotManager, botTuning } from '../src/game/sim/bots';
import { SegmentGrid } from '../src/game/sim/collision';
import { BOOST, LASER, mulberry32, OIL, PICKUP, PICKUP_KINDS, pickKind, PICKUPS, ROCKET } from '../src/game/sim/pickups';
import { FELLABLE, Fellables } from '../src/game/sim/props';
import {
  BOOSTER,
  BOT_POWER,
  botRules,
  BULLET,
  DAMAGE,
  LEVEL,
  SHOT_RANGE,
  SIM_DT,
  SPAWN_ANGLE,
  TANK,
  tankMaxHp,
  tankRadius,
  tankSize,
  tankTier,
  killGain,
  TEAM,
  World,
  WRECK,
  wreckRadius,
  type SimEvent,
  type TankInput,
  type Terrain,
} from '../src/game/sim/world';

function arena(size = 400, extra: Partial<Terrain> = {}): Terrain {
  return { width: size, height: size, walls: new SegmentGrid(size, size), speedFactor: () => 1, ...extra };
}
const idle: TankInput = { throttle: 0, turn: 0, aim: null, fire: false, drop: false };

/** Lépteti a világot; a megadott tankok bemenetét kapja, és összegyűjti az eseményeket. */
function run(world: World, inputs: Record<number, Partial<TankInput>>, steps: number): SimEvent[] {
  const map = new Map<number, TankInput>(Object.entries(inputs).map(([id, input]) => [Number(id), { ...idle, ...input }]));
  const events: SimEvent[] = [];
  for (let i = 0; i < steps; i++) {
    world.step(map);
    events.push(...world.events);
  }
  return events;
}
const seconds = (s: number): number => Math.round(s / SIM_DT);
type Tank = ReturnType<World['addTank']>;
/** A tank felveszi a megadott tárgyat (a tárgyak felvétele a lépés végén történik). */
function give(world: World, tank: Tank, kind: (typeof PICKUP_KINDS)[number]): void {
  world.addPickup(kind, tank.x, tank.y);
  world.step(new Map());
}

describe('felvehető tárgyak', () => {
  it('a tank érintésre felveszi, a hatás életbe lép, a tárgy eltűnik', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 100, 0);
    world.addPickup('speed', 110, 100);
    const events = run(world, { [tank.id]: { throttle: 1 } }, seconds(1));
    expect(world.pickups).toHaveLength(0);
    expect(events.some((e) => e.type === 'pickup' && e.kind === 'speed' && e.tank === tank.id)).toBe(true);
    expect(tank.effects.speed).toBeGreaterThan(PICKUPS.speed.duration - 1.1);
  });

  it('az időzített hatás lejár', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 100, 0);
    world.addPickup('rapid', 100, 100);
    run(world, {}, 2);
    expect(tank.effects.rapid).toBeGreaterThan(0);
    run(world, {}, seconds(PICKUPS.rapid.duration) + 2);
    expect(tank.effects.rapid).toBe(0);
  });

  it('turbó: nagyobb a végsebesség; terepjáró lánctalp: terepen sem lassul', () => {
    const world = new World(arena(4000, { speedFactor: () => 0.5 }));
    const tank = world.addTank(500, 2000, 0);
    run(world, { [tank.id]: { throttle: 1 } }, seconds(2));
    expect(tank.speed).toBeCloseTo(TANK.maxSpeed * 0.5, 1);
    world.addPickup('allTerrain', tank.x, tank.y);
    run(world, { [tank.id]: { throttle: 1 } }, seconds(2));
    expect(tank.speed).toBeCloseTo(TANK.maxSpeed, 1);
    world.addPickup('speed', tank.x, tank.y);
    run(world, { [tank.id]: { throttle: 1 } }, seconds(2));
    expect(tank.speed).toBeCloseTo(TANK.maxSpeed * BOOST.speed, 1);
  });

  it('a pajzs töltetekben gyűlik, legfeljebb a megengedett számig', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 100, 0);
    for (let i = 0; i < PICKUP.maxShield + 2; i++) {
      world.addPickup('shield', 100, 100);
      run(world, {}, 1);
    }
    expect(tank.shield).toBe(PICKUP.maxShield);
  });

  it('a felvett tárgy helyett idővel új jelenik meg máshol', () => {
    let n = 0;
    const world = new World(arena(400, { pickupSpot: () => ({ x: 200 + (n++ % 5) * 30, y: 300 }) }));
    const tank = world.addTank(100, 100, 0);
    world.addPickup('radar', 100, 100);
    run(world, {}, 2);
    expect(world.pickups).toHaveLength(0);
    run(world, {}, seconds(PICKUP.respawnDelay) + 2);
    expect(world.pickups).toHaveLength(1);
    expect(tank.effects.radar).toBeGreaterThan(0);
  });

  it('javítókészlet: azonnal életerőt ad vissza, de a felső határ fölé nem', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 100, 0);
    tank.hp = 30;
    give(world, tank, 'repair');
    expect(tank.hp).toBe(30 + PICKUP.repairAmount);
    give(world, tank, 'repair');
    expect(tank.hp).toBe(TANK.maxHp);
  });

  it('minden tárgytípushoz tartozik szabály', () => {
    // a szupertárgy véletlenül nem kerül a pályára (a súlya 0): a meccs rakja ki időnként
    for (const kind of PICKUP_KINDS) if (kind !== 'super') expect(PICKUPS[kind].weight).toBeGreaterThan(0);
  });

  it('a javítókészlet a leggyakoribb tárgy: nagyjából minden ötödik az', () => {
    for (const kind of PICKUP_KINDS) if (kind !== 'repair') expect(PICKUPS.repair.weight).toBeGreaterThan(PICKUPS[kind].weight * 2);
    const random = PICKUP_KINDS.filter((kind) => kind !== 'super');
    const rnd = mulberry32(7);
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const kind = pickKind(rnd);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const share = (counts.get('repair') ?? 0) / 4000;
    expect(share).toBeGreaterThan(0.16);
    expect(share).toBeLessThan(0.23);
    // a többi tárgyból is marad
    for (const kind of random) expect(counts.get(kind) ?? 0).toBeGreaterThan(60);
  });
});

describe('lövedékfajták', () => {
  it('hármas lövés: egyszerre három lövedék legyezőben', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 200, 0);
    give(world, tank, 'triple');
    run(world, { [tank.id]: { fire: true, aim: 0 } }, 2);
    expect(world.bullets).toHaveLength(3);
    const angles = world.bullets.map((b) => Math.atan2(b.vy, b.vx)).sort((a, b) => a - b);
    expect(angles[0]).toBeCloseTo(-BOOST.tripleSpread, 5);
    expect(angles[2]).toBeCloseTo(BOOST.tripleSpread, 5);
  });

  it('gyorstöltő: ugyanannyi idő alatt jóval több lövés', () => {
    const shots = (kind: 'rapid' | null): number => {
      const world = new World(arena(2000));
      const tank = world.addTank(100, 1000, 0);
      if (kind) give(world, tank, kind);
      return run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(2)).filter((e) => e.type === 'shot').length;
    };
    expect(shots('rapid')).toBeGreaterThan(shots(null) * 2);
  });

  it('nehéz lövedék: nehézként csapódik be', () => {
    const terrain = arena();
    terrain.walls.addSegment(160, 0, 160, 400);
    const world = new World(terrain);
    const tank = world.addTank(100, 200, 0);
    give(world, tank, 'heavy');
    const events = run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(1));
    expect(events.some((e) => e.type === 'impact' && e.kind === 'heavy')).toBe(true);
  });

  it('pattanó lövedék: a falról visszaverődik, mielőtt robbanna', () => {
    const terrain = arena();
    terrain.walls.addSegment(160, 0, 160, 400);
    const world = new World(terrain);
    const tank = world.addTank(100, 200, 0);
    give(world, tank, 'ricochet');
    // egyetlen lövés, aztán figyeljük a pattanást
    const events = [...run(world, { [tank.id]: { fire: true, aim: 0.3 } }, 4), ...run(world, {}, 56)];
    expect(events.filter((e) => e.type === 'ricochet').length).toBeGreaterThan(0);
    // a visszapattant lövedék nyugat felé repül tovább
    expect(world.bullets.some((b) => b.vx < 0)).toBe(true);
  });

  it('rakéta: lassan indul, felgyorsul, és legfeljebb a lőtávolságig jut', () => {
    const world = new World(arena(4000));
    const tank = world.addTank(100, 2000, 0);
    give(world, tank, 'rocket');
    run(world, { [tank.id]: { fire: true, aim: 0 } }, 2);
    const rocket = world.bullets[0];
    expect(rocket.kind).toBe('rocket');
    expect(Math.hypot(rocket.vx, rocket.vy)).toBeLessThan(BULLET.speed);
    run(world, {}, seconds(0.7));
    expect(Math.hypot(rocket.vx, rocket.vy)).toBeCloseTo(ROCKET.maxSpeed, 1);
    let far = 0;
    for (let i = 0; i < seconds(1) && world.bullets.includes(rocket); i++) {
      far = rocket.x - 100;
      run(world, {}, 1);
    }
    expect(world.bullets.includes(rocket)).toBe(false);
    expect(far).toBeGreaterThan(SHOT_RANGE - 10);
    // a tank közepétől mérve: a cső vége néhány méterrel előrébb van
    expect(far).toBeLessThanOrEqual(SHOT_RANGE + 5);
  });

  it('egyik fegyver sem lő a képernyőn túlra (kb. 80 m)', () => {
    const reach = (kind: 'shell' | 'heavy' | 'rocket'): number => {
      const world = new World(arena(4000));
      const tank = world.addTank(100, 2000, 0);
      if (kind !== 'shell') give(world, tank, kind);
      run(world, { [tank.id]: { fire: true, aim: 0 } }, 1);
      const shot = world.bullets[0];
      let far = 0;
      for (let i = 0; i < seconds(4) && world.bullets.includes(shot); i++) {
        far = Math.max(far, shot.x - 100);
        run(world, {}, 1);
      }
      return far;
    };
    for (const kind of ['shell', 'heavy', 'rocket'] as const) {
      const far = reach(kind);
      expect(far, kind).toBeLessThanOrEqual(SHOT_RANGE + 5);
      expect(far, kind).toBeGreaterThan(SHOT_RANGE - 12);
    }
    expect(LASER.range).toBeLessThanOrEqual(SHOT_RANGE);
  });

  it('lézer: nincs lövedék, a sugár azonnal az első falig ér', () => {
    const terrain = arena();
    terrain.walls.addSegment(160, 0, 160, 400);
    const world = new World(terrain);
    const tank = world.addTank(100, 200, 0);
    give(world, tank, 'laser');
    const events = run(world, { [tank.id]: { fire: true, aim: 0 } }, 2);
    const beam = events.find((e) => e.type === 'laser');
    expect(beam && beam.type === 'laser' && beam.x2).toBeCloseTo(160, 3);
    expect(world.bullets).toHaveLength(0);
  });
});

describe('olajfolt', () => {
  it('a tárgy tölteteket ad, a lerakott folt a tank mögé kerül', () => {
    const world = new World(arena());
    const tank = world.addTank(200, 200, 0);
    world.addPickup('oil', 200, 200);
    run(world, {}, 1);
    expect(tank.oil).toBe(PICKUP.oilPerPickup);
    run(world, { [tank.id]: { drop: true } }, 1);
    expect(tank.oil).toBe(PICKUP.oilPerPickup - 1);
    expect(world.oils).toHaveLength(1);
    expect(world.oils[0].x).toBeLessThan(tank.x - TANK.radius);
  });

  it('a ráhajtó másik tank megcsúszik: sodródik és pörög, a kormány nem hat', () => {
    const world = new World(arena(1000));
    const owner = world.addTank(500, 500, 0);
    world.addPickup('oil', 500, 500);
    run(world, { [owner.id]: { drop: true } }, 2);
    const oil = world.oils[0];
    const victim = world.addTank(oil.x - 56.6 - OIL.radius, oil.y, 0, { team: TEAM.bots });
    const events = run(world, { [victim.id]: { throttle: 1 } }, seconds(4.2));
    expect(events.some((e) => e.type === 'slip' && e.tank === victim.id)).toBe(true);
    expect(victim.slip).toBeGreaterThan(0);
    const angleBefore = victim.hullAngle;
    const yBefore = victim.y;
    run(world, { [victim.id]: { throttle: 1, turn: 0 } }, 20);
    expect(Math.abs(victim.hullAngle - angleBefore)).toBeGreaterThan(0.5); // pörög
    expect(Math.abs(victim.y - yBefore)).toBeLessThan(0.5); // de az eredeti irányban sodródik tovább
    run(world, {}, seconds(OIL.slipTime) + 5);
    expect(victim.slip).toBe(0);
  });

  it('aki belehajt, annak olajos lesz a lánctalpa: a folt után is kipörög még pár másodpercig', () => {
    const world = new World(arena(1000));
    const owner = world.addTank(500, 500, 0);
    world.addPickup('oil', 500, 500);
    run(world, { [owner.id]: { drop: true } }, 2);
    const oil = world.oils[0];
    // lassan (a megcsúszás határa alatt) gurul bele: nem csúszik meg, de olajos lesz
    const victim = world.addTank(oil.x - OIL.radius - 3, oil.y, 0, { team: TEAM.bots });
    const events = run(world, { [victim.id]: { throttle: (OIL.minSpeed - 1) / TANK.maxSpeed } }, seconds(2.5));
    expect(Math.hypot(victim.x - oil.x, victim.y - oil.y)).toBeLessThan(OIL.radius);
    expect(events.some((e) => e.type === 'slip' && e.tank === victim.id)).toBe(false);
    expect(victim.oily).toBeGreaterThan(OIL.spinTime - 0.2);
    // teljes gázzal is csak a végsebesség töredékét éri el, és lassan gyorsul
    victim.x = oil.x + OIL.radius + 30;
    victim.speed = 0;
    victim.oily = OIL.spinTime;
    run(world, { [victim.id]: { throttle: 1 } }, seconds(1));
    expect(victim.speed).toBeLessThan(TANK.maxSpeed * OIL.spinSpeed + 0.01);
    const clean = world.addTank(victim.x, victim.y + 100, 0, { team: TEAM.bots });
    run(world, { [clean.id]: { throttle: 1 } }, seconds(1));
    expect(clean.speed).toBeGreaterThan(victim.speed * 1.5);
    // nehezen áll meg: a gázt elengedve tovább csúszik, mint a tiszta lánctalpú
    victim.oily = OIL.spinTime;
    victim.speed = 5;
    clean.speed = 5;
    run(world, {}, seconds(0.1));
    expect(victim.speed).toBeGreaterThan(clean.speed);
    // pár másodperc alatt lekopik: újra teljes sebességgel megy
    run(world, { [victim.id]: { throttle: 1 } }, seconds(OIL.spinTime + 6));
    expect(victim.oily).toBe(0);
    expect(victim.speed).toBeGreaterThan(TANK.maxSpeed * 0.95);
    // a terepjáró lánctalp megvéd
    const grippy = world.addTank(oil.x, oil.y, 0, { team: TEAM.bots });
    grippy.effects.allTerrain = 10;
    run(world, {}, 3);
    expect(grippy.oily).toBe(0);
  });

  it('a lerakóját csak azután csúsztatja meg, hogy egyszer lehajtott róla', () => {
    const world = new World(arena(1000));
    const tank = world.addTank(500, 500, 0);
    world.addPickup('oil', 500, 500);
    run(world, { [tank.id]: { drop: true } }, 2);
    expect(world.oils[0].ownerSafe).toBe(true);
    run(world, { [tank.id]: { throttle: 1 } }, seconds(2));
    expect(tank.slip).toBe(0);
    expect(world.oils[0].ownerSafe).toBe(false);
  });

  it('terepjáró lánctalppal nem csúszik meg, és a folt idővel eltűnik', () => {
    const world = new World(arena(1000));
    const owner = world.addTank(500, 500, 0);
    world.addPickup('oil', 500, 500);
    run(world, { [owner.id]: { drop: true } }, 2);
    const oil = world.oils[0];
    const other = world.addTank(oil.x - 40, oil.y, 0, { team: TEAM.bots });
    world.addPickup('allTerrain', other.x, other.y);
    const events = run(world, { [other.id]: { throttle: 1 } }, seconds(4));
    expect(events.some((e) => e.type === 'slip')).toBe(false);
    run(world, {}, seconds(OIL.life));
    expect(world.oils).toHaveLength(0);
  });
});

describe('sebzés', () => {
  /** Két tank egymással szemben, 40 m-re; a lövő a célpontra céloz. */
  function duel(targetTeam: number): { world: World; shooter: ReturnType<World['addTank']>; target: ReturnType<World['addTank']> } {
    const world = new World(arena());
    const shooter = world.addTank(100, 200, 0, { team: TEAM.player });
    const target = world.addTank(140, 200, Math.PI, { team: targetTeam });
    return { world, shooter, target };
  }

  it('az ellenséges tankot a találat sebzi', () => {
    const { world, shooter, target } = duel(TEAM.bots);
    const events = [...run(world, { [shooter.id]: { fire: true, aim: 0 } }, 2), ...run(world, {}, 40)];
    expect(target.hp).toBe(TANK.maxHp - DAMAGE.shell);
    expect(events.some((e) => e.type === 'hit' && e.tank === target.id && e.absorbed === null)).toBe(true);
  });

  it('az azonos csapatbeliek nem sebzik egymást: a lövedék átmegy rajtuk', () => {
    const { world, shooter, target } = duel(TEAM.player);
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, 2);
    run(world, {}, 40);
    expect(target.hp).toBe(TANK.maxHp);
  });

  it('a pajzs egy találatot elnyel, a sebezhetetlenség mindet', () => {
    const { world, shooter, target } = duel(TEAM.bots);
    target.shield = 1;
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, 2);
    run(world, {}, 40);
    expect(target.hp).toBe(TANK.maxHp);
    expect(target.shield).toBe(0);
    target.effects.invulnerable = 10;
    const events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(2));
    expect(target.hp).toBe(TANK.maxHp);
    expect(events.some((e) => e.type === 'hit' && e.absorbed === 'invulnerable')).toBe(true);
  });

  it('a kilőtt tank eltűnik, a lövő pontot kap, majd a tank teljes életerővel újraéled', () => {
    const { world, shooter, target } = duel(TEAM.bots);
    const events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(4.5));
    expect(events.some((e) => e.type === 'destroyed' && e.tank === target.id && e.by === shooter.id)).toBe(true);
    expect(target.alive).toBe(false);
    expect(shooter.kills).toBe(1);
    expect(target.deaths).toBe(1);
    run(world, {}, seconds(TANK.respawnDelay) + 2);
    expect(target.alive).toBe(true);
    expect(target.hp).toBe(TANK.maxHp);
    expect(target.effects.invulnerable).toBeGreaterThan(0); // rövid védelem újraéledés után
  });

  it('a lézer és a rakéta is sebez; a rakéta robbanása a közelben állót is', () => {
    const laser = duel(TEAM.bots);
    give(laser.world, laser.shooter, 'laser');
    run(laser.world, { [laser.shooter.id]: { fire: true, aim: 0 } }, 2);
    expect(laser.target.hp).toBe(TANK.maxHp - DAMAGE.laser);

    const rocket = duel(TEAM.bots);
    const bystander = rocket.world.addTank(140, 200 + TANK.radius * 2 + 1, 0, { team: TEAM.bots });
    give(rocket.world, rocket.shooter, 'rocket');
    run(rocket.world, { [rocket.shooter.id]: { fire: true, aim: 0 } }, 2);
    run(rocket.world, {}, 60);
    expect(rocket.target.hp).toBe(TANK.maxHp - DAMAGE.rocket);
    expect(bystander.hp).toBe(TANK.maxHp - DAMAGE.splash);
  });

  it('a tankok nem csúsznak egymásba', () => {
    const world = new World(arena());
    const a = world.addTank(100, 200, 0);
    const b = world.addTank(120, 200, Math.PI, { team: TEAM.bots });
    run(world, { [a.id]: { throttle: 1 }, [b.id]: { throttle: 1 } }, seconds(3));
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(TANK.radius * 2 - 0.01);
  });
});

describe('botok', () => {
  /** A bot és a játékos egy üres pályán; a bot bemenetét az agya adja. */
  function withBot(wall: boolean): { world: World; player: ReturnType<World['addTank']>; bot: ReturnType<World['addTank']>; events: SimEvent[] } {
    const terrain = arena();
    if (wall) terrain.walls.addSegment(145, 0, 145, 400);
    const world = new World(terrain);
    const player = world.addTank(170, 200, 0, { team: TEAM.player });
    const bot = world.addTank(120, 200, Math.PI / 2, { team: TEAM.bots, bot: true });
    const brain = new BotBrain(world, bot.id);
    const inputs = new Map<number, TankInput>();
    const events: SimEvent[] = [];
    for (let i = 0; i < seconds(5); i++) {
      inputs.set(bot.id, brain.update(SIM_DT));
      world.step(inputs);
      events.push(...world.events);
    }
    return { world, player, bot, events };
  }

  it('ha meglátja a játékost, ráfordítja a tornyát, lő és sebez', () => {
    const { player, bot, events } = withBot(false);
    expect(events.some((e) => e.type === 'shot' && e.tank === bot.id)).toBe(true);
    expect(player.hp).toBeLessThan(TANK.maxHp);
  });

  it('ha fal takarja a játékost, nem veszi észre és nem lő', () => {
    const { player, bot, events } = withBot(true);
    expect(events.some((e) => e.type === 'shot' && e.tank === bot.id)).toBe(false);
    expect(player.hp).toBe(TANK.maxHp);
  });

  it('a képernyőn kívülről nem lő: csak ha ő maga is rajta van a célpont képernyőjén', () => {
    // a bot 60 m-rel a játékos fölött áll, szabad rálátással: észreveszi, de onnan nem lő
    const shotsFrom = (dy: number, dx = 0): number => {
      const world = new World(arena(1000));
      const player = world.addTank(500 + dx, 500 + dy, 0, { team: TEAM.player });
      const bot = world.addTank(500, 500, Math.PI / 2, { team: TEAM.bots, bot: true });
      const brain = new BotBrain(world, bot.id, botTuning(5, 5));
      const inputs = new Map<number, TankInput>();
      let shots = 0;
      for (let i = 0; i < seconds(2.5); i++) {
        inputs.set(bot.id, brain.update(SIM_DT));
        // a bot ne jusson közelebb: csak a tüzelést figyeljük
        inputs.get(bot.id)!.throttle = 0;
        world.step(inputs);
        shots += world.events.filter((e) => e.type === 'shot' && e.tank === bot.id).length;
        player.x = 500 + dx;
        player.y = 500 + dy;
      }
      return shots;
    };
    expect(shotsFrom(60)).toBe(0);
    expect(shotsFrom(-60)).toBe(0);
    expect(shotsFrom(0, 95)).toBe(0);
    expect(shotsFrom(30)).toBeGreaterThan(0);
    expect(shotsFrom(0, 60)).toBeGreaterThan(0);
  });

  it('a botok egymást nem bántják', () => {
    const world = new World(arena());
    const a = world.addTank(150, 200, 0, { team: TEAM.bots, bot: true });
    const b = world.addTank(190, 200, Math.PI, { team: TEAM.bots, bot: true });
    const brains = [new BotBrain(world, a.id), new BotBrain(world, b.id)];
    const inputs = new Map<number, TankInput>();
    const events: SimEvent[] = [];
    for (let i = 0; i < seconds(6); i++) {
      for (const brain of brains) inputs.set(brain.tankId, brain.update(SIM_DT));
      world.step(inputs);
      events.push(...world.events);
    }
    expect(events.some((e) => e.type === 'shot')).toBe(false);
    expect(a.hp).toBe(TANK.maxHp);
    expect(b.hp).toBe(TANK.maxHp);
  });

  it('a bot lassabban tüzel, mint amennyit a fegyver engedne', () => {
    expect(BOT.fireInterval).toBeGreaterThan(TANK.fireCooldown * 2);
  });

  it('járőrözés közben követi az utat', () => {
    // egyenes, kelet–nyugati út az y = 200 vonalon
    const terrain = arena(1000, { roadGuide: (x) => ({ x, y: 200, angle: 0, width: 10 }) });
    const world = new World(terrain);
    const bot = world.addTank(100, 215, 0.4, { team: TEAM.bots, bot: true });
    const brain = new BotBrain(world, bot.id);
    const inputs = new Map<number, TankInput>();
    for (let i = 0; i < seconds(8); i++) {
      inputs.set(bot.id, brain.update(SIM_DT));
      world.step(inputs);
    }
    expect(bot.x).toBeGreaterThan(160);
    expect(Math.abs(bot.y - 200)).toBeLessThan(6); // az úton, a jobb oldali sávban
  });

  it('a botok száma futás közben növelhető és csökkenthető', () => {
    let n = 0;
    const world = new World(arena(2000, { pickupSpot: () => ({ x: 300 + (n++ % 40) * 40, y: 1500 }) }));
    world.addTank(100, 100, 0, { team: TEAM.player });
    const bots = new BotManager(world);
    bots.setCount(5, TEAM.bots, TEAM.player);
    expect(bots.count).toBe(5);
    expect(world.tanks.filter((t) => t.bot)).toHaveLength(5);
    bots.setCount(2, TEAM.bots, TEAM.player);
    expect(world.tanks.filter((t) => t.bot)).toHaveLength(2);
    bots.setCount(0, TEAM.bots, TEAM.player);
    expect(world.tanks).toHaveLength(1);
  });
});

describe('a valódi pályán', () => {
  const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;
  const map = new GameMap(data);

  it('a tárgyak közúton, akadálytól szabad helyen jelennek meg, egymástól távol', () => {
    const world = new World(map, 7);
    const spawn = map.spawnPoint();
    world.addTank(spawn.x, spawn.y, spawn.angle);
    world.scatterPickups(70, { x: spawn.x, y: spawn.y, radius: 260, count: 8 });
    expect(world.pickups.length).toBeGreaterThanOrEqual(65);
    const near = world.pickups.filter((p) => Math.hypot(p.x - spawn.x, p.y - spawn.y) <= 260);
    expect(near.length).toBeGreaterThanOrEqual(8);
    for (const p of world.pickups) {
      expect(map.nearestRoad(p.x, p.y, 8, true), `tárgy (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`).not.toBeNull();
      expect(map.walls.resolveCircle(p.x, p.y, 1.5).hit).toBe(false);
    }
    for (let i = 0; i < world.pickups.length; i++) {
      for (let j = i + 1; j < world.pickups.length; j++) {
        const a = world.pickups[i];
        const b = world.pickups[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(PICKUP.minGap - 0.01);
      }
    }
    // többféle tárgy van a pályán
    expect(new Set(world.pickups.map((p) => p.kind)).size).toBeGreaterThanOrEqual(8);
  });

  it('száz bot és 350 tárgy is elfér a pályán, és a szimuláció bírja', () => {
    const world = new World(map, 23);
    const spawn = map.spawnPoint();
    const player = world.addTank(spawn.x, spawn.y, spawn.angle, { team: TEAM.player });
    const bots = new BotManager(world);
    bots.setCount(100, TEAM.bots, TEAM.player);
    expect(bots.count).toBe(100);
    // egyik bot sem a játékos orra előtt jelenik meg
    for (const bot of world.tanks.filter((t) => t.bot)) {
      expect(Math.hypot(bot.x - player.x, bot.y - player.y)).toBeGreaterThanOrEqual(140);
    }
    world.scatterPickups(350, { x: spawn.x, y: spawn.y, radius: 300, count: 24 });
    expect(world.pickups.length).toBeGreaterThanOrEqual(330);
    expect(world.pickups.filter((p) => Math.hypot(p.x - spawn.x, p.y - spawn.y) <= 300).length).toBeGreaterThanOrEqual(24);

    const inputs = new Map<number, TankInput>();
    const steps = seconds(20);
    const started = performance.now();
    for (let i = 0; i < steps; i++) {
      bots.update(inputs, SIM_DT);
      world.step(inputs);
    }
    const msPerStep = (performance.now() - started) / steps;
    console.log(`100 bot, 350 tárgy: ${msPerStep.toFixed(2)} ms / szimulációs lépés`);
    // 60 lépés/mp mellett egy lépésre 16,7 ms jut; ennek a töredékét használhatja
    expect(msPerStep).toBeLessThan(6);
    expect(world.tanks.filter((t) => t.bot)).toHaveLength(100);
  });

  it('a botok egy percig járőrözve a pályán és az épületeken kívül maradnak, és haladnak', () => {
    const world = new World(map, 11);
    const spawn = map.spawnPoint();
    world.addTank(spawn.x, spawn.y, spawn.angle, { team: TEAM.player });
    const bots = new BotManager(world);
    bots.setCount(8, TEAM.bots, TEAM.player);
    const start = world.tanks.filter((t) => t.bot).map((t) => ({ id: t.id, x: t.x, y: t.y }));
    expect(start).toHaveLength(8);
    const inputs = new Map<number, TankInput>();
    const travelled = new Map<number, number>(start.map((s) => [s.id, 0]));
    for (let i = 0; i < seconds(60); i++) {
      const before = world.tanks.map((t) => [t.id, t.x, t.y] as const);
      bots.update(inputs, SIM_DT);
      world.step(inputs);
      for (const [id, x, y] of before) {
        const t = world.tank(id);
        if (t && travelled.has(id)) travelled.set(id, travelled.get(id)! + Math.hypot(t.x - x, t.y - y));
      }
    }
    for (const bot of world.tanks.filter((t) => t.bot)) {
      expect(bot.x).toBeGreaterThanOrEqual(TANK.radius - 1e-6);
      expect(bot.x).toBeLessThanOrEqual(map.width - TANK.radius + 1e-6);
      expect(bot.y).toBeGreaterThanOrEqual(TANK.radius - 1e-6);
      expect(bot.y).toBeLessThanOrEqual(map.height - TANK.radius + 1e-6);
      const nearby = map.buildingIndex.query(bot.x, bot.y, bot.x, bot.y).map((n) => data.buildings[n]);
      expect(nearby.some((b) => pointInPolygon(bot.x, bot.y, b.pts))).toBe(false);
    }
    const distances = [...travelled.values()];
    const moving = distances.filter((d) => d > 150).length;
    // a botok nagy többsége folyamatosan halad (nem ragad be)
    expect(moving, `megtett utak: ${distances.map((d) => d.toFixed(0)).join(', ')}`).toBeGreaterThanOrEqual(6);
  });
});

describe('kidönthető fák és oszlopok', () => {
  const withTree = (): { world: World; props: Fellables } => {
    const props = new Fellables(400, 400, [
      { x: 150, y: 200, r: 0.4, kind: FELLABLE.tree },
      { x: 153, y: 204, r: 0.4, kind: FELLABLE.tree },
      { x: 300, y: 300, r: 0.25, kind: FELLABLE.pole },
    ]);
    return { world: new World(arena(400, { fellables: props })), props };
  };

  it('a tank nem akad meg a fában: kidönti a haladás irányába, és megy tovább', () => {
    const { world, props } = withTree();
    const tank = world.addTank(120, 200, 0);
    const events = run(world, { [tank.id]: { throttle: 1 } }, seconds(4));
    expect(props.fallen[0]).toBe(1);
    expect(props.angle[0]).toBeCloseTo(0, 2);
    expect(events.some((e) => e.type === 'felled' && e.index === 0)).toBe(true);
    expect(tank.x).toBeGreaterThan(170); // átment rajta
    // a kidőlt fa már nem dől ki újra
    const again = run(world, { [tank.id]: { throttle: -1 } }, seconds(4));
    expect(again.some((e) => e.type === 'felled' && e.index === 0)).toBe(false);
  });

  it('a lövedék kidönti az eltalált fát, és ott robban', () => {
    const { world, props } = withTree();
    const tank = world.addTank(120, 200, 0);
    const events = [...run(world, { [tank.id]: { fire: true, aim: 0 } }, 2), ...run(world, {}, 40)];
    expect(props.fallen[0]).toBe(1);
    const impact = events.find((e) => e.type === 'impact');
    expect(impact && impact.type === 'impact' && impact.x).toBeCloseTo(150 - 0.4, 1);
  });

  it('a rakéta robbanása a közeli fákat is kidönti, a lézer az elsőt', () => {
    const rocket = withTree();
    const a = rocket.world.addTank(120, 200, 0);
    give(rocket.world, a, 'rocket');
    run(rocket.world, { [a.id]: { fire: true, aim: 0 } }, 2);
    run(rocket.world, {}, 60);
    expect(rocket.props.fallen[0]).toBe(1);
    expect(rocket.props.fallen[1]).toBe(1); // 5 m-re állt a robbanástól
    expect(rocket.props.fallen[2]).toBe(0);

    const laser = withTree();
    const b = laser.world.addTank(120, 200, 0);
    give(laser.world, b, 'laser');
    const events = run(laser.world, { [b.id]: { fire: true, aim: 0 } }, 2);
    expect(laser.props.fallen[0]).toBe(1);
    const beam = events.find((e) => e.type === 'laser');
    expect(beam && beam.type === 'laser' && beam.x2).toBeLessThan(151);
  });

  it('a sugárvetés a legközelebbi álló tárgyat találja meg', () => {
    const { props } = withTree();
    expect(props.raycast(100, 200, 200, 200)?.index).toBe(0);
    props.fell(0, 0);
    expect(props.raycast(100, 200, 200, 200)).toBeNull();
    props.reset();
    expect(props.raycast(100, 200, 200, 200)?.index).toBe(0);
  });
});

describe('gyorsító (Shift) és túlmelegedés', () => {
  it('gyorsítva 30%-kal gyorsabb, de csak 3 másodpercig; aztán túlmelegszik', () => {
    const world = new World(arena(4000));
    const tank = world.addTank(200, 2000, 0);
    run(world, { [tank.id]: { throttle: 1 } }, seconds(2));
    expect(tank.speed).toBeCloseTo(TANK.maxSpeed, 1);
    run(world, { [tank.id]: { throttle: 1, boost: true } }, seconds(2));
    expect(tank.boosting).toBe(true);
    expect(tank.speed).toBeCloseTo(TANK.maxSpeed * BOOSTER.speed, 1);
    const events = run(world, { [tank.id]: { throttle: 1, boost: true } }, seconds(1.2));
    expect(events.some((e) => e.type === 'overheat' && e.tank === tank.id)).toBe(true);
    expect(tank.overheated).toBe(true);
    // túlmelegedve hiába nyomja: visszaesik az alapsebességre
    run(world, { [tank.id]: { throttle: 1, boost: true } }, seconds(1.5));
    expect(tank.boosting).toBe(false);
    expect(tank.speed).toBeCloseTo(TANK.maxSpeed, 1);
  });

  it('lehűlés után újra használható; rövid használat nem melegíti túl', () => {
    const world = new World(arena(8000));
    const tank = world.addTank(200, 4000, 0);
    run(world, { [tank.id]: { throttle: 1, boost: true } }, seconds(BOOSTER.duration + 0.2));
    expect(tank.overheated).toBe(true);
    run(world, { [tank.id]: { throttle: 1 } }, seconds(BOOSTER.cooldown + 0.2));
    expect(tank.overheated).toBe(false);
    expect(tank.heat).toBe(0);
    run(world, { [tank.id]: { throttle: 1, boost: true } }, seconds(1));
    expect(tank.boosting).toBe(true);
    expect(tank.overheated).toBe(false);
  });
});

describe('roncsok', () => {
  it('a kilőtt tank roncsa ott marad, ahol kilőtték', () => {
    const world = new World(arena());
    const shooter = world.addTank(100, 200, 0, { team: TEAM.player });
    const target = world.addTank(140, 200, Math.PI, { team: TEAM.bots });
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(4.5));
    expect(target.alive).toBe(false);
    expect(world.wrecks).toHaveLength(1);
    expect(world.wrecks[0].x).toBeCloseTo(140, 1);
    // a tank újraéledése után is megmarad
    run(world, {}, seconds(TANK.respawnDelay + 1));
    expect(world.wrecks).toHaveLength(1);
  });

  it('a roncs akadály: a tank nem megy át rajta, a lövedék megáll benne', () => {
    const world = new World(arena());
    world.wrecks.push({ id: 999, x: 160, y: 200, hullAngle: 0, turretAngle: 0, team: TEAM.bots, level: 1, look: 0, age: 0 });
    const tank = world.addTank(120, 200, 0);
    const events = [...run(world, { [tank.id]: { fire: true, aim: 0 } }, 2), ...run(world, {}, 40)];
    const impact = events.find((e) => e.type === 'impact');
    expect(impact && impact.type === 'impact' && impact.x).toBeCloseTo(160 - WRECK.radius, 1);
    run(world, { [tank.id]: { throttle: 1 } }, seconds(4));
    expect(Math.hypot(tank.x - 160, tank.y - 200)).toBeGreaterThanOrEqual(TANK.radius + WRECK.radius - 0.01);
  });
});

describe('szintek', () => {
  it('minden kilövés után nő a szint: nagyobb a tank, több az életereje, erősebb a lövedéke', () => {
    const world = new World(arena());
    const shooter = world.addTank(100, 200, 0, { team: TEAM.player });
    const target = world.addTank(140, 200, Math.PI, { team: TEAM.bots });
    expect(shooter.level).toBe(1);
    const events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(4.5));
    expect(shooter.level).toBe(2);
    expect(events.some((e) => e.type === 'levelup' && e.tank === shooter.id && e.level === 2)).toBe(true);
    expect(tankSize(shooter)).toBeGreaterThan(tankSize(target));
    expect(tankTier(shooter.level)).toBe(0);
    expect(tankRadius(shooter)).toBeCloseTo(TANK.radius * (1 + LEVEL.size), 5);
    expect(tankMaxHp(shooter)).toBe(TANK.maxHp + LEVEL.hp);

    // a 2. szintű tank lövedéke többet sebez
    const fresh = world.addTank(100, 260, 0, { team: TEAM.bots });
    fresh.x = 140;
    fresh.y = 260;
    shooter.y = 260;
    shooter.x = 100;
    shooter.cooldown = 0;
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, 2);
    run(world, {}, 40);
    expect(fresh.hp).toBeCloseTo(TANK.maxHp - DAMAGE.shell * (1 + LEVEL.damage), 5);
  });

  it('a kilőtt tank egy szintet veszít, és a felszerelése is elvész; az új szintjéről fejlődik tovább', () => {
    const world = new World(arena());
    const veteran = world.addTank(140, 200, Math.PI, { team: TEAM.player });
    const shooter = world.addTank(100, 200, 0, { team: TEAM.bots });
    veteran.level = 7;
    veteran.hp = 20;
    veteran.weapon = 'rocket';
    veteran.tripleShots = 4;
    veteran.ricochet = true;
    veteran.oil = 2;
    veteran.turrets = 1;
    veteran.effects.rapid = 30;
    veteran.kills = 6;
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(1));
    expect(veteran.alive).toBe(false);
    // a roncs akkora, amekkora a kilőtt tank volt
    expect(world.wrecks[0].level).toBe(7);
    expect(wreckRadius(world.wrecks[0])).toBeCloseTo(WRECK.radius * tankSize({ level: 7 }), 5);
    const events = run(world, {}, seconds(TANK.respawnDelay + 0.5));
    expect(events.some((e) => e.type === 'respawn' && e.tank === veteran.id)).toBe(true);
    expect(veteran.alive).toBe(true);
    // két szintet vesztett: erről esemény is ment
    expect(veteran.level).toBe(7 - LEVEL.deathLoss);
    expect(events.length).toBeGreaterThan(0);
    expect(veteran.kills).toBe(6);
    expect(veteran.deaths).toBe(1);
    // az új szintjéhez járó teljes életerővel éled újra
    expect(veteran.hp).toBe(tankMaxHp({ level: 7 - LEVEL.deathLoss }));
    expect(veteran.hp).toBe(TANK.maxHp + (6 - LEVEL.deathLoss) * LEVEL.hp);
    // a fegyverzet és a képességek elvesznek
    expect(veteran.weapon).toBeNull();
    expect(veteran.tripleShots).toBe(0);
    expect(veteran.ricochet).toBe(false);
    expect(veteran.shield).toBe(0);
    expect(veteran.oil).toBe(0);
    // a lövegekből az alapkészlet újra jár
    expect(veteran.turrets).toBe(TURRET.base);
    expect(veteran.effects.rapid).toBe(0);
    // és a következő kilövéssel onnan lép tovább
    const victim = world.addTank(veteran.x + 30, veteran.y, 0, { team: TEAM.bots });
    victim.hp = 1;
    run(world, { [veteran.id]: { fire: true, aim: 0 } }, seconds(1.5));
    expect(veteran.level).toBe(7 - LEVEL.deathLoss + 1);
  });

  it('az 1. és a 2. szintű tank nem megy az 1. szint alá; a szintvesztésről esemény megy', () => {
    for (const [level, after, lost] of [[1, 1, 0], [2, 1, 1], [3, 2, 1], [20, 19, 1]]) {
      const world = new World(arena());
      const victim = world.addTank(140, 200, Math.PI, { team: 10 });
      const shooter = world.addTank(100, 200, 0, { team: 11 });
      victim.level = level;
      victim.hp = 1;
      const events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(1));
      expect(victim.alive).toBe(false);
      expect(victim.level).toBe(after);
      // a kilövés eseménye viszi, ki és mivel lőtte ki (itt: a másik tank ágyúja)
      expect(events.find((e) => e.type === 'destroyed')).toMatchObject({ tank: victim.id, by: shooter.id, cause: 'shell' });
      const down = events.filter((e) => e.type === 'leveldown');
      expect(down).toHaveLength(lost > 0 ? 1 : 0);
      if (lost > 0) expect(down[0]).toMatchObject({ tank: victim.id, level: after, lost });
      // a roncs akkora, amekkora a tank a kilövésekor volt
      expect(world.wrecks[0].level).toBe(level);
    }
  });

  it('nagyjából egyszintű ellenfélért egy szint jár, jóval magasabb szintűért kettő', () => {
    expect(killGain(5, 5)).toBe(1);
    expect(killGain(9, 2)).toBe(1); // gyengébb ellenfélért is jár az egy szint
    // egy-két szint különbség még „kb. egyszintű”
    expect(killGain(5, 6)).toBe(1);
    expect(killGain(5, 7)).toBe(1);
    // három vagy több szinttel erősebb ellenfélért kettő – de ennél több akkor sem
    expect(killGain(5, 8)).toBe(2);
    expect(killGain(1, 12)).toBe(2);
    expect(killGain(1, 20)).toBe(LEVEL.upsetGain);
    expect(LEVEL.upsetGap).toBe(3);
    const world = new World(arena());
    const shooter = world.addTank(100, 200, 0, { team: 10 });
    const giant = world.addTank(140, 200, Math.PI, { team: 11 });
    giant.level = 12;
    giant.hp = 1;
    shooter.level = 3;
    shooter.hp = 50;
    const events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(1));
    // 9 szint különbség: a győztes két szintet lép, a vesztes kettőt veszít
    expect(shooter.level).toBe(5);
    expect(events.find((e) => e.type === 'levelup')).toMatchObject({ tank: shooter.id, level: 5, gain: 2 });
    // a többlet életerőt minden megszerzett szint után megkapja
    expect(shooter.hp).toBe(50 + 2 * LEVEL.hp);
    expect(giant.level).toBe(12 - LEVEL.deathLoss);
    // két egyszintű tank: a győztes egyet lép, a vesztes egyet bukik
    const even = new World(arena());
    const winner = even.addTank(100, 200, 0, { team: 10 });
    const loser = even.addTank(140, 200, Math.PI, { team: 11 });
    winner.level = 6;
    loser.level = 6;
    loser.hp = 1;
    run(even, { [winner.id]: { fire: true, aim: 0 } }, seconds(1));
    expect(winner.level).toBe(7);
    expect(loser.level).toBe(6 - LEVEL.deathLoss);
    // a felső határ fölé így sem megy
    const top = world.addTank(100, 260, 0, { team: 12 });
    top.level = LEVEL.max - 1;
    const other = world.addTank(140, 260, Math.PI, { team: 13 });
    other.level = LEVEL.max;
    other.hp = 1;
    run(world, { [top.id]: { fire: true, aim: 0 } }, seconds(1));
    expect(top.level).toBe(LEVEL.max);
  });

  it('a botok kilövése lassabban fejleszt: három bot ér egy szintet', () => {
    const world = new World(arena());
    const shooter = world.addTank(100, 200, 0, { team: 10 });
    const kill = (): SimEvent[] => {
      const bot = world.addTank(shooter.x + 14, shooter.y, Math.PI, { team: TEAM.bots, bot: true });
      bot.hp = 1;
      const events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(0.7));
      expect(bot.alive).toBe(false);
      world.removeTank(bot.id);
      world.wrecks.length = 0;
      return events;
    };
    expect(kill().some((e) => e.type === 'levelup')).toBe(false);
    expect(shooter.level).toBe(1);
    expect(shooter.botKills).toBe(1);
    kill();
    expect(shooter.level).toBe(1);
    expect(shooter.botKills).toBe(2);
    expect(kill().find((e) => e.type === 'levelup')).toMatchObject({ level: 2, gain: 1 });
    expect(shooter.level).toBe(2);
    expect(shooter.botKills).toBe(0);
    expect(LEVEL.botKills).toBe(3);
    // a kilövések száma (a győzelemhez) minden botnál nő
    expect(shooter.kills).toBe(3);
    // a számláló a halál után sem vész el
    kill();
    const enemy = world.addTank(shooter.x - 12, shooter.y, 0, { team: 11 });
    shooter.hp = 1;
    run(world, { [enemy.id]: { fire: true, aim: 0 } }, seconds(0.7));
    expect(shooter.alive).toBe(false);
    expect(shooter.botKills).toBe(1);
  });

  it('a szintek hat osztályba tartoznak; osztályváltáskor a tank mérete ugrik', () => {
    expect(LEVEL.tiers).toHaveLength(6);
    expect(LEVEL.tiers[0]).toBe(1);
    expect(LEVEL.tiers[LEVEL.tiers.length - 1]).toBeLessThanOrEqual(LEVEL.max);
    expect([1, 2, 3, 5, 6, 8, 9, 11, 12, 15, 16, 20].map(tankTier)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    for (let level = 2; level <= LEVEL.max; level++) {
      const step = tankSize({ level }) - tankSize({ level: level - 1 });
      // osztályon belül egyenletesen nő, osztályváltáskor nagyobbat
      expect(step).toBeCloseTo(LEVEL.tiers.includes(level as never) ? LEVEL.size + LEVEL.tierSize : LEVEL.size, 5);
    }
    // a legnagyobb tank több mint kétszerese a kezdőnek, de még elfér egy utcában
    expect(tankSize({ level: LEVEL.max })).toBeGreaterThan(2);
    expect(tankRadius({ level: LEVEL.max })).toBeLessThan(3.8);
    // a lövedék gazdája átmegy a hálózaton: a kliens ebből tudja, mekkora tank lőtte ki
    const bullet = { id: 5, owner: 42, team: 1, kind: 'shell' as const, x: 1, y: 2, vx: 3, vy: 4, life: 1, bounces: 0 };
    expect(unpackBullet(packBullet(bullet)).owner).toBe(42);
  });

  it('a botok nem lépnek szintet', () => {
    const world = new World(arena());
    const bot = world.addTank(100, 200, 0, { team: TEAM.bots, bot: true });
    const victim = world.addTank(140, 200, Math.PI, { team: TEAM.player });
    // a bot gyengébben lő: tovább tart, mire kilövi a játékost
    run(world, { [bot.id]: { fire: true, aim: 0 } }, seconds(8));
    expect(victim.alive).toBe(false);
    expect(bot.kills).toBe(1);
    expect(bot.level).toBe(1);
  });

  it('a botok szívóssága: minél szívósabb, annál nagyobbat lő és annál erősebb a páncélja; a legszívósabb egyenrangú a játékossal', () => {
    const exchange = (toughness: number): { taken: number; dealt: number } => {
      const world = new World(arena());
      world.botRules = botRules(toughness);
      const bot = world.addTank(100, 200, 0, { team: TEAM.bots, bot: true });
      const player = world.addTank(140, 200, Math.PI, { team: TEAM.player });
      run(world, { [bot.id]: { fire: true, aim: 0 }, [player.id]: { fire: true, aim: Math.PI } }, 2);
      run(world, {}, seconds(1));
      return { taken: TANK.maxHp - player.hp, dealt: TANK.maxHp - bot.hp };
    };
    const levels = [1, 2, 3, 4, 5].map(exchange);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i].taken).toBeGreaterThan(levels[i - 1].taken);
      expect(levels[i].dealt).toBeLessThan(levels[i - 1].dealt);
    }
    expect(levels[2]).toEqual({ taken: DAMAGE.shell * BOT_POWER.damage, dealt: DAMAGE.shell * BOT_POWER.armor });
    expect(levels[4]).toEqual({ taken: DAMAGE.shell, dealt: DAMAGE.shell });
  });

  it('a nagyon és az ultra ügyes bot tárgyat vesz fel (el is megy érte) és a kilövésekkel szintet lép; az ügyesebbnél kevésbé ügyes nem', () => {
    expect(botTuning(6).aimError).toBeLessThan(botTuning(5).aimError);
    expect([botTuning(4).perks, botTuning(5).perks, botTuning(6).perks]).toEqual([false, true, true]);
    // a tárgyért elmegy, ha nincs ellenfél a közelben
    const world = new World(arena());
    world.botRules = botRules(3, 6);
    const bot = world.addTank(100, 200, 0, { team: TEAM.bots, bot: true });
    const item = world.addPickup('heavy', 100, 150);
    const brain = new BotBrain(world, bot.id, botTuning(6));
    const inputs = new Map<number, TankInput>();
    for (let i = 0; i < seconds(6) && world.pickups.includes(item); i++) {
      inputs.set(bot.id, brain.update(SIM_DT));
      world.step(inputs);
    }
    expect(world.pickups).not.toContain(item);
    expect(bot.weapon).toBe('heavy');
    // a kilövéssel szintet lép
    const duel = new World(arena());
    duel.botRules = botRules(5, 5);
    const hunter = duel.addTank(100, 200, 0, { team: TEAM.bots, bot: true });
    const victim = duel.addTank(140, 200, Math.PI, { team: TEAM.player });
    run(duel, { [hunter.id]: { fire: true, aim: 0 } }, seconds(5));
    expect(victim.alive).toBe(false);
    expect(hunter.level).toBe(2);
    // a kevésbé ügyes bot nem
    const calm = new World(arena());
    calm.botRules = botRules(5, 4);
    const plain = calm.addTank(100, 200, 0, { team: TEAM.bots, bot: true });
    const other = calm.addTank(140, 200, Math.PI, { team: TEAM.player });
    run(calm, { [plain.id]: { fire: true, aim: 0 } }, seconds(5));
    expect(other.alive).toBe(false);
    expect(plain.level).toBe(1);
  });

  it('a bot gyengébb: kisebbet sebez, nagyobbat kap, és nem vesz fel tárgyat', () => {
    // a bot lövése 15-öt visz le a játékos 1. szintű tankjáról (25 helyett)
    const one = new World(arena());
    const bot = one.addTank(100, 200, 0, { team: TEAM.bots, bot: true });
    const player = one.addTank(140, 200, Math.PI, { team: TEAM.player });
    run(one, { [bot.id]: { fire: true, aim: 0 } }, 2);
    run(one, {}, seconds(1));
    expect(player.hp).toBeCloseTo(TANK.maxHp - DAMAGE.shell * BOT_POWER.damage, 5);
    // a játékos lövése 40-et visz le a botról: öt találat elég (a játékos tankjához nyolc kell)
    const two = new World(arena());
    const shooter = two.addTank(100, 200, 0, { team: TEAM.player });
    const target = two.addTank(140, 200, Math.PI, { team: TEAM.bots, bot: true });
    run(two, { [shooter.id]: { fire: true, aim: 0 } }, 2);
    run(two, {}, seconds(1));
    expect(target.hp).toBeCloseTo(TANK.maxHp - DAMAGE.shell * BOT_POWER.armor, 5);
    expect(Math.ceil(TANK.maxHp / (DAMAGE.shell * BOT_POWER.armor))).toBe(5);
    expect(Math.ceil(TANK.maxHp / DAMAGE.shell)).toBe(8);
    expect(Math.ceil(TANK.maxHp / (DAMAGE.shell * BOT_POWER.damage))).toBe(14);
    // a bot áthajt a tárgyon, az ott marad
    const three = new World(arena());
    const roller = three.addTank(100, 200, 0, { team: TEAM.bots, bot: true });
    const item = three.addPickup('heavy', 103, 200);
    run(three, { [roller.id]: { throttle: 1 } }, seconds(1));
    expect(roller.x).toBeGreaterThan(110);
    expect(three.pickups).toContain(item);
    expect(roller.weapon).toBeNull();
  });

  it('a szint nem nő a felső határ fölé', () => {
    const world = new World(arena());
    const shooter = world.addTank(100, 200, 0, { team: TEAM.player });
    shooter.level = LEVEL.max;
    world.addTank(140, 200, Math.PI, { team: TEAM.bots });
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(3));
    expect(shooter.kills).toBe(1);
    expect(shooter.level).toBe(LEVEL.max);
  });
});

describe('a botok nem ragadnak be', () => {
  it('zsákutcából kitolat és másfelé indul', () => {
    // U alakú fal: a bot a zsák aljába néz
    const terrain = arena(400);
    terrain.walls.addSegment(200, 180, 240, 180);
    terrain.walls.addSegment(240, 180, 240, 220);
    terrain.walls.addSegment(240, 220, 200, 220);
    const world = new World(terrain);
    const bot = world.addTank(225, 200, 0, { team: TEAM.bots, bot: true });
    const brain = new BotBrain(world, bot.id);
    const inputs = new Map<number, TankInput>();
    let farthest = 0;
    for (let i = 0; i < seconds(25); i++) {
      inputs.set(bot.id, brain.update(SIM_DT));
      world.step(inputs);
      farthest = Math.max(farthest, Math.hypot(bot.x - 225, bot.y - 200));
    }
    expect(farthest).toBeGreaterThan(30);
  });

  it('a végképp beszorult bot új helyre kerül, ha nincs a közelben ellenfél', () => {
    // minden oldalról fal: innen nincs kiút
    const terrain = arena(2000, { pickupSpot: () => ({ x: 1500, y: 1500 }) });
    terrain.walls.addPolygon([195, 195, 205, 195, 205, 205, 195, 205]);
    const world = new World(terrain);
    world.addTank(1900, 100, 0, { team: TEAM.player });
    const bot = world.addTank(200, 200, 0, { team: TEAM.bots, bot: true });
    const brain = new BotBrain(world, bot.id);
    const inputs = new Map<number, TankInput>();
    for (let i = 0; i < seconds(40); i++) {
      inputs.set(bot.id, brain.update(SIM_DT));
      world.step(inputs);
    }
    expect(Math.hypot(bot.x - 200, bot.y - 200)).toBeGreaterThan(100);
  });

  it('a valódi pályán egyik bot sem áll egy helyben tartósan', () => {
    const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;
    const map = new GameMap(data);
    const world = new World(map, 31);
    // a játékos a kezdőponton áll: a botok megtalálják, üldözik, lövik
    const spawn = map.spawnPoint();
    const player = world.addTank(spawn.x, spawn.y, spawn.angle, { team: TEAM.player });
    const bots = new BotManager(world);
    bots.setCount(100, TEAM.bots, TEAM.player);
    const inputs = new Map<number, TankInput>();
    // botonként: a legutóbbi „horgony” hely és az ott töltött idő; a leghosszabb egy helyben töltött idő
    const anchor = new Map<number, { x: number; y: number; since: number; worst: number; wx: number; wy: number }>();
    for (const t of world.tanks) if (t.bot) anchor.set(t.id, { x: t.x, y: t.y, since: 0, worst: 0, wx: t.x, wy: t.y });
    let relocated = 0;
    const total = seconds(240);
    for (let i = 0; i < total; i++) {
      bots.update(inputs, SIM_DT);
      world.step(inputs);
      relocated += world.events.filter((e) => e.type === 'respawn' && e.tank !== player.id).length;
      if (i % 30 !== 0) continue;
      for (const t of world.tanks) {
        const a = anchor.get(t.id);
        if (!a) continue;
        // aki a játékos közelében van, az joggal áll és lő: az nem számít
        const fighting = Math.hypot(t.x - player.x, t.y - player.y) < BOT.sight + 10;
        if (!t.alive || fighting || Math.hypot(t.x - a.x, t.y - a.y) > 8) {
          a.x = t.x;
          a.y = t.y;
          a.since = i;
        }
        if ((i - a.since) * SIM_DT > a.worst) {
          a.worst = (i - a.since) * SIM_DT;
          a.wx = a.x;
          a.wy = a.y;
        }
      }
    }
    const ranked = [...anchor.values()].sort((a, b) => b.worst - a.worst);
    const longest = ranked[0].worst;
    console.log(
      `100 bot, 4 perc: a leghosszabb egy helyben töltött idő ${longest.toFixed(1)} mp; áthelyezés: ${relocated}; ` +
        ranked.slice(0, 6).map((a) => `${a.worst.toFixed(0)} mp @ (${a.wx.toFixed(0)}, ${a.wy.toFixed(0)})`).join(', '),
    );
    // áthelyezésre csak kivételesen van szükség
    expect(relocated).toBeLessThanOrEqual(3);
    // egyik bot sem tölt 30 másodpercnél többet 8 méteres körön belül
    expect(longest).toBeLessThan(30);
  }, 30000); // 100 bot négy percnyi szimulációja lassabb gépen tovább tart az alap 5 másodpercnél
});

describe('megmaradó fegyverek', () => {
  it('a felvett fegyver nem jár le: addig marad, amíg másikat nem vesz fel a tank', () => {
    const world = new World(arena(4000));
    const tank = world.addTank(200, 2000, 0);
    give(world, tank, 'rocket');
    expect(tank.weapon).toBe('rocket');
    run(world, {}, seconds(90)); // jóval több, mint a régi 20 másodperc
    expect(tank.weapon).toBe('rocket');
    run(world, { [tank.id]: { fire: true, aim: 0 } }, 2);
    expect(world.bullets[0].kind).toBe('rocket');
    // másik fegyver felvétele: az lép a helyére
    give(world, tank, 'laser');
    expect(tank.weapon).toBe('laser');
    give(world, tank, 'heavy');
    expect(tank.weapon).toBe('heavy');
  });

  it('a kilőtt tank újraéledve csak az alaplövedéket kapja vissza', () => {
    const world = new World(arena());
    const shooter = world.addTank(100, 200, 0, { team: TEAM.player });
    const target = world.addTank(140, 200, Math.PI, { team: TEAM.bots });
    give(world, target, 'laser');
    give(world, target, 'ricochet');
    give(world, target, 'triple');
    expect(target.weapon).toBe('laser');
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(4.5));
    expect(target.alive).toBe(false);
    run(world, {}, seconds(TANK.respawnDelay + 0.5));
    expect(target.alive).toBe(true);
    expect(target.weapon).toBeNull();
    expect(target.ricochet).toBe(false);
    expect(target.tripleShots).toBe(0);
  });

  it('a pattanó lövedék megmaradó képesség: fegyvercsere után is megvan, a nehéz lövedék is pattan', () => {
    const world = new World(arena(4000));
    const tank = world.addTank(200, 2000, 0);
    give(world, tank, 'ricochet');
    run(world, {}, seconds(60));
    expect(tank.ricochet).toBe(true);
    give(world, tank, 'heavy');
    expect(tank.ricochet).toBe(true);
    run(world, { [tank.id]: { fire: true, aim: 0 } }, 2);
    expect(world.bullets[0].kind).toBe('heavy');
    expect(world.bullets[0].bounces).toBe(BOOST.ricochetBounces);
    // a rakéta nem pattan, de a képesség megmarad mellette
    give(world, tank, 'rocket');
    tank.cooldown = 0;
    run(world, { [tank.id]: { fire: true, aim: 0 } }, 2);
    expect(world.bullets[world.bullets.length - 1].bounces).toBe(0);
    expect(tank.ricochet).toBe(true);
  });

  it('a hármas lövés lövésszámra szól, nem időre', () => {
    const world = new World(arena(4000));
    const tank = world.addTank(200, 2000, 0);
    give(world, tank, 'triple');
    expect(tank.tripleShots).toBe(PICKUP.tripleShots);
    run(world, {}, seconds(120)); // az idő múlása nem fogyasztja
    expect(tank.tripleShots).toBe(PICKUP.tripleShots);
    let volleys = 0;
    let lastTriple = 0;
    for (let i = 0; i < PICKUP.tripleShots + 3; i++) {
      tank.cooldown = 0;
      const shots = run(world, { [tank.id]: { fire: true, aim: 0 } }, 1).filter((e) => e.type === 'shot').length;
      expect(shots).toBe(1);
      const fresh = world.bullets.filter((b) => b.life > BULLET.life - 2 * SIM_DT).length;
      volleys++;
      if (fresh === 3) lastTriple = volleys;
      world.bullets.length = 0;
    }
    expect(lastTriple).toBe(PICKUP.tripleShots);
    expect(tank.tripleShots).toBe(0);
    // több tárgy összeadódik, de csak a felső határig
    for (let i = 0; i < 5; i++) give(world, tank, 'triple');
    expect(tank.tripleShots).toBe(PICKUP.maxTripleShots);
  });

  it('a lövéstől kidőlt fa eseménye jelzi, hogy lövés döntötte ki', () => {
    const props = new Fellables(400, 400, [
      { x: 150, y: 200, r: 0.4, kind: FELLABLE.tree },
      { x: 150, y: 260, r: 0.4, kind: FELLABLE.tree },
    ]);
    const world = new World(arena(400, { fellables: props }));
    const shooter = world.addTank(120, 200, 0);
    const driver = world.addTank(130, 260, 0);
    const events = [...run(world, { [shooter.id]: { fire: true, aim: 0 }, [driver.id]: { throttle: 1 } }, 2), ...run(world, { [driver.id]: { throttle: 1 } }, seconds(3))];
    const felled = events.filter((e) => e.type === 'felled');
    expect(felled.find((e) => e.type === 'felled' && e.index === 0)).toMatchObject({ shot: true });
    expect(felled.find((e) => e.type === 'felled' && e.index === 1)).toMatchObject({ shot: false });
  });
});

describe('a botok ügyessége és agresszivitása', () => {
  it('a 3-as szint az alapérték; az ügyesség a célzást és a reakciót, az agresszivitás az észlelést szabja meg', () => {
    expect(botTuning()).toMatchObject({ sight: BOT.sight, aimError: BOT.aimError, reaction: BOT.reaction, fireInterval: BOT.fireInterval, hunt: 0 });
    const weak = botTuning(1, 3);
    const sharp = botTuning(5, 3);
    expect(weak.aimError).toBeGreaterThan(sharp.aimError * 4);
    expect(weak.reaction).toBeGreaterThan(sharp.reaction * 3);
    expect(weak.fireInterval).toBeGreaterThan(sharp.fireInterval);
    const calm = botTuning(3, 1);
    const fierce = botTuning(3, 5);
    expect(calm.sight).toBeLessThan(BOT.sight);
    expect(fierce.sight).toBeGreaterThan(BOT.sight);
    expect(fierce.chaseTime).toBeGreaterThan(calm.chaseTime * 3);
    expect(fierce.keepDistance).toBeLessThan(calm.keepDistance);
    expect(calm.hunt).toBe(0);
    expect(fierce.hunt).toBeGreaterThan(1000);
    // a határokon kívüli érték a legközelebbi szintre kerül
    expect(botTuning(99, -4)).toEqual(botTuning(6, 1));
  });

  it('az ügyes bot hamarabb és pontosabban talál, mint a kezdő', () => {
    const damageAfter = (skill: number): number => {
      const world = new World(arena(), 5);
      const player = world.addTank(200, 200, 0, { team: TEAM.player });
      const bot = world.addTank(160, 200, 0, { team: TEAM.bots, bot: true });
      const brain = new BotBrain(world, bot.id, botTuning(skill, 3));
      const inputs = new Map<number, TankInput>();
      for (let i = 0; i < seconds(1.6); i++) {
        inputs.set(bot.id, brain.update(SIM_DT));
        world.step(inputs);
      }
      return TANK.maxHp - player.hp;
    };
    // 1,6 másodperc alatt a mesterlövész már többször talált, a kezdő még nem is lőtt
    expect(damageAfter(5)).toBeGreaterThanOrEqual(DAMAGE.shell);
    expect(damageAfter(1)).toBe(0);
  });

  it('az agresszív bot akkor is a játékos felé tart, ha nem látja; a békés nem', () => {
    const approach = (aggression: number): number => {
      // a játékos messze van, jóval a látótávolságon túl
      const world = new World(arena(2000), 9);
      const player = world.addTank(1500, 1000, 0, { team: TEAM.player });
      const bot = world.addTank(500, 1000, Math.PI, { team: TEAM.bots, bot: true });
      const brain = new BotBrain(world, bot.id, botTuning(3, aggression));
      const inputs = new Map<number, TankInput>();
      const before = Math.hypot(player.x - bot.x, player.y - bot.y);
      for (let i = 0; i < seconds(20); i++) {
        inputs.set(bot.id, brain.update(SIM_DT));
        world.step(inputs);
      }
      return before - Math.hypot(player.x - bot.x, player.y - bot.y);
    };
    expect(approach(5)).toBeGreaterThan(150); // közeledett
    expect(approach(1)).toBeLessThan(0); // a másik irányba járőrözött tovább
  });
});

describe('újraéledés', () => {
  it('a játékos tankja újraéledéskor a térkép teteje felé néz (a boté véletlen irányba)', () => {
    const world = new World(arena());
    const player = world.addTank(200, 200, 1.2, { team: TEAM.player });
    const killer = world.addTank(240, 200, Math.PI, { team: 20 });
    run(world, { [killer.id]: { fire: true, aim: Math.PI } }, seconds(6));
    expect(player.deaths).toBeGreaterThan(0);
    run(world, {}, seconds(TANK.respawnDelay + 0.5));
    expect(player.alive).toBe(true);
    expect(player.hullAngle).toBeCloseTo(SPAWN_ANGLE, 6);
    expect(player.turretAngle).toBeCloseTo(SPAWN_ANGLE, 6);
  });
});
