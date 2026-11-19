// A többjátékos meccs szabályai: ledönthető épületek, játéktér, életek és
// kiesés, születési távolság, sár, létszámok a pálya méretéhez.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/game/maps/GameMap';
import type { MapData } from '../src/game/maps/types';
import { SegmentGrid } from '../src/game/sim/collision';
import { areaOfCells, gridSize, MATCH, Match, matchPlan, sanitizeSettings, type MatchSettings } from '../src/game/sim/match';
import { Structures } from '../src/game/sim/structures';
import { CRUSH, DAMAGE, SIM_DT, TANK, TEAM, World, type SimEvent, type TankInput, type Terrain } from '../src/game/sim/world';

const idle: TankInput = { throttle: 0, turn: 0, aim: null, fire: false, drop: false };
const seconds = (s: number): number => Math.round(s / SIM_DT);
function run(world: World, inputs: Record<number, Partial<TankInput>>, steps: number): SimEvent[] {
  const map = new Map<number, TankInput>(Object.entries(inputs).map(([id, input]) => [Number(id), { ...idle, ...input }]));
  const events: SimEvent[] = [];
  for (let i = 0; i < steps; i++) {
    world.step(map);
    events.push(...world.events);
  }
  return events;
}

/** Üres pálya egy 10 × 10 m-es házzal (140..150, 195..205), amelynek az életereje 100 m² alapján számolódik. */
function withHouse(extra: Partial<Terrain> = {}, indestructible = false): Terrain & { structures: Structures } {
  const walls = new SegmentGrid(400, 400);
  walls.addPolygon([140, 195, 150, 195, 150, 205, 140, 205], 0);
  const structures = new Structures([{ area: 100, x: 145, y: 200, indestructible }]);
  return { width: 400, height: 400, walls, structures, speedFactor: () => 1, ...extra };
}

describe('ledönthető épületek', () => {
  it('a találatok fogyasztják az épület életerejét; ha elfogy, összedől, és át lehet menni a helyén', () => {
    const terrain = withHouse();
    const world = new World(terrain);
    const tank = world.addTank(110, 200, 0);
    const maxHp = terrain.structures.maxHp[0];
    expect(maxHp).toBe(150); // 60 + 100 m² × 0,9
    const hitsNeeded = Math.ceil(maxHp / DAMAGE.shell);
    const events = run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(TANK.fireCooldown * (hitsNeeded - 1) + 0.2));
    expect(terrain.structures.collapsed[0]).toBe(0);
    events.push(...run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(TANK.fireCooldown + 0.6)));
    expect(terrain.structures.collapsed[0]).toBe(1);
    expect(events.filter((e) => e.type === 'collapse')).toHaveLength(1);
    // a romokon át lehet hajtani
    run(world, { [tank.id]: { throttle: 1 } }, seconds(4));
    expect(tank.x).toBeGreaterThan(155);
  });

  it('a nagyobb lövedék hamarabb dönti össze', () => {
    const shots = (weapon: 'heavy' | 'rocket' | null): number => {
      const terrain = withHouse();
      const world = new World(terrain);
      const tank = world.addTank(110, 200, 0);
      tank.weapon = weapon;
      let fired = 0;
      for (let i = 0; i < seconds(20) && !terrain.structures.collapsed[0]; i++) {
        fired += run(world, { [tank.id]: { fire: true, aim: 0 } }, 1).filter((e) => e.type === 'shot').length;
      }
      return fired;
    };
    expect(shots(null)).toBe(6);
    expect(shots('heavy')).toBe(3);
    expect(shots('rocket')).toBe(3);
  });

  it('a le nem dönthető épület (a hivatal) akárhány találat után is áll', () => {
    const terrain = withHouse({}, true);
    const world = new World(terrain);
    const tank = world.addTank(110, 200, 0);
    tank.weapon = 'rocket';
    run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(30));
    expect(terrain.structures.collapsed[0]).toBe(0);
  });

  it('a magas szintű tank az ütközésével is összedönti, az alacsony szintű nem', () => {
    const low = withHouse();
    const lowWorld = new World(low);
    const a = lowWorld.addTank(125, 200, 0);
    a.level = CRUSH.minLevel - 1;
    run(lowWorld, { [a.id]: { throttle: 1 } }, seconds(6));
    expect(low.structures.collapsed[0]).toBe(0);
    expect(a.x).toBeLessThan(140);

    const high = withHouse();
    const highWorld = new World(high);
    const b = highWorld.addTank(125, 200, 0);
    b.level = CRUSH.minLevel + 2;
    const events = run(highWorld, { [b.id]: { throttle: 1 } }, seconds(6));
    expect(high.structures.collapsed[0]).toBe(1);
    expect(events.some((e) => e.type === 'collapse')).toBe(true);
    expect(b.x).toBeGreaterThan(150);

    const top = withHouse();
    const topWorld = new World(top);
    const c = topWorld.addTank(125, 200, 0);
    c.level = CRUSH.instantLevel;
    run(topWorld, { [c.id]: { throttle: 1 } }, seconds(1.2));
    expect(top.structures.collapsed[0]).toBe(1); // érintésre
  });
});

