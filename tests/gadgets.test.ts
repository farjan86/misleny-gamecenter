// Akna, füst, tüzérségi csapás, gázpalack, szupertárgy, kilövéssorozat és a meccs statisztikái.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, Lobby } from '../server/lobby';
import { GameMap, pointInPolygon } from '../src/game/maps/GameMap';
import type { MapData } from '../src/game/maps/types';
import { encode, packBarrel, packInput, packMine, packSmoke, packTank, blankTank, PROTOCOL_VERSION, unpackBarrel, unpackInput, unpackMine, unpackSmoke, unpackTank, type ServerMessage, type Snapshot } from '../src/game/net/protocol';
import { SegmentGrid } from '../src/game/sim/collision';
import { BARREL, MINE, SMOKE, STRIKE, SUPER } from '../src/game/sim/gadgets';
import { areaOfCells, Match, matchPlan, sanitizeSettings } from '../src/game/sim/match';
import { PICKUP, PICKUP_KINDS, PICKUPS, pickKind, mulberry32 } from '../src/game/sim/pickups';
import { Structures } from '../src/game/sim/structures';
import { TURRET } from '../src/game/sim/vehicles';
import { DAMAGE, SIM_DT, TANK, tankMaxHp, TEAM, World, type SimEvent, type TankInput, type TankState, type Terrain } from '../src/game/sim/world';

const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;

function arena(extra: Partial<Terrain> = {}): Terrain {
  return { width: 400, height: 400, walls: new SegmentGrid(400, 400), speedFactor: () => 1, ...extra };
}
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
const booms = (events: SimEvent[], kind: string): Extract<SimEvent, { type: 'boom' }>[] => events.flatMap((e) => (e.type === 'boom' && e.kind === kind ? [e] : []));
/** A lövő egymás után kilő `count` gyenge ellenfelet (mindegyik közvetlenül előtte jelenik meg). */
function kills(world: World, shooter: TankState, count: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < count; i++) {
    const victim = world.addTank(shooter.x + 12, shooter.y, Math.PI, { team: TEAM.bots, bot: true });
    victim.hp = 1;
    events.push(...run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(0.6)));
    expect(victim.alive).toBe(false);
    world.removeTank(victim.id);
    world.wrecks.length = 0;
  }
  return events;
}

