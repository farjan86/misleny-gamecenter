// Felvehető tárgyak, lövedékfajták, olajfolt, sebzés és botok – a szimuláció szintjén.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GameMap, pointInPolygon } from '../src/game/maps/GameMap';
import type { MapData } from '../src/game/maps/types';
import { BOT, BotBrain, BotManager } from '../src/game/sim/bots';
import { SegmentGrid } from '../src/game/sim/collision';
import { BOOST, LASER, OIL, PICKUP, PICKUP_KINDS, PICKUPS, ROCKET } from '../src/game/sim/pickups';
import { FELLABLE, Fellables } from '../src/game/sim/props';
import {
  BOOSTER,
  BULLET,
  DAMAGE,
  LEVEL,
  SIM_DT,
  TANK,
  tankMaxHp,
  tankRadius,
  tankSize,
  TEAM,
  World,
  WRECK,
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
    for (const kind of PICKUP_KINDS) expect(PICKUPS[kind].weight).toBeGreaterThan(0);
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

  it('rakéta: lassan indul, felgyorsul, és messzebbre jut, mint a sima lövedék', () => {
    const world = new World(arena(4000));
    const tank = world.addTank(100, 2000, 0);
    give(world, tank, 'rocket');
    run(world, { [tank.id]: { fire: true, aim: 0 } }, 2);
    const rocket = world.bullets[0];
    expect(rocket.kind).toBe('rocket');
    expect(Math.hypot(rocket.vx, rocket.vy)).toBeLessThan(BULLET.speed);
    run(world, {}, seconds(1));
    expect(Math.hypot(rocket.vx, rocket.vy)).toBeCloseTo(ROCKET.maxSpeed, 1);
    expect(rocket.x - 100).toBeGreaterThan(BULLET.speed * BULLET.life);
  });

  it('lézer: nincs lövedék, a sugár azonnal az első falig ér', () => {
    const terrain = arena();
    terrain.walls.addSegment(190, 0, 190, 400);
    const world = new World(terrain);
    const tank = world.addTank(100, 200, 0);
    give(world, tank, 'laser');
    const events = run(world, { [tank.id]: { fire: true, aim: 0 } }, 2);
    const beam = events.find((e) => e.type === 'laser');
    expect(beam && beam.type === 'laser' && beam.x2).toBeCloseTo(190, 3);
    expect(world.bullets).toHaveLength(0);
    expect(LASER.range).toBeGreaterThan(BULLET.speed * BULLET.life);
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
    const victim = world.addTank(oil.x - 60, oil.y, 0, { team: TEAM.bots });
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
    const events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(2.5));
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
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(2.5));
    expect(target.alive).toBe(false);
    expect(world.wrecks).toHaveLength(1);
    expect(world.wrecks[0].x).toBeCloseTo(140, 1);
    // a tank újraéledése után is megmarad
    run(world, {}, seconds(TANK.respawnDelay + 1));
    expect(world.wrecks).toHaveLength(1);
  });

  it('a roncs akadály: a tank nem megy át rajta, a lövedék megáll benne', () => {
    const world = new World(arena());
    world.wrecks.push({ id: 999, x: 160, y: 200, hullAngle: 0, turretAngle: 0, team: TEAM.bots, age: 0 });
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
    const events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(2.5));
    expect(shooter.level).toBe(2);
    expect(events.some((e) => e.type === 'levelup' && e.tank === shooter.id && e.level === 2)).toBe(true);
    expect(tankSize(shooter)).toBeGreaterThan(tankSize(target));
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

  it('a botok nem lépnek szintet', () => {
    const world = new World(arena());
    const bot = world.addTank(100, 200, 0, { team: TEAM.bots, bot: true });
    const victim = world.addTank(140, 200, Math.PI, { team: TEAM.player });
    run(world, { [bot.id]: { fire: true, aim: 0 } }, seconds(2.5));
    expect(victim.alive).toBe(false);
    expect(bot.kills).toBe(1);
    expect(bot.level).toBe(1);
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
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(2.5));
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