describe('életek és kiesés', () => {
  it('a játékos annyiszor éledhet újra, ahány élete van; utána kiesik', () => {
    const world = new World({ width: 400, height: 400, walls: new SegmentGrid(400, 400), speedFactor: () => 1 }, 1, { lives: 2 });
    const shooter = world.addTank(100, 200, 0, { team: 10 });
    const target = world.addTank(140, 200, Math.PI, { team: 11 });
    expect(target.lives).toBe(2);
    let events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(2.5));
    expect(target.alive).toBe(false);
    expect(target.lives).toBe(1);
    expect(target.out).toBe(false);
    expect(events.some((e) => e.type === 'eliminated')).toBe(false);
    run(world, {}, seconds(TANK.respawnDelay + 3)); // újraéled, a védelme lejár
    expect(target.alive).toBe(true);
    target.x = 140;
    target.y = 200;
    events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(3));
    expect(target.out).toBe(true);
    expect(events.some((e) => e.type === 'eliminated' && e.tank === target.id && e.by === shooter.id)).toBe(true);
    run(world, {}, seconds(TANK.respawnDelay + 2));
    expect(target.alive).toBe(false); // nem éled újra
  });

  it('a botok élete korlátlan', () => {
    const world = new World({ width: 400, height: 400, walls: new SegmentGrid(400, 400), speedFactor: () => 1 }, 1, { lives: 1 });
    const bot = world.addTank(100, 100, 0, { team: TEAM.bots, bot: true });
    expect(bot.lives).toBe(-1);
  });
});

describe('eső: sáros, csúszós zöldterület', () => {
  const field = (weather: 'day' | 'rain'): { world: World; tank: ReturnType<World['addTank']> } => {
    const world = new World({ width: 4000, height: 4000, walls: new SegmentGrid(4000, 4000), speedFactor: () => 0.72 }, 3, { weather });
    return { world, tank: world.addTank(500, 2000, 0) };
  };

  it('a sárban lassabb a tank, lassabban gyorsul és tovább csúszik fékezéskor', () => {
    const dry = field('day');
    const wet = field('rain');
    run(dry.world, { [dry.tank.id]: { throttle: 1 } }, seconds(0.5));
    run(wet.world, { [wet.tank.id]: { throttle: 1 } }, seconds(0.5));
    expect(wet.tank.speed).toBeLessThan(dry.tank.speed * 0.7);
    run(dry.world, { [dry.tank.id]: { throttle: 1 } }, seconds(4));
    run(wet.world, { [wet.tank.id]: { throttle: 1 } }, seconds(4));
    expect(wet.tank.speed).toBeLessThan(dry.tank.speed);
    const stop = (f: ReturnType<typeof field>): number => {
      const from = f.tank.x;
      run(f.world, {}, seconds(3));
      return f.tank.x - from;
    };
    expect(stop(wet)).toBeGreaterThan(stop(dry) * 1.5);
  });

  it('gyors kanyarban megcsúszik a sárban, szárazon nem', () => {
    const dry = field('day');
    const wet = field('rain');
    const turn = (f: ReturnType<typeof field>): SimEvent[] => [...run(f.world, { [f.tank.id]: { throttle: 1 } }, seconds(3)), ...run(f.world, { [f.tank.id]: { throttle: 1, turn: 1 } }, seconds(2))];
    expect(turn(dry).some((e) => e.type === 'slip')).toBe(false);
    expect(turn(wet).some((e) => e.type === 'slip')).toBe(true);
  });
});