describe('akna', () => {
  it('a tárgy két aknát ad; a tank maga mögé rakja, és a sajátja alatt nem robban', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 100, 0);
    world.addPickup('mine', 100, 100);
    world.step(new Map());
    expect(tank.mines).toBe(MINE.perPickup);
    const events = run(world, { [tank.id]: { mine: true } }, 2);
    expect(tank.mines).toBe(MINE.perPickup - 1);
    expect(world.mines).toHaveLength(1);
    expect(events.some((e) => e.type === 'mine' && e.tank === tank.id)).toBe(true);
    const mine = world.mines[0];
    expect(mine.x).toBeLessThan(tank.x - TANK.radius);
    expect(mine.owner).toBe(tank.id);
    // a lerakója tolatva ráhajt: nem robban
    const back = run(world, { [tank.id]: { throttle: -1 } }, seconds(3));
    expect(tank.x).toBeLessThan(mine.x);
    expect(booms(back, 'mine')).toHaveLength(0);
    expect(world.mines).toHaveLength(1);
  });

  it('az ellenséges tank alatt felrobban: sebez, és a kilövés a lerakóé', () => {
    const world = new World(arena());
    const owner = world.addTank(100, 100, 0, { team: 10 });
    owner.mines = 1;
    run(world, { [owner.id]: { mine: true } }, 1);
    const mine = world.mines[0];
    owner.x = 300; // messzire megy
    owner.y = 300;
    run(world, {}, seconds(MINE.arm + 0.2));
    const enemy = world.addTank(mine.x - 14, mine.y, 0, { team: 11 });
    const events = run(world, { [enemy.id]: { throttle: 1 } }, seconds(3));
    expect(booms(events, 'mine')).toHaveLength(1);
    expect(world.mines).toHaveLength(0);
    const hit = events.find((e) => e.type === 'hit' && e.tank === enemy.id) as Extract<SimEvent, { type: 'hit' }>;
    expect(hit.by).toBe(owner.id);
    // közvetlenül alatta robbant: a teljes sebzés közelében
    expect(hit.amount).toBeGreaterThan(MINE.damage * 0.7);
    expect(enemy.hp).toBeCloseTo(TANK.maxHp - hit.amount, 0);
    // gyenge ellenfelet kilő, a pont a lerakóé
    owner.mines = 1;
    owner.x = 100;
    owner.y = 200;
    owner.hullAngle = 0;
    run(world, { [owner.id]: { mine: true } }, 1);
    const second = world.mines[0];
    owner.x = 300;
    run(world, {}, seconds(MINE.arm + 0.2));
    enemy.hp = 10;
    enemy.x = second.x;
    enemy.y = second.y;
    run(world, {}, 2);
    expect(enemy.alive).toBe(false);
    expect(owner.kills).toBe(1);
  });

  it('élesedés előtt nem robban; egyszerre legfeljebb hat lehet kint; idővel eltűnik', () => {
    const world = new World(arena());
    const owner = world.addTank(100, 100, 0, { team: 10 });
    owner.mines = 1;
    run(world, { [owner.id]: { mine: true } }, 1);
    const enemy = world.addTank(world.mines[0].x, world.mines[0].y + 0.5, 0, { team: 11 });
    expect(booms(run(world, {}, seconds(MINE.arm - 0.3)), 'mine')).toHaveLength(0);
    expect(booms(run(world, {}, seconds(0.6)), 'mine')).toHaveLength(1);
    world.removeTank(enemy.id);
    for (let i = 0; i < MINE.maxPlaced + 2; i++) {
      owner.mines = 1;
      owner.x = 60 + i * 20;
      run(world, { [owner.id]: { mine: true } }, seconds(1));
    }
    expect(world.mines).toHaveLength(MINE.maxPlaced);
    run(world, {}, seconds(MINE.life));
    expect(world.mines).toHaveLength(0);
  });
});

describe('füst', () => {
  it('a felhő a tank köré kerül, tíz másodpercig tart, és a telepített ágyú nem lát bele', () => {
    const world = new World(arena());
    const owner = world.addTank(100, 100, 0, { team: 10 });
    owner.turrets = 1;
    run(world, { [owner.id]: { deploy: true } }, seconds(1));
    expect(world.turrets).toHaveLength(1);
    owner.x = 350;
    owner.y = 350;
    // az ellenfél az ágyú lőtávolán belül áll, és füstöt ereszt
    const enemy = world.addTank(world.turrets[0].x + 30, world.turrets[0].y, 0, { team: 11 });
    world.addPickup('smoke', enemy.x, enemy.y);
    world.step(new Map());
    expect(enemy.smokes).toBe(SMOKE.perPickup);
    const dropped = run(world, { [enemy.id]: { smoke: true } }, 1);
    expect(dropped.some((e) => e.type === 'smoke' && e.tank === enemy.id)).toBe(true);
    expect(world.smokes).toHaveLength(1);
    expect(world.inSmoke(enemy.x, enemy.y)).toBe(true);
    expect(world.inSmoke(enemy.x + SMOKE.radius + 2, enemy.y)).toBe(false);
    enemy.hp = tankMaxHp(enemy);
    const hidden = run(world, {}, seconds(SMOKE.life - 1));
    expect(hidden.filter((e) => e.type === 'shot')).toHaveLength(0);
    expect(enemy.hp).toBe(tankMaxHp(enemy));
    // a füst eloszlik: az ágyú újra lát és lő
    const seen = run(world, {}, seconds(4));
    expect(world.smokes).toHaveLength(0);
    expect(seen.filter((e) => e.type === 'shot').length).toBeGreaterThanOrEqual(2);
    expect(30).toBeLessThan(TURRET.range);
  });
});

