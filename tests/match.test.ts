// A többjátékos meccs szabályai: ledönthető épületek, játéktér, életek és
// kiesés, születési távolság, sár, létszámok a pálya méretéhez.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/game/maps/GameMap';
import type { MapData } from '../src/game/maps/types';
import { SegmentGrid } from '../src/game/sim/collision';
import { applyTempo, areaOfCells, gridSize, MATCH, Match, matchPlan, sanitizeSettings, TEMPO, tempoBots, tempoKm2, type MatchSettings } from '../src/game/sim/match';
import { areaShares, MAX_WATER_SHARE, MIN_STREET_SHARE, pickArea } from '../src/game/ui/areaPick';
import { Structures } from '../src/game/sim/structures';
import { CRUSH, DAMAGE, ramPower, ramThrough, SIM_DT, TANK, TEAM, World, type SimEvent, type TankInput, type TankState, type Terrain } from '../src/game/sim/world';

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
function withHouse(extra: Partial<Terrain> = {}, indestructible = false, area = 100): Terrain & { structures: Structures } {
  const walls = new SegmentGrid(400, 400);
  walls.addPolygon([140, 195, 150, 195, 150, 205, 140, 205], 0);
  const structures = new Structures([{ area, x: 145, y: 200, indestructible }]);
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
    // minden találat után megy az épület megmaradt életereje (az utolsó után az összedőlés)
    const hitTerrain = withHouse();
    const hitWorld = new World(hitTerrain);
    const gunner = hitWorld.addTank(110, 200, 0);
    const hits = run(hitWorld, { [gunner.id]: { fire: true, aim: 0 } }, seconds(1)).flatMap((e) => (e.type === 'structure' ? [e] : []));
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]).toMatchObject({ index: 0, x: 145, y: 200 });
    expect(hits[0].left).toBeCloseTo(1 - DAMAGE.shell / 150, 5);
    // a nagyobb, erősebb lövedék jóval jobban rombol (STRUCTURE_MULT): nehéz lövedékből kettő, rakétából egy is elég
    expect(shots('heavy')).toBe(2);
    expect(shots('rocket')).toBe(1);
  });

  it('a le nem dönthető épület (a hivatal) akárhány találat után is áll', () => {
    const terrain = withHouse({}, true);
    const world = new World(terrain);
    const tank = world.addTank(110, 200, 0);
    tank.weapon = 'rocket';
    run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(30));
    expect(terrain.structures.collapsed[0]).toBe(0);
  });

  /** A tank nekihajt a háznak; visszaadja, hány másodperc múlva dőlt össze (−1: a megadott idő alatt nem). */
  const ram = (terrain: Terrain & { structures: Structures }, level: number, limit: number, options: { bot?: boolean } = {}): { time: number; tank: TankState; events: SimEvent[] } => {
    const world = new World(terrain);
    const tank = world.addTank(125, 200, 0, options);
    tank.level = level;
    const events: SimEvent[] = [];
    const inputs = new Map<number, TankInput>([[tank.id, { ...idle, throttle: 1 }]]);
    let time = -1;
    for (let i = 0; i < seconds(limit); i++) {
      world.step(inputs);
      events.push(...world.events);
      if (time < 0 && terrain.structures.collapsed[0]) time = (i + 1) * SIM_DT;
    }
    return { time, tank, events };
  };

  it('minden szintű tank rombolja az épületet, amelynek nekifeszül – a nagyobb tank gyorsabban', () => {
    // 100 m²-es ház: 150 életerő; az 1. szintű tank kb. 11 másodperc alatt dönti le
    const first = ram(withHouse(), 1, 16);
    expect(first.time).toBeGreaterThan(8);
    expect(first.time).toBeLessThan(14);
    // közben por és recsegés jelzi, hogy a fal sérül, és megy az épület fogyó életereje is
    expect(first.events.filter((e) => e.type === 'ram').length).toBeGreaterThan(20);
    const left = first.events.flatMap((e) => (e.type === 'structure' ? [e.left] : []));
    expect(left.length).toBeGreaterThan(20);
    expect(left[0]).toBeGreaterThan(0.9);
    expect(left[left.length - 1]).toBeLessThan(0.1);
    expect(left.every((v, i) => i === 0 || v < left[i - 1])).toBe(true);
    expect(first.events.some((e) => e.type === 'collapse')).toBe(true);
    // a romon át lehet hajtani
    expect(first.tank.x).toBeGreaterThan(150);
    const second = ram(withHouse(), 2, 16);
    const fourth = ram(withHouse(), 4, 16);
    expect(second.time).toBeLessThan(first.time);
    expect(fourth.time).toBeLessThan(second.time * 0.7);
    expect(ramPower(2)).toBeCloseTo(CRUSH.ramPerSecond * CRUSH.ramGrowth, 5);
    // ha a tank nem megy neki (áll mellette), nem sebzi
    const idleHouse = withHouse();
    const world = new World(idleHouse);
    world.addTank(137, 200, 0);
    run(world, {}, seconds(5));
    expect(idleHouse.structures.hp[0]).toBe(idleHouse.structures.maxHp[0]);
  });

  it('a nehéz tank a kisebb házon megállás nélkül áthajt, a nagy épületet viszont csak fokozatosan rombolja', () => {
    expect(ramThrough(1)).toBe(0);
    expect(ramThrough(2)).toBe(0);
    expect(ramThrough(3)).toBe(80);
    expect(ramThrough(CRUSH.minLevel)).toBeGreaterThanOrEqual(150);
    expect(ramThrough(CRUSH.instantLevel - 1)).toBeLessThan(600);
    expect(ramThrough(CRUSH.instantLevel)).toBe(Infinity);
    // 100 m²-es ház (150 életerő): a 6. szintű tank az első érintésre ledönti, és megy tovább
    const small = ram(withHouse(), CRUSH.minLevel, 3);
    expect(small.time).toBeGreaterThan(0);
    expect(small.time).toBeLessThan(1.5);
    expect(small.events.some((e) => e.type === 'ram')).toBe(false);
    expect(small.tank.x).toBeGreaterThan(165);
    // ugyanez egy megállás nélküli úthoz képest alig lassabb
    const free = ram(withHouse({ walls: new SegmentGrid(400, 400) }), CRUSH.minLevel, 3);
    expect(free.tank.x - small.tank.x).toBeLessThan(8);
    // 500 m²-es épület (510 életerő): ezen nem megy át, de rombolja
    const big = ram(withHouse({}, false, 500), CRUSH.minLevel, 3);
    expect(big.time).toBe(-1);
    expect(big.tank.x).toBeLessThan(140);
    const later = ram(withHouse({}, false, 500), CRUSH.minLevel, 14);
    expect(later.time).toBeGreaterThan(3);
    // a megrongált nagy épületen már áthajt: néhány találat után érintésre összedől
    const hurt = withHouse({}, false, 500);
    hurt.structures.damage(0, 510 - ramThrough(CRUSH.minLevel));
    expect(ram(hurt, CRUSH.minLevel, 3).time).toBeLessThan(1.5);
    // a 3. szintű tank csak a legkisebb fészeren megy át
    expect(ram(withHouse({}, false, 15), 3, 3).time).toBeLessThan(1.5);
    expect(ram(withHouse(), 3, 3).time).toBe(-1);
  });

  it('a legmagasabb szinteken minden épület érintésre összedől – a le nem dönthető hivatal kivételével', () => {
    const top = ram(withHouse({}, false, 5000), CRUSH.instantLevel, 2);
    expect(top.time).toBeGreaterThan(0);
    expect(top.time).toBeLessThan(1.5);
    const hall = withHouse({}, true);
    const result = ram(hall, CRUSH.instantLevel + 3, 6);
    expect(result.time).toBe(-1);
    expect(hall.structures.collapsed[0]).toBe(0);
    expect(hall.structures.hp[0]).toBe(Infinity);
    expect(result.tank.x).toBeLessThan(140);
    expect(result.events.some((e) => e.type === 'ram')).toBe(false);
  });

  it('a botok az ütközésükkel nem rombolnak (csak véletlenül mennek falnak)', () => {
    const terrain = withHouse();
    const result = ram(terrain, 1, 20, { bot: true });
    expect(result.time).toBe(-1);
    expect(terrain.structures.hp[0]).toBe(terrain.structures.maxHp[0]);
  });
});