describe('a meccs beállításai', () => {
  it('a rács celláiból a játéktér méterben adódik, a pályán belül', () => {
    expect(gridSize(2000, 3460)).toEqual({ cols: 8, rows: 14 });
    expect(areaOfCells(2000, 3460, 2, 3, 3, 4)).toEqual({ minX: 500, minY: 741, maxX: 1000, maxY: 1236 });
    expect(areaOfCells(2000, 3460, -5, 0, 99, 99)).toEqual({ minX: 0, minY: 0, maxX: 2000, maxY: 3460 });
  });

  it('a hibás vagy rosszindulatú beállítások a megengedett határok közé kerülnek', () => {
    const s = sanitizeSettings({ name: '  <b>Meccs</b>\n', maxPlayers: 99, lives: 4, bots: -3, pickups: 42, weather: 'hurricane' as never, area: { minX: 900, minY: 900, maxX: 910, maxY: 5000 } }, 2000, 3460);
    expect(s.name).toBe('bMeccs/b');
    expect(s.maxPlayers).toBe(MATCH.players.max);
    expect(s.lives).toBe(3);
    expect(s.bots).toBe(0);
    expect(s.pickups).toBe(5);
    expect(s.weather).toBe('day');
    expect(s.area.maxX - s.area.minX).toBeGreaterThanOrEqual(450);
    expect(s.area.maxY).toBe(3460);
    expect(sanitizeSettings(null, 2000, 3460).area).toEqual({ minX: 0, minY: 0, maxX: 2000, maxY: 3460 });
  });

  it('a botok és a tárgyak száma a szinttel és a pálya méretével nő', () => {
    const base: MatchSettings = sanitizeSettings({ area: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, bots: 3, pickups: 3, maxPlayers: 4 }, 2000, 3460);
    const small = matchPlan(base);
    const big = matchPlan({ ...base, area: { minX: 0, minY: 0, maxX: 2000, maxY: 3460 } });
    expect(small.bots).toBeGreaterThanOrEqual(3);
    expect(big.bots).toBeGreaterThan(small.bots * 10);
    expect(big.pickups).toBeGreaterThan(small.pickups * 10);
    expect(matchPlan({ ...base, bots: 5 }).bots).toBeGreaterThan(small.bots);
    expect(matchPlan({ ...base, bots: 0, pickups: 0 })).toMatchObject({ bots: 0, pickups: 0 });
    expect(matchPlan({ ...base, bots: 5, area: { minX: 0, minY: 0, maxX: 2000, maxY: 3460 } }).bots).toBe(MATCH.maxBots);
    // kis pályán közelebb születnek a játékosok
    expect(small.spawnGap).toBeLessThan(big.spawnGap);
  });
});