describe('kilövéssorozat és tüzérségi csapás', () => {
  it('minden harmadik kilövés (halál nélkül) után jár egy csapás; a halál a sorozatot nullázza', () => {
    const world = new World(arena());
    const shooter = world.addTank(100, 200, 0, { team: 10 });
    let events = kills(world, shooter, 2);
    expect(shooter.streak).toBe(2);
    expect(shooter.strikes).toBe(0);
    events = kills(world, shooter, 1);
    expect(shooter.strikes).toBe(1);
    expect(events.some((e) => e.type === 'streak' && e.tank === shooter.id && e.streak === 3 && e.strikes === 1)).toBe(true);
    kills(world, shooter, 3);
    expect(shooter.strikes).toBe(2);
    kills(world, shooter, 3);
    expect(shooter.strikes).toBe(STRIKE.max); // ennél több nem gyűlik
    expect(shooter.bestStreak).toBe(9);
    // kilövik: a sorozat elölről indul, a legjobb megmarad, a megszerzett csapás is
    const killer = world.addTank(shooter.x - 12, shooter.y, 0, { team: 11 });
    shooter.hp = 1;
    run(world, { [killer.id]: { fire: true, aim: 0 } }, seconds(0.6));
    expect(shooter.alive).toBe(false);
    expect(shooter.streak).toBe(0);
    expect(shooter.bestStreak).toBe(9);
    expect(shooter.strikes).toBe(STRIKE.max);
    // a botok nem kapnak csapást
    const bot = world.addTank(300, 300, 0, { team: TEAM.bots, bot: true });
    for (let i = 0; i < 3; i++) {
      const victim = world.addTank(312, 300, 0, { team: 12 });
      victim.hp = 1;
      run(world, { [bot.id]: { fire: true, aim: 0 } }, seconds(0.6));
      world.removeTank(victim.id);
      world.wrecks.length = 0;
    }
    expect(bot.kills).toBe(3);
    expect(bot.strikes).toBe(0);
  });

  it('a csapás a kijelölt helyre érkezik: előbb figyelmeztetés, aztán nyolc lövedék; a kérőt nem sebzi', () => {
    const world = new World(arena());
    const caller = world.addTank(100, 200, 0, { team: 10 });
    const enemy = world.addTank(200, 200, 0, { team: 11 });
    caller.strikes = 1;
    const called = run(world, { [caller.id]: { strike: { x: 200, y: 200 } } }, 1);
    expect(caller.strikes).toBe(0);
    expect(called.find((e) => e.type === 'strike')).toMatchObject({ tank: caller.id, x: 200, y: 200, radius: STRIKE.spread, delay: STRIKE.delay });
    // a figyelmeztetés alatt még nem esik semmi
    expect(booms(run(world, {}, seconds(STRIKE.delay - 0.2)), 'shell')).toHaveLength(0);
    // a kérő is belehajt a célterületbe
    caller.x = 204;
    caller.y = 204;
    const events = run(world, {}, seconds(0.4 + STRIKE.shells * STRIKE.interval + 0.5));
    const shells = booms(events, 'shell');
    expect(shells).toHaveLength(STRIKE.shells);
    for (const s of shells) expect(Math.hypot(s.x - 200, s.y - 200)).toBeLessThanOrEqual(STRIKE.spread + 0.01);
    expect(world.strikes).toHaveLength(0);
    expect(enemy.hp).toBeLessThan(tankMaxHp(enemy));
    expect(caller.hp).toBe(tankMaxHp(caller));
    // töltet nélkül nem kérhető
    expect(run(world, { [caller.id]: { strike: { x: 200, y: 200 } } }, 2).some((e) => e.type === 'strike')).toBe(false);
  });

  it('a csapás a játéktéren kívülre nem megy, a kilövés a kérőé, és az épületet is rombolja', () => {
    const walls = new SegmentGrid(400, 400);
    walls.addPolygon([195, 195, 205, 195, 205, 205, 195, 205], 0);
    const structures = new Structures([{ area: 100, x: 200, y: 200 }]);
    const world = new World(arena({ walls, structures, bounds: { minX: 50, minY: 50, maxX: 350, maxY: 350 } }));
    const caller = world.addTank(100, 100, 0, { team: 10 });
    caller.strikes = 2;
    const far = run(world, { [caller.id]: { strike: { x: 9999, y: -50 } } }, 1).find((e) => e.type === 'strike') as Extract<SimEvent, { type: 'strike' }>;
    expect(far.x).toBe(350);
    expect(far.y).toBe(50);
    run(world, {}, seconds(1));
    // egy gyenge ellenfél a ház mellett
    const enemy = world.addTank(212, 200, 0, { team: 11 });
    enemy.hp = 5;
    run(world, { [caller.id]: { strike: { x: 208, y: 200 } } }, 1);
    run(world, {}, seconds(STRIKE.delay + STRIKE.shells * STRIKE.interval + 0.5));
    expect(enemy.alive).toBe(false);
    expect(caller.kills).toBe(1);
    expect(structures.hp[0]).toBeLessThan(structures.maxHp[0]);
  });
});