describe('életek és kiesés', () => {
  it('a játékos annyiszor éledhet újra, ahány élete van; utána kiesik', () => {
    const world = new World({ width: 400, height: 400, walls: new SegmentGrid(400, 400), speedFactor: () => 1 }, 1, { lives: 2 });
    const shooter = world.addTank(100, 200, 0, { team: 10 });
    const target = world.addTank(140, 200, Math.PI, { team: 11 });
    expect(target.lives).toBe(2);
    let events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(4.5));
    expect(target.alive).toBe(false);
    expect(target.lives).toBe(1);
    expect(target.out).toBe(false);
    expect(events.some((e) => e.type === 'eliminated')).toBe(false);
    run(world, {}, seconds(TANK.respawnDelay + 3)); // újraéled, a védelme lejár
    expect(target.alive).toBe(true);
    target.x = 140;
    target.y = 200;
    events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(5));
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
    expect(gridSize(2000, 3460)).toEqual({ cols: 24, rows: 42 });
    expect(areaOfCells(2000, 3460, 6, 9, 11, 14)).toEqual({ minX: 500, minY: 741, maxX: 1000, maxY: 1236 });
    // a legkisebb kijelölhető játéktér két cella széles: a korábbi 500 méter harmada
    const tiny = areaOfCells(2000, 3460, 10, 20, 10 + MATCH.minCells - 1, 20 + MATCH.minCells - 1);
    expect(tiny.maxX - tiny.minX).toBeLessThanOrEqual(170);
    expect(tiny.maxY - tiny.minY).toBeLessThanOrEqual(170);
    expect(sanitizeSettings({ area: tiny }, 2000, 3460).area).toEqual(tiny);
    expect(areaOfCells(2000, 3460, -5, 0, 99, 99)).toEqual({ minX: 0, minY: 0, maxX: 2000, maxY: 3460 });
  });

  it('a hibás vagy rosszindulatú beállítások a megengedett határok közé kerülnek', () => {
    const s = sanitizeSettings({ name: '  <b>Meccs</b>\n', maxPlayers: 99, minutes: 500, mode: 'capture' as never, bots: -3, pickups: 42, weather: 'hurricane' as never, area: { minX: 900, minY: 900, maxX: 910, maxY: 5000 } }, 2000, 3460);
    expect(s.name).toBe('bMeccs/b');
    expect(s.maxPlayers).toBe(MATCH.players.max);
    expect(s.minutes).toBe(MATCH.minutes.max);
    expect(s.mode).toBe('deathmatch');
    expect(sanitizeSettings({ minutes: 1 }, 2000, 3460).minutes).toBe(MATCH.minutes.min);
    expect(sanitizeSettings({}, 2000, 3460).minutes).toBe(10);
    expect(s.bots).toBe(0);
    expect(s.pickups).toBe(5);
    expect(s.weather).toBe('day');
    expect(s.area.maxX - s.area.minX).toBeGreaterThanOrEqual(149);
    expect(Number.isInteger(s.area.maxX)).toBe(true);
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

  it('a legkisebb pályán a legmagasabb szint is csak néhány botot és járművet ad', () => {
    const area = areaOfCells(2000, 3460, 10, 20, 11, 21);
    const tiny = matchPlan(sanitizeSettings({ area, bots: 5, pickups: 5, traffic: 5, maxPlayers: 2 }, 2000, 3460));
    expect(tiny.km2).toBeLessThan(0.03);
    expect(tiny.bots).toBeGreaterThanOrEqual(1);
    expect(tiny.bots).toBeLessThanOrEqual(3);
    expect(tiny.traffic).toBeGreaterThanOrEqual(1);
    expect(tiny.traffic).toBeLessThanOrEqual(2);
    expect(tiny.pickups).toBeGreaterThanOrEqual(5);
    // az 1-es szint itt is ad legalább egyet
    const few = matchPlan(sanitizeSettings({ area, bots: 1, pickups: 1, traffic: 1 }, 2000, 3460));
    expect(few).toMatchObject({ bots: 1, traffic: 1 });
  });
});