describe('meccs a valódi pályán', () => {
  const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;
  const setup = (overrides: Partial<MatchSettings>, names: string[]): { map: GameMap; match: Match } => {
    const map = new GameMap(data);
    const settings = sanitizeSettings({ area: areaOfCells(map.width, map.height, 2, 2, 4, 5), bots: 3, pickups: 3, lives: 1, ...overrides }, map.width, map.height);
    map.setArea(settings.area);
    map.weather = settings.weather;
    const match = new Match(map, settings, names.map((name, i) => ({ id: `p${i}`, name })), 77);
    return { map, match };
  };

  it('a játékosok, a botok és a tárgyak a kijelölt területen belül, a játékosok egymástól távol jelennek meg', () => {
    const { match } = setup({ maxPlayers: 6 }, ['a', 'b', 'c', 'd', 'e', 'f']);
    const { area } = match.settings;
    const inside = (o: { x: number; y: number }): boolean => o.x > area.minX && o.x < area.maxX && o.y > area.minY && o.y < area.maxY;
    expect(match.world.tanks.filter((t) => t.bot)).toHaveLength(match.plan.bots);
    expect(match.world.tanks.every(inside)).toBe(true);
    expect(match.world.pickups.length).toBeGreaterThan(match.plan.pickups * 0.8);
    expect(match.world.pickups.every(inside)).toBe(true);
    const humans = match.world.tanks.filter((t) => !t.bot);
    let nearest = Infinity;
    for (const a of humans) for (const b of humans) if (a !== b) nearest = Math.min(nearest, Math.hypot(a.x - b.x, a.y - b.y));
    expect(nearest).toBeGreaterThan(match.plan.spawnGap * 0.5);
    // mindenki külön csapat
    expect(new Set(humans.map((t) => t.team)).size).toBe(6);
  });

  it('senki nem hagyja el a játékteret: a határ fal a tanknak és a lövedéknek is', () => {
    const { match } = setup({ bots: 5 }, ['a', 'b']);
    const { area } = match.settings;
    const me = match.tankOf('p0')!;
    const inputs = new Map<string, TankInput>([['p0', { ...idle, throttle: 1, fire: true, aim: 0 }]]);
    for (let i = 0; i < seconds(60); i++) {
      match.step(inputs);
      if (match.over) break;
      for (const t of match.world.tanks) {
        expect(t.x).toBeGreaterThanOrEqual(area.minX);
        expect(t.x).toBeLessThanOrEqual(area.maxX);
        expect(t.y).toBeGreaterThanOrEqual(area.minY);
        expect(t.y).toBeLessThanOrEqual(area.maxY);
      }
      for (const b of match.world.bullets) expect(b.x).toBeLessThanOrEqual(area.maxX + 2);
    }
    expect(me.x).toBeLessThanOrEqual(area.maxX);
  }, 30000);

  it('az nyer, aki utolsónak marad; az újraéledés a többiektől távol történik', () => {
    const { match } = setup({ bots: 0, lives: 3, maxPlayers: 3 }, ['a', 'b', 'c']);
    const [a, b, c] = ['p0', 'p1', 'p2'].map((id) => match.tankOf(id)!);
    const none = new Map<string, TankInput>();
    const kill = (victim: typeof a): void => {
      // a szimuláció saját sebzésén keresztül: a győztes (a) lövedéke találja el
      victim.effects.invulnerable = 0;
      victim.shield = 0;
      match.world.bullets.push({ id: 900000 + match.world.tick, owner: a.id, team: a.team, kind: 'rocket', x: victim.x - 3, y: victim.y, vx: 100, vy: 0, life: 1, bounces: 0 });
      victim.hp = 1;
      match.step(none);
    };
    kill(b);
    expect(b.alive).toBe(false);
    expect(b.lives).toBe(2);
    for (let i = 0; i < seconds(TANK.respawnDelay + 0.2); i++) match.step(none);
    expect(b.alive).toBe(true);
    // az újraéledés helye távol van a többi játékostól
    expect(Math.min(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(b.x - c.x, b.y - c.y))).toBeGreaterThan(match.plan.spawnGap * 0.3);
    for (let n = 0; n < 2; n++) {
      kill(b);
      for (let i = 0; i < seconds(TANK.respawnDelay + 0.2); i++) match.step(none);
    }
    expect(b.out).toBe(true);
    expect(match.over).toBe(false);
    for (let n = 0; n < 3; n++) {
      kill(c);
      for (let i = 0; i < seconds(TANK.respawnDelay + 0.2); i++) match.step(none);
    }
    expect(match.over).toBe(true);
    expect(match.winner).toBe('p0');
    expect(match.standings().map((s) => [s.id, s.place])).toEqual([['p0', 1], ['p2', 2], ['p1', 3]]);
    expect(match.standings()[0].kills).toBe(6);
  });

  it('ha a többiek kilépnek, a bent maradó nyer', () => {
    const { match } = setup({ bots: 0, maxPlayers: 3 }, ['a', 'b', 'c']);
    match.leave('p1');
    expect(match.over).toBe(false);
    expect(match.world.tanks.filter((t) => !t.bot)).toHaveLength(2);
    match.leave('p0');
    expect(match.over).toBe(true);
    expect(match.winner).toBe('p2');
  });

  it('a pályán az épület összedől a találatoktól, és a helyén át lehet hajtani', () => {
    const { map, match } = setup({ bots: 0 }, ['a']);
    const me = match.tankOf('p0')!;
    // egy közepes ház a területen belül, előtte szabad hellyel nyugat felé
    const { area } = match.settings;
    const index = data.buildings.findIndex((b, i) => {
      const box = map.buildingBoxes[i];
      if (b.townhall || b.area < 60 || b.area > 140) return false;
      if (box[0] < area.minX + 40 || box[2] > area.maxX - 20 || box[1] < area.minY + 20 || box[3] > area.maxY - 20) return false;
      const y = (box[1] + box[3]) / 2;
      return !map.walls.raycast(box[0] - 25, y, box[0] - 0.5, y) && !map.walls.resolveCircle(box[0] - 20, y, 2.5).hit;
    });
    expect(index).toBeGreaterThanOrEqual(0);
    const box = map.buildingBoxes[index];
    me.x = box[0] - 20;
    me.y = (box[1] + box[3]) / 2;
    me.hullAngle = 0;
    me.turretAngle = 0;
    me.weapon = 'rocket';
    const inputs = new Map<string, TankInput>([['p0', { ...idle, fire: true, aim: 0 }]]);
    let collapsed = false;
    for (let i = 0; i < seconds(25) && !collapsed; i++) {
      match.step(inputs);
      collapsed = match.world.events.some((e) => e.type === 'collapse' && e.index === index);
    }
    expect(collapsed).toBe(true);
    expect(map.structures.collapsed[index]).toBe(1);
    // a romon keresztül a sugár már nem akad meg az épület falában
    const y = (box[1] + box[3]) / 2;
    const hit = map.walls.raycast(box[0] - 1, y, box[0] + 1, y);
    expect(hit === null || hit.owner !== index).toBe(true);
    map.resetDamage();
    expect(map.walls.raycast(box[0] - 1, y, box[0] + 1, y)?.owner).toBe(index);
  });
});