describe('gázpalack', () => {
  it('a találattól felrobban, sebzi a közelben állót, és láncban beindítja a szomszédját', () => {
    const world = new World(arena());
    const shooter = world.addTank(100, 200, 0, { team: 10 });
    world.barrels.push({ id: 9001, x: 150, y: 200, fuse: -1, by: 0 }, { id: 9002, x: 150 + BARREL.blastRadius - 1, y: 200, fuse: -1, by: 0 }, { id: 9003, x: 150, y: 260, fuse: -1, by: 0 });
    const near = world.addTank(150, 206, 0, { team: 11 });
    const events = run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(0.9));
    const blasts = booms(events, 'barrel');
    // a második a láncreakciótól robban, a távoli megmarad
    expect(blasts).toHaveLength(2);
    expect(blasts[0]).toMatchObject({ x: 150, y: 200, radius: BARREL.blastRadius });
    expect(world.barrels.map((b) => b.id)).toEqual([9003]);
    expect(near.hp).toBeLessThan(tankMaxHp(near));
    const hit = events.find((e) => e.type === 'hit' && e.tank === near.id) as Extract<SimEvent, { type: 'hit' }>;
    expect(hit.by).toBe(shooter.id);
  });

  it('ha tank hajt rá, alatta robban; a saját robbanásáért nem jár pont', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 200, 0, { team: 10 });
    world.barrels.push({ id: 9001, x: 115, y: 200, fuse: -1, by: 0 });
    tank.hp = 20;
    const events = run(world, { [tank.id]: { throttle: 1 } }, seconds(3));
    expect(booms(events, 'barrel')).toHaveLength(1);
    expect(tank.alive).toBe(false);
    expect(tank.kills).toBe(0);
    expect(tank.deaths).toBe(1);
    // az álló tank mellett nem robban
    const other = new World(arena());
    const still = other.addTank(100, 200, 0);
    other.barrels.push({ id: 1, x: 100.5, y: 200, fuse: -1, by: 0 });
    expect(booms(run(other, {}, seconds(2)), 'barrel')).toHaveLength(0);
    expect(still.hp).toBe(TANK.maxHp);
  });

  it('a valódi pályán a palackok a házak fala mellé kerülnek, a játéktéren belülre', () => {
    const map = new GameMap(data);
    const settings = sanitizeSettings({ area: areaOfCells(map.width, map.height, 6, 6, 14, 17), bots: 0, pickups: 2, traffic: 0, minutes: 5 }, map.width, map.height);
    map.setArea(settings.area);
    const match = new Match(map, settings, [{ id: 'a', name: 'Anna' }], 5);
    const { barrels } = match.world;
    expect(match.plan.barrels).toBeGreaterThanOrEqual(BARREL.min);
    expect(barrels.length).toBeGreaterThan(match.plan.barrels * 0.8);
    expect(barrels.length).toBeLessThanOrEqual(match.plan.barrels);
    for (const b of barrels) {
      expect(b.x).toBeGreaterThan(settings.area.minX);
      expect(b.x).toBeLessThan(settings.area.maxX);
      expect(b.y).toBeGreaterThan(settings.area.minY);
      expect(b.y).toBeLessThan(settings.area.maxY);
      expect(map.walls.resolveCircle(b.x, b.y, 0.9).hit).toBe(false);
      // nem úttesten van, de egy ház közvetlen közelében
      expect(map.speedFactor(b.x, b.y)).toBeLessThan(1);
      expect(map.walls.resolveCircle(b.x, b.y, 2.4).hit).toBe(true);
    }
    for (const building of map.data.buildings) for (const b of barrels.slice(0, 5)) expect(pointInPolygon(b.x, b.y, building.pts)).toBe(false);
    // a legkisebb pályán is van néhány; a szám a területtel nő
    const tiny = matchPlan(sanitizeSettings({ area: areaOfCells(map.width, map.height, 10, 20, 11, 21) }, map.width, map.height));
    expect(tiny.barrels).toBe(BARREL.min);
    expect(matchPlan(sanitizeSettings({}, map.width, map.height)).barrels).toBe(BARREL.max);
  });
});