describe('meccs a valódi pályán', () => {
  const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;
  const setup = (overrides: Partial<MatchSettings>, names: string[]): { map: GameMap; match: Match } => {
    const map = new GameMap(data);
    const settings = sanitizeSettings({ area: areaOfCells(map.width, map.height, 6, 6, 14, 17), bots: 3, pickups: 3, traffic: 0, minutes: 5, ...overrides }, map.width, map.height);
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

  /** A `by` tank lövedéke kilövi a `victim` tankot (a szimuláció saját sebzésén keresztül). */
  const kill = (match: Match, by: TankState, victim: TankState): void => {
    victim.effects.invulnerable = 0;
    victim.shield = 0;
    victim.hp = 1;
    match.world.bullets.push({ id: 900000 + match.world.tick, owner: by.id, team: by.team, kind: 'rocket', x: victim.x - 3, y: victim.y, vx: 100, vy: 0, life: 1, bounces: 0 });
    match.step(new Map());
  };
  const wait = (match: Match, s: number): void => {
    for (let i = 0; i < seconds(s) && !match.over; i++) match.step(new Map());
  };

  it('időre megy: a kilőtt tank mindig újraéled (a többiektől távol), és az nyer, aki a legtöbb tankot lövi ki', () => {
    const { match } = setup({ bots: 0, maxPlayers: 3 }, ['a', 'b', 'c']);
    const [a, b, c] = ['p0', 'p1', 'p2'].map((id) => match.tankOf(id)!);
    expect(match.timeLeft).toBe(5 * 60);
    // b-t akárhányszor kilövik, mindig újraéled: nincs kiesés
    for (let n = 0; n < 4; n++) {
      kill(match, a, b);
      expect(b.alive).toBe(false);
      wait(match, TANK.respawnDelay + 0.2);
      expect(b.alive).toBe(true);
      expect(b.out).toBe(false);
      expect(Math.min(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(b.x - c.x, b.y - c.y))).toBeGreaterThan(match.plan.spawnGap * 0.3);
    }
    kill(match, c, a);
    kill(match, c, b);
    wait(match, 5);
    expect(match.over).toBe(false);
    expect(match.timeLeft).toBeLessThan(5 * 60 - 20);
    expect(match.standings().map((s) => [s.id, s.place, s.kills, s.deaths])).toEqual([
      ['p0', 1, 4, 1],
      ['p2', 2, 2, 0],
      ['p1', 3, 0, 5],
    ]);
    // az idő lejártakor vége; addig nincs győztes
    expect(match.winner).toBeNull();
    match.timeLeft = 0.5;
    wait(match, 1);
    expect(match.over).toBe(true);
    expect(match.timeLeft).toBe(0);
    expect(match.winner).toBe('p0');
    // a vége után a meccs már nem lép tovább
    const tick = match.world.tick;
    match.step(new Map());
    expect(match.world.tick).toBe(tick);
  });

  it('azonos kilövésszámnál az nyer, akit kevesebbszer lőttek ki; teljes egyenlőségnél döntetlen', () => {
    const first = setup({ bots: 0, maxPlayers: 3 }, ['a', 'b', 'c']).match;
    const [a, b, c] = ['p0', 'p1', 'p2'].map((id) => first.tankOf(id)!);
    kill(first, a, c);
    wait(first, TANK.respawnDelay + 0.2);
    kill(first, b, c);
    wait(first, TANK.respawnDelay + 0.2);
    kill(first, c, a); // a-t egyszer kilőtték, b-t egyszer sem
    first.timeLeft = 0.2;
    wait(first, 1);
    expect(first.winner).toBe('p1');

    const draw = setup({ bots: 0, maxPlayers: 2 }, ['a', 'b']).match;
    draw.timeLeft = 0.2;
    wait(draw, 1);
    expect(draw.over).toBe(true);
    expect(draw.winner).toBeNull();
    expect(draw.standings().map((s) => s.place)).toEqual([1, 1]);
  });

  it('a botok kilövése statisztika (nem kilövés), és a teljes játékidő alatt van kit lőni', () => {
    const { match } = setup({ bots: 2, maxPlayers: 2 }, ['a', 'b']);
    const a = match.tankOf('p0')!;
    const bot = match.world.tanks.find((t) => t.bot)!;
    kill(match, a, bot);
    expect(match.standings()[0]).toMatchObject({ id: 'p0', kills: 0, bots: 1 });
    wait(match, TANK.respawnDelay + 0.5);
    expect(bot.alive).toBe(true);
  });

  it('egyedül játszva a meccs az idő végéig tart, és nincs győztes – az eredmény a kilövések száma', () => {
    const { match } = setup({ bots: 1, maxPlayers: 1 }, ['a']);
    const a = match.tankOf('p0')!;
    kill(match, match.world.tanks.find((t) => t.bot)!, a);
    wait(match, TANK.respawnDelay + 0.5);
    expect(a.alive).toBe(true);
    expect(match.over).toBe(false);
    match.timeLeft = 0.2;
    wait(match, 1);
    expect(match.over).toBe(true);
    expect(match.winner).toBeNull();
    expect(match.standings()).toHaveLength(1);
  });

  it('ha a többiek kilépnek, a bent maradó nyer; a kilépettek az állás végére kerülnek', () => {
    const { match } = setup({ bots: 0, maxPlayers: 3 }, ['a', 'b', 'c']);
    const [a, , c] = ['p0', 'p1', 'p2'].map((id) => match.tankOf(id)!);
    kill(match, a, c);
    match.leave('p1');
    expect(match.over).toBe(false);
    expect(match.world.tanks.filter((t) => !t.bot)).toHaveLength(2);
    match.leave('p0');
    expect(match.over).toBe(true);
    expect(match.winner).toBe('p2');
    // a kilépett játékos eredménye megmarad, de a bent maradó mögé kerül
    expect(match.standings().map((s) => [s.id, s.place, s.kills])).toEqual([
      ['p2', 1, 0],
      ['p0', 2, 1],
      ['p1', 3, 0],
    ]);
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

describe('nagyon kis pálya a valódi térképen (kétfős párbaj)', () => {
  const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;
  const { cols, rows } = gridSize(data.meta.width, data.meta.height);
  const start = (c: number, r: number, overrides: Partial<MatchSettings> = {}): { map: GameMap; match: Match; settings: MatchSettings } => {
    const map = new GameMap(data);
    const area = areaOfCells(map.width, map.height, c, r, c + MATCH.minCells - 1, r + MATCH.minCells - 1);
    const settings = sanitizeSettings({ area, bots: 2, pickups: 3, traffic: 2, minutes: 5, maxPlayers: 2, ...overrides }, map.width, map.height);
    map.setArea(settings.area);
    const match = new Match(map, settings, [{ id: 'a', name: 'Anna' }, { id: 'b', name: 'Béla' }], 31 + c * 7 + r);
    return { map, match, settings };
  };
  const inside = (o: { x: number; y: number }, s: MatchSettings): boolean => o.x > s.area.minX && o.x < s.area.maxX && o.y > s.area.minY && o.y < s.area.maxY;

  it('a pálya bármelyik részén: a két játékos a játéktéren belül, szabad helyen, egymástól távolabb születik', () => {
    let checked = 0;
    // a rács minden harmadik helye (a mezőkön, út nélküli részeken is)
    for (let r = 0; r + MATCH.minCells <= rows; r += 3) {
      for (let c = 0; c + MATCH.minCells <= cols; c += 3) {
        const { map, match, settings } = start(c, r, { bots: 0, traffic: 0 });
        const [a, b] = match.players.map((p) => match.world.tank(p.tankId)!);
        expect(inside(a, settings), `a (${c},${r})`).toBe(true);
        expect(inside(b, settings), `b (${c},${r})`).toBe(true);
        expect(map.walls.resolveCircle(a.x, a.y, 1.5).hit, `a falban (${c},${r})`).toBe(false);
        expect(map.walls.resolveCircle(b.x, b.y, 1.5).hit, `b falban (${c},${r})`).toBe(false);
        expect(Math.hypot(a.x - b.x, a.y - b.y), `távolság (${c},${r})`).toBeGreaterThan(12);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  it('botokkal, tárgyakkal és forgalommal is elindul és fut; a kilőtt bot a kis pályán is újraéled', () => {
    const c = Math.floor(data.townhall.x / (data.meta.width / cols));
    const r = Math.floor(data.townhall.y / (data.meta.height / rows));
    const { match, settings } = start(c, r);
    expect(match.plan.bots).toBeGreaterThanOrEqual(1);
    expect(match.bots.count).toBe(match.plan.bots);
    for (const tank of match.world.tanks) expect(inside(tank, settings)).toBe(true);
    for (const p of match.world.pickups) expect(inside(p, settings)).toBe(true);
    const bot = match.world.tanks.find((t) => t.bot)!;
    bot.hp = 1;
    const shooter = match.tankOf('a')!;
    // az egyik játékos kilövi a botot (közvetlen közelről, hogy biztos legyen)
    shooter.x = bot.x - 6;
    shooter.y = bot.y;
    shooter.effects.invulnerable = 60;
    const inputs = new Map([['a', { throttle: 0, turn: 0, aim: 0, fire: true, drop: false }]]);
    let died = false;
    for (let i = 0; i < 60 * 20; i++) {
      match.step(inputs);
      if (!bot.alive) died = true;
      if (died && bot.alive) break;
    }
    expect(died).toBe(true);
    expect(bot.alive).toBe(true);
    expect(inside(bot, settings)).toBe(true);
    for (const v of match.world.vehicles) expect(v.x > settings.area.minX - 12 && v.x < settings.area.maxX + 12).toBe(true);
  });
});

describe('játéktempó és ajánlott pálya', () => {
  const mapData = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;
  const { cols, rows } = gridSize(mapData.meta.width, mapData.meta.height);

  it('a pörgősebb tempó kisebb pályát ad ugyanannyi játékosnak; a pálya legfeljebb 1 km²; több játékosnak nagyobb', () => {
    for (const players of [1, 4, 10, 20]) {
      const sizes = [1, 2, 3, 4, 5].map((t) => tempoKm2(t, players));
      for (let i = 1; i < sizes.length; i++) expect(sizes[i], `${players} fő, tempó ${i + 1}`).toBeLessThanOrEqual(sizes[i - 1]);
      for (const km2 of sizes) expect(km2).toBeLessThanOrEqual(TEMPO.maxKm2);
    }
    expect(tempoKm2(4, 20)).toBeGreaterThan(tempoKm2(4, 4));
    expect(tempoKm2(1, 20)).toBe(TEMPO.maxKm2);
    // kevés játékosnál sem szűk: a pörgős legalább 0,1 km² (kb. 360 × 280 m), az aréna is legalább kb. 300 × 230 m
    expect(tempoKm2(4, 1)).toBeGreaterThanOrEqual(0.1);
    expect(tempoKm2(5, 1)).toBeGreaterThanOrEqual(0.07);
  });

  it('a botok száma a játékosszámmal csökken; pörgős tempóban kevés játékosnál sok bot van', () => {
    expect(tempoBots(4, 2)).toBeGreaterThanOrEqual(8);
    expect(tempoBots(4, 20)).toBeLessThan(tempoBots(4, 2));
    expect(tempoBots(5, 4)).toBeGreaterThan(tempoBots(1, 4));
    for (let t = 1; t <= 5; t++) expect(tempoBots(t, 100)).toBeGreaterThanOrEqual(1);
  });

  it('tempó állásban a botok, tárgyak, forgalom a tempóból jön (a kérésben küldött érték nem számít); egyéniben nem változik', () => {
    const raw = { tempo: 4, botSkill: 1, botAggression: 1, botToughness: 5, pickups: 0, traffic: 5, bots: 0, maxPlayers: 4 };
    const s = applyTempo(sanitizeSettings(raw, mapData.meta.width, mapData.meta.height));
    expect(s).toMatchObject({ botSkill: TEMPO.presets[4].botSkill, botAggression: TEMPO.presets[4].botAggression, botToughness: TEMPO.presets[4].botToughness, pickups: TEMPO.presets[4].pickups, traffic: TEMPO.presets[4].traffic });
    expect(matchPlan(s).bots).toBe(tempoBots(4, 4));
    const custom = applyTempo(sanitizeSettings({ ...raw, tempo: 0 }, mapData.meta.width, mapData.meta.height));
    expect(custom).toMatchObject({ botSkill: 1, botAggression: 1, botToughness: 5, pickups: 0, traffic: 5 });
    // a régi (tempó nélküli) beállítás egyéni marad; legfeljebb 20 játékos
    expect(sanitizeSettings({}, mapData.meta.width, mapData.meta.height).tempo).toBe(TEMPO.custom);
    expect(sanitizeSettings({ maxPlayers: 50 }, mapData.meta.width, mapData.meta.height).maxPlayers).toBe(20);
  });

  it('az ajánlott pálya a kért méretű, a pályán belül van, és jó helyen: van benne út és épület; a „Másik helyszín” máshová tesz', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [tempo, players] of [[4, 4], [5, 2], [1, 20], [3, 10]] as const) {
      const km2 = tempoKm2(tempo, players);
      const rect = pickArea(mapData, cols, rows, km2, MATCH.minCells, rnd);
      expect(rect.c0).toBeGreaterThanOrEqual(0);
      expect(rect.r0).toBeGreaterThanOrEqual(0);
      expect(rect.c1).toBeLessThan(cols);
      expect(rect.r1).toBeLessThan(rows);
      const area = areaOfCells(mapData.meta.width, mapData.meta.height, rect.c0, rect.r0, rect.c1, rect.r1);
      const real = ((area.maxX - area.minX) * (area.maxY - area.minY)) / 1e6;
      expect(real, `tempó ${tempo}, ${players} fő`).toBeGreaterThan(km2 * 0.5);
      expect(real, `tempó ${tempo}, ${players} fő`).toBeLessThan(Math.max(km2 * 1.8, 0.06));
      // van benne épület és közút
      const inside = (x: number, y: number): boolean => x > area.minX && x < area.maxX && y > area.minY && y < area.maxY;
      const houses = mapData.buildings.filter((b) => inside(b.pts[0], b.pts[1])).length;
      const roads = mapData.roads.filter((r) => r.kind !== 'footway' && r.kind !== 'path' && r.pts.some((v, i) => i % 2 === 0 && inside(v, r.pts[i + 1]))).length;
      expect(houses, `tempó ${tempo}`).toBeGreaterThan(8);
      expect(roads, `tempó ${tempo}`).toBeGreaterThan(2);
      // játszható: a cellák nagy részében utca, alig víz
      const shares = areaShares(mapData, cols, rows, rect);
      expect(shares.street, `tempó ${tempo}`).toBeGreaterThanOrEqual(MIN_STREET_SHARE);
      expect(shares.water, `tempó ${tempo}`).toBeLessThanOrEqual(MAX_WATER_SHARE);
      const other = pickArea(mapData, cols, rows, km2, MATCH.minCells, rnd, rect);
      expect(other.c0 !== rect.c0 || other.r0 !== rect.r0).toBe(true);
    }
  });
});

describe('visszanövés a nyitott játékban', () => {
  const mapData = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;
  const area = { minX: 600, minY: 900, maxX: 1000, maxY: 1300 };
  /** Meccs, amelyben az első lépés után a megadott épületek összedőlnek és a fák kidőlnek (valódi eseményekkel). */
  const setup = (endless: boolean, buildings: number, trees: number) => {
    const map = new GameMap(mapData);
    map.setArea(area);
    const settings = sanitizeSettings({ area, bots: 0, pickups: 0, traffic: 0, maxPlayers: 1 }, map.width, map.height);
    const match = new Match(map, settings, [{ id: 'a', name: 'Anna' }], 3, endless);
    const inside = (x: number, y: number): boolean => x > area.minX + 30 && x < area.maxX - 30 && y > area.minY + 30 && y < area.maxY - 30;
    const houses: number[] = [];
    for (let i = 0; i < map.structures.count && houses.length < buildings; i++) if (map.structures.maxHp[i] !== Infinity && inside(map.structures.x[i], map.structures.y[i])) houses.push(i);
    const props: number[] = [];
    for (let i = 0; i < map.fellables.count && props.length < trees; i++) if (inside(map.fellables.x[i], map.fellables.y[i])) props.push(i);
    // a játékos messzire, hogy ne álljon útban
    const me = match.tankOf('a')!;
    me.x = area.minX + 5;
    me.y = area.minY + 5;
    const world = match.world as unknown as { step: (i: unknown) => void; damageStructure: (i: number, a: number) => void; fell: (i: number, a: number) => boolean };
    const step = world.step.bind(match.world);
    let once = true;
    world.step = (inputs) => {
      step(inputs);
      if (!once) return;
      once = false;
      for (const i of houses) world.damageStructure(i, Infinity);
      for (const i of props) world.fell(i, 0.5);
    };
    return { match, map, houses, props };
  };
  const advance = (match: Match, seconds: number): SimEvent[] => {
    const events: SimEvent[] = [];
    for (let i = 0; i < seconds * 60; i++) {
      match.step(new Map());
      events.push(...match.world.events);
      // a játékos maradjon a sarokban
      const me = match.tankOf('a')!;
      me.x = 605;
      me.y = 905;
    }
    return events;
  };

  it('a ledöntöttek idővel egyenként, időben elosztva újra megjelennek; a rendes meccsben nem', () => {
    const { match, map, houses, props } = setup(true, 4, 6);
    advance(match, 1);
    expect(houses.every((i) => map.structures.collapsed[i] === 1)).toBe(true);
    expect(props.every((i) => map.fellables.fallen[i] === 1)).toBe(true);
    // két perc alatt még semmi nem nő vissza
    expect(advance(match, 100).filter((e) => e.type === 'regrow')).toHaveLength(0);
    // 7 perc múlva mind visszanőtt – de nem egyszerre: két visszanövés között legalább REGROW.gap telik el
    const ticks: number[] = [];
    let t = 0;
    for (let s = 0; s < 330; s++) {
      for (const e of advance(match, 1)) if (e.type === 'regrow') ticks.push(t);
      t++;
    }
    expect(ticks).toHaveLength(houses.length + props.length);
    expect(houses.every((i) => map.structures.collapsed[i] === 0)).toBe(true);
    expect(props.every((i) => map.fellables.fallen[i] === 0)).toBe(true);
    // a visszaépült ház falai újra akadályok
    expect(houses.every((i) => map.structures.hp[i] === map.structures.maxHp[i])).toBe(true);
    // a rendes (időre menő) meccsben nem nő vissza semmi
    const normal = setup(false, 2, 2);
    advance(normal.match, 1);
    (normal.match as unknown as { clock: number }).clock += 1000;
    expect(advance(normal.match, 3).filter((e) => e.type === 'regrow')).toHaveLength(0);
  }, 120000);

  it('nem épül vissza arra, ami a helyén áll; a belépő játékos megkapja, mi van ledöntve', () => {
    const { match, map, houses } = setup(true, 1, 0);
    advance(match, 1);
    const house = houses[0];
    // egy második tank áll a rom közepén
    const blocker = match.world.addTank(map.structures.x[house], map.structures.y[house], 0, { team: 50 });
    (match as unknown as { clock: number }).clock += 1000;
    const keep = (): void => {
      blocker.x = map.structures.x[house];
      blocker.y = map.structures.y[house];
      blocker.speed = 0;
    };
    for (let i = 0; i < 600; i++) {
      match.step(new Map());
      keep();
    }
    expect(map.structures.collapsed[house]).toBe(1);
    expect(match.destroyed()?.b).toContain(house);
    // elmegy: a ház visszaépül
    match.world.removeTank(blocker.id);
    advance(match, 12);
    expect(map.structures.collapsed[house]).toBe(0);
    expect(match.destroyed()).toBeNull();
  }, 60000);
});