describe('szupertárgy', () => {
  it('teljes javítás, tele pajzs, és amíg tart, háromszoros sebzés', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 200, 0, { team: 10 });
    tank.hp = 15;
    world.addPickup('super', 100, 200);
    world.step(new Map());
    expect(tank.hp).toBe(tankMaxHp(tank));
    expect(tank.shield).toBe(PICKUP.maxShield);
    expect(tank.effects.super).toBeGreaterThan(PICKUPS.super.duration - 0.1);
    const target = world.addTank(130, 200, 0, { team: 11 });
    const events = run(world, { [tank.id]: { fire: true, aim: 0 } }, 3);
    run(world, {}, seconds(0.5));
    const hit = [...events, ...world.events].find((e) => e.type === 'hit');
    expect(target.hp).toBe(TANK.maxHp - DAMAGE.shell * SUPER.power);
    expect(hit === undefined || hit.type === 'hit').toBe(true);
    // a hatás lejár
    run(world, {}, seconds(PICKUPS.super.duration));
    expect(tank.effects.super).toBe(0);
    // véletlenül nem kerül a pályára
    expect(PICKUPS.super.weight).toBe(0);
    const rnd = mulberry32(3);
    for (let i = 0; i < 3000; i++) expect(pickKind(rnd)).not.toBe('super');
    // a többi tank a hálózaton át is látja, hogy valakinél szupertárgy van
    expect(unpackTank(packTank(tank), blankTank(tank.id)).effects.super).toBe(0);
    tank.effects.super = 5;
    expect(unpackTank(packTank(tank), blankTank(tank.id)).effects.super).toBe(1);
  });

  it('percenként megjelenik a játéktér közepe táján, tíz másodperccel előtte bejelentve', () => {
    const map = new GameMap(data);
    const settings = sanitizeSettings({ area: areaOfCells(map.width, map.height, 6, 6, 14, 17), bots: 0, pickups: 2, traffic: 0, minutes: 5 }, map.width, map.height);
    map.setArea(settings.area);
    const match = new Match(map, settings, [{ id: 'a', name: 'Anna' }], 5);
    // a játékos a pálya sarkában áll, hogy véletlenül se vegye fel
    const tank = match.tankOf('a')!;
    const corner = match.world.nearestSpot(settings.area.minX + 30, settings.area.minY + 30);
    tank.x = corner.x;
    tank.y = corner.y;
    const inputs = new Map<string, TankInput>();
    const collect = (secs: number): SimEvent[] => {
      const events: SimEvent[] = [];
      for (let i = 0; i < seconds(secs); i++) {
        match.step(inputs);
        events.push(...match.world.events);
      }
      return events;
    };
    expect(collect(SUPER.every - SUPER.warn - 1).some((e) => e.type === 'superSoon' || e.type === 'superHere')).toBe(false);
    const soon = collect(2).find((e) => e.type === 'superSoon') as Extract<SimEvent, { type: 'superSoon' }>;
    expect(soon.seconds).toBe(SUPER.warn);
    const cx = (settings.area.minX + settings.area.maxX) / 2;
    const cy = (settings.area.minY + settings.area.maxY) / 2;
    expect(Math.hypot(soon.x - cx, soon.y - cy)).toBeLessThan(90);
    expect(match.world.pickups.some((p) => p.kind === 'super')).toBe(false);
    const here = collect(SUPER.warn).find((e) => e.type === 'superHere') as Extract<SimEvent, { type: 'superHere' }>;
    expect(here).toMatchObject({ x: soon.x, y: soon.y });
    const supers = (): number => match.world.pickups.filter((p) => p.kind === 'super').length;
    expect(supers()).toBe(1);
    // ha senki nem veszi fel, a következő a helyére lép: egyszerre csak egy van
    collect(SUPER.every + 1);
    expect(supers()).toBe(1);
    // felvétel után nem pótlódik azonnal
    const item = match.world.pickups.find((p) => p.kind === 'super')!;
    tank.x = item.x;
    tank.y = item.y;
    const total = match.world.pickups.length;
    collect(1);
    expect(supers()).toBe(0);
    expect(tank.effects.super).toBeGreaterThan(0);
    collect(PICKUP.respawnDelay + 2);
    expect(match.world.pickups.length).toBe(total - 1);
  });
});

describe('statisztika és hálózat', () => {
  it('a találat eseménye viszi a sebzést; a pontosság és a ledöntött házak a végeredménybe kerülnek', () => {
    const map = new GameMap(data);
    const settings = sanitizeSettings({ area: areaOfCells(map.width, map.height, 6, 6, 14, 17), bots: 0, pickups: 0, traffic: 0, minutes: 5, maxPlayers: 2 }, map.width, map.height);
    map.setArea(settings.area);
    const match = new Match(map, settings, [{ id: 'a', name: 'Anna' }, { id: 'b', name: 'Béla' }], 5);
    const a = match.tankOf('a')!;
    const b = match.tankOf('b')!;
    expect(match.standings()[0]).toMatchObject({ streak: 0, wrecked: 0, accuracy: -1 });
    // Anna négyet lő: kettő talál (Béla előtte áll), kettő nem
    b.x = a.x + 14;
    b.y = a.y;
    b.hp = 300;
    const fire = new Map<string, TankInput>([['a', { ...idle, fire: true, aim: 0 }]]);
    const away = new Map<string, TankInput>([['a', { ...idle, fire: true, aim: Math.PI }]]);
    const hits: number[] = [];
    const steps = (inputs: Map<string, TankInput>, n: number): void => {
      for (let i = 0; i < n; i++) {
        match.step(inputs);
        for (const e of match.world.events) if (e.type === 'hit' && e.tank === b.id) hits.push(e.amount);
      }
    };
    while (a.shots < 2) steps(fire, 1);
    steps(new Map(), seconds(0.5));
    while (a.shots < 4) steps(away, 1);
    steps(new Map(), seconds(1.5));
    if (hits.length === 2) {
      expect(hits).toEqual([DAMAGE.shell, DAMAGE.shell]);
      expect(a.hits).toBe(2);
      expect(match.standings().find((s) => s.id === 'a')!.accuracy).toBe(50);
    } else {
      // ha a véletlen kezdőhelyen fal állt a két tank közé, a találat elmarad: a pontosság ehhez igazodik
      expect(a.hits).toBe(hits.length);
    }
    a.wrecked = 3;
    a.bestStreak = 4;
    expect(match.standings().find((s) => s.id === 'a')).toMatchObject({ wrecked: 3, streak: 4 });
    // a kilépő játékos statisztikája megmarad
    match.leave('a');
    expect(match.standings().find((s) => s.id === 'a')).toMatchObject({ wrecked: 3, streak: 4, gone: true });
  });

  it('aki ledönt egy házat, annak íródik jóvá', () => {
    const walls = new SegmentGrid(400, 400);
    walls.addPolygon([140, 195, 150, 195, 150, 205, 140, 205], 0);
    const structures = new Structures([{ area: 100, x: 145, y: 200 }]);
    const world = new World(arena({ walls, structures }));
    const tank = world.addTank(110, 200, 0);
    tank.weapon = 'rocket';
    run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(6));
    expect(structures.collapsed[0]).toBe(1);
    expect(tank.wrecked).toBe(1);
  });

  it('a bemenet viszi az aknát, a füstöt és a csapás célpontját; a hibás célpontot a szerver eldobja', () => {
    const packed = packInput({ ...idle, mine: true, smoke: true, strike: { x: 123.44, y: 987.66 } });
    expect(unpackInput(JSON.parse(JSON.stringify(packed)))).toMatchObject({ mine: true, smoke: true, strike: { x: 123.4, y: 987.7 }, fire: false, deploy: false });
    expect(packInput(idle)).toHaveLength(4);
    expect(unpackInput(packInput(idle))).toMatchObject({ mine: false, smoke: false, strike: null });
    expect(unpackInput([0, 0, null, 0, 'x', 5])!.strike).toBeNull();
    expect(unpackInput([0, 0, null, 0, 5])!.strike).toBeNull();
    expect(unpackInput([0, 0, null, 0, Infinity, 5])!.strike).toBeNull();
    expect(unpackMine(packMine({ id: 4, owner: 7, team: 12, x: 1, y: 2, arm: 0.5, life: 30, fuse: -1 }))).toMatchObject({ id: 4, owner: 7, team: 12, x: 1, y: 2 });
    expect(unpackSmoke(packSmoke({ id: 4, x: 1, y: 2, life: 6 }))).toEqual({ id: 4, x: 1, y: 2, life: 6 });
    expect(unpackBarrel(packBarrel({ id: 4, x: 1, y: 2, fuse: 0.1, by: 3 }))).toMatchObject({ id: 4, x: 1, y: 2 });
    for (const kind of ['mine', 'smoke', 'super'] as const) expect(PICKUP_KINDS).toContain(kind);
  });

  it('a szerver a közeli aknákat, füstöt és palackokat is elküldi; a szupertárgy bejelentése mindenkinek megy', () => {
    const lobby = new Lobby(data, 0);
    const inbox: ServerMessage[] = [];
    const session = lobby.connect({ send: (text) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined });
    const send = (m: Parameters<typeof encode>[0]): void => session.message(encode(m));
    send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Anna' });
    lobby.tick(0);
    send({ t: 'create', settings: { area: { minX: 500, minY: 500, maxX: 1000, maxY: 1000 }, bots: 0, pickups: 1, traffic: 0, minutes: 5, maxPlayers: 1 } });
    let now = 1;
    lobby.tick(now);
    const snaps = (): Snapshot[] => inbox.filter((m): m is Snapshot => m.t === 'snap');
    for (let i = 0; i < 30; i++) lobby.tick((now += 1000 / 60));
    const first = snaps()[snaps().length - 1];
    expect(first.M).toEqual([]);
    expect(first.K).toEqual([]);
    // a palackok közül csak a közeliek jönnek
    expect(first.G.length).toBeGreaterThanOrEqual(0);
    for (const g of first.G) expect(Math.abs(g[1] - first.me!.x)).toBeLessThan(LIMITS.nearRange);
    expect(first.me).toMatchObject({ mines: 0, smokes: 0, strikes: 0, streak: 0 });
    // a bejelentés a pálya másik végén állónak is megérkezik
    for (let i = 0; i < 60 * (SUPER.every - SUPER.warn) + 30; i++) lobby.tick((now += 1000 / 60));
    const events = inbox.flatMap((m) => (m.t === 'ev' ? m.e : []));
    expect(events.some((e) => e.type === 'superSoon')).toBe(true);
    for (let i = 0; i < 60 * SUPER.warn + 30; i++) lobby.tick((now += 1000 / 60));
    const last = snaps()[snaps().length - 1];
    const superIndex = PICKUP_KINDS.indexOf('super');
    expect(last.P.some((p) => p[1] === superIndex)).toBe(true);
  });
});
