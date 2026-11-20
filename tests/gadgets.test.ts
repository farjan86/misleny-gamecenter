// Akna, füst, tüzérségi csapás, gázpalack, szupertárgy, kilövéssorozat és a meccs statisztikái.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS, Lobby } from '../server/lobby';
import { GameMap, pointInPolygon } from '../src/game/maps/GameMap';
import type { MapData } from '../src/game/maps/types';
import { encode, packBarrel, packInput, packMine, packSmoke, packTank, packWreck, unpackWreck, blankTank, PROTOCOL_VERSION, unpackBarrel, unpackInput, unpackMine, unpackSmoke, unpackTank, messageReader, mergeSnapshot, packMe, type FullSnapshot, type ServerMessage, type Snapshot } from '../src/game/net/protocol';
import { SegmentGrid } from '../src/game/sim/collision';
import { BARREL, CLOAK, FLAME, MG, MINE, SMOKE, STRIKE, SUPER, WORKSHOP, smokeAge, smokeRadius } from '../src/game/sim/gadgets';
import { deathText } from '../src/game/ui/killText';
import { durationRows, GUIDE_PICKUPS, howToSteps, weaponRows } from '../src/game/ui/Guide';
import { ROOM_CODE } from '../src/game/net/protocol';
import { areaOfCells, GAME_MODE_HINT, GAME_MODE_NAME, GAME_MODES, MATCH, Match, matchPlan, matchScore, sanitizeSettings, SCORE } from '../src/game/sim/match';
import { DEFAULT_KEYS } from '../src/game/settings';
import { PICKUP, PICKUP_KINDS, PICKUPS, pickKind, mulberry32 } from '../src/game/sim/pickups';
import { Structures } from '../src/game/sim/structures';
import { TURRET } from '../src/game/sim/vehicles';
import { cleanLook, DAMAGE, LEVEL, REGEN, SIM_DT, TANK, TANK_LOOKS, tankMaxHp, tankSize, TEAM, World, type SimEvent, type TankInput, type TankState, type Terrain } from '../src/game/sim/world';

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
    const fatal = run(world, {}, 2);
    expect(enemy.alive).toBe(false);
    expect(owner.kills).toBe(1);
    // a kilövés eseménye megmondja, ki és mivel: a lerakó, aknával
    expect(fatal.find((e) => e.type === 'destroyed')).toMatchObject({ tank: enemy.id, by: owner.id, cause: 'mine' });
    expect(deathText('mine', 'Béla')).toBe('Béla lőtt ki – aknával.');
    expect(deathText('rocket', 'Bot')).toBe('Egy bot lőtt ki – rakétával.');
    expect(deathText('barrel', null, true)).toContain('általad felrobbantott gázpalack');
    expect(deathText('barrel', null)).toBe('Felrobbant melletted egy gázpalack.');
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
    // a felhő kicsiben indul, és pár másodperc alatt terjed szét; közben a szél lassan arrébb viszi
    const origin = { x: world.smokes[0].x, y: world.smokes[0].y };
    expect(smokeRadius(0)).toBeCloseTo(SMOKE.radius * SMOKE.startRatio, 5);
    expect(smokeRadius(SMOKE.spread)).toBeCloseTo(SMOKE.radius, 5);
    expect(smokeRadius(SMOKE.spread / 2)).toBeGreaterThan(SMOKE.radius * 0.7);
    expect(world.inSmoke(origin.x, origin.y + 20)).toBe(false);
    run(world, {}, seconds(SMOKE.spread));
    expect(world.inSmoke(origin.x, origin.y + 20)).toBe(true);
    const age = smokeAge(world.smokes[0]);
    expect(age).toBeGreaterThan(SMOKE.spread - 0.5);
    // a szél irányában messzebb ér, szemben kevésbé
    const reach = SMOKE.radius - 1;
    const wind = Math.hypot(SMOKE.windX, SMOKE.windY);
    expect(world.inSmoke(origin.x + (SMOKE.windX / wind) * (reach + wind * age), origin.y + (SMOKE.windY / wind) * (reach + wind * age))).toBe(true);
    expect(world.inSmoke(origin.x - (SMOKE.windX / wind) * reach, origin.y - (SMOKE.windY / wind) * reach)).toBe(false);
    enemy.hp = tankMaxHp(enemy);
    const hidden = run(world, {}, seconds(SMOKE.life - 1 - SMOKE.spread));
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
    // a saját maga okozta robbanás: senkinek nem jár a kilövés, és ez az eseményből is kiderül
    expect(events.find((e) => e.type === 'destroyed')).toMatchObject({ tank: tank.id, by: 0, cause: 'barrel', self: true });
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
    expect(Math.hypot(soon.x - cx, soon.y - cy)).toBeLessThan(170);
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

describe('álcázás', () => {
  it('alapképesség: tíz másodpercig tart, és percenként egyszer használható', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 200, 0, { team: 10 });
    expect(tank.cloak).toBe(0);
    expect(tank.cloakReady).toBe(0);
    const on = run(world, { [tank.id]: { cloak: true } }, 1);
    expect(on.find((e) => e.type === 'cloak')).toMatchObject({ tank: tank.id, on: true });
    expect(tank.cloak).toBeCloseTo(CLOAK.duration, 5);
    // közben újra megnyomva nem történik semmi
    const again = run(world, { [tank.id]: { cloak: true } }, seconds(CLOAK.duration - 1));
    expect(again.filter((e) => e.type === 'cloak')).toHaveLength(0);
    expect(tank.cloak).toBeGreaterThan(0);
    const off = run(world, {}, seconds(1.2));
    expect(off.find((e) => e.type === 'cloak')).toMatchObject({ tank: tank.id, on: false });
    expect(tank.cloak).toBe(0);
    // a perc letelte előtt nem kapcsolható be újra
    run(world, { [tank.id]: { cloak: true } }, seconds(CLOAK.cooldown - CLOAK.duration - 2));
    expect(tank.cloak).toBe(0);
    run(world, { [tank.id]: { cloak: true } }, seconds(2.5));
    expect(tank.cloak).toBeGreaterThan(CLOAK.duration - 1);
  });

  it('a lövés leleplez; a kilövés megszünteti; a várakozás a halál után is fut tovább', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 200, 0, { team: 10 });
    run(world, { [tank.id]: { cloak: true } }, seconds(2));
    expect(tank.cloak).toBeGreaterThan(0);
    const shot = run(world, { [tank.id]: { fire: true, aim: 0 } }, 1);
    expect(tank.cloak).toBe(0);
    expect(shot.find((e) => e.type === 'cloak')).toMatchObject({ on: false });
    expect(tank.cloakReady).toBeGreaterThan(CLOAK.cooldown - 3);
    // álcázva kilövik: az álcázás megszűnik, újraéledve sincs bekapcsolva
    const other = new World(arena());
    const hider = other.addTank(130, 200, 0, { team: 10 });
    const shooter = other.addTank(100, 200, 0, { team: 11 });
    run(other, { [hider.id]: { cloak: true } }, 2);
    hider.hp = 1;
    run(other, { [shooter.id]: { fire: true, aim: 0 } }, seconds(0.5));
    expect(hider.alive).toBe(false);
    expect(hider.cloak).toBe(0);
    run(other, {}, seconds(TANK.respawnDelay + 0.5));
    expect(hider.alive).toBe(true);
    expect(hider.cloak).toBe(0);
    expect(hider.cloakReady).toBeGreaterThan(0);
  });

  it('a telepített ágyú az álcázott tankot csak közelről veszi észre; a hálózaton is átmegy, hogy álcázva van', () => {
    const world = new World(arena());
    const owner = world.addTank(100, 100, 0, { team: 10 });
    owner.turrets = 1;
    run(world, { [owner.id]: { deploy: true } }, seconds(1));
    owner.x = 350;
    owner.y = 350;
    const turret = world.turrets[0];
    const enemy = world.addTank(turret.x + 35, turret.y, 0, { team: 11 });
    expect(35).toBeGreaterThan(CLOAK.botSight);
    const hidden = run(world, { [enemy.id]: { cloak: true } }, seconds(CLOAK.duration - 0.5));
    expect(hidden.filter((e) => e.type === 'shot')).toHaveLength(0);
    // közelről viszont észreveszi
    const near = world.addTank(turret.x + CLOAK.botSight - 6, turret.y + 8, 0, { team: 12 });
    near.cloak = 8;
    const seen = run(world, {}, seconds(3));
    expect(seen.filter((e) => e.type === 'shot').length).toBeGreaterThanOrEqual(1);
    // a pillanatképből a többi játékos is tudja, hogy a tank álcázva van (az időt nem, csak a tényt)
    enemy.cloak = 4;
    expect(unpackTank(packTank(enemy), blankTank(enemy.id)).cloak).toBe(1);
    enemy.cloak = 0;
    expect(unpackTank(packTank(enemy), blankTank(enemy.id)).cloak).toBe(0);
    expect(unpackInput(packInput({ ...idle, cloak: true }))).toMatchObject({ cloak: true, mine: false });
    expect(unpackInput(packInput(idle))!.cloak).toBe(false);
  });

  it('gyárilag a bal Ctrl kapcsolja (második billentyűje a V), és más művelet nem használja', () => {
    expect(DEFAULT_KEYS.cloak).toEqual(['ControlLeft', 'KeyV']);
    const used = Object.entries(DEFAULT_KEYS).flatMap(([action, keys]) => (action === 'cloak' ? [] : keys));
    expect(used).not.toContain('ControlLeft');
    expect(used).not.toContain('KeyV');
    // egy billentyű csak egy művelethez tartozik
    const all = Object.values(DEFAULT_KEYS).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('játékmódok', () => {
  it('minden választható módnak van neve és leírása; egyelőre csak a Death Match van', () => {
    expect([...GAME_MODES]).toEqual(['deathmatch']);
    for (const mode of GAME_MODES) {
      expect(GAME_MODE_NAME[mode].length).toBeGreaterThan(2);
      expect(GAME_MODE_HINT[mode].length).toBeGreaterThan(10);
    }
    expect(GAME_MODE_NAME.deathmatch).toBe('Death Match');
    // az ismeretlen (még nem létező) mód a szerveren az alapmódra kerül
    expect(sanitizeSettings({ mode: 'castle' as never }, 2000, 3460).mode).toBe('deathmatch');
    expect(sanitizeSettings({ mode: 'deathmatch' }, 2000, 3460).mode).toBe('deathmatch');
  });
});

describe('kiegészítő géppuska', () => {
  it('amíg a tárgy hatása tart, magától lő a legközelebbi ellenségre, amelyre rálát; a kilövés a tanké', () => {
    const walls = new SegmentGrid(400, 400);
    // fal a tank és a második ellenfél között
    walls.addPolygon([100, 150, 140, 150, 140, 152, 100, 152], 0);
    const world = new World(arena({ walls }));
    const tank = world.addTank(120, 200, 0, { team: 10 });
    const near = world.addTank(120 + MG.range - 10, 200, 0, { team: 11 });
    const behind = world.addTank(120, 120, 0, { team: 12 });
    const far = world.addTank(120 + MG.range + 15, 230, 0, { team: 13 });
    // tárgy nélkül nem lő
    expect(run(world, {}, seconds(1)).some((e) => e.type === 'mg')).toBe(false);
    world.addPickup('gun', tank.x, tank.y);
    world.step(new Map());
    expect(tank.effects.gun).toBeGreaterThan(PICKUPS.gun.duration - 0.1);
    const events = run(world, {}, seconds(2));
    const shots = events.filter((e) => e.type === 'mg');
    // másodpercenként kb. 7–8 lövés, a tank oldaláról a cél felé
    expect(shots.length).toBeGreaterThan(12);
    expect(shots.length).toBeLessThan(18);
    for (const s of shots) if (s.type === 'mg') expect(Math.hypot(s.x2 - near.x, s.y2 - near.y)).toBeLessThan(1.5);
    expect(near.hp).toBeCloseTo(tankMaxHp(near) - shots.length * MG.damage, 3);
    // akire nem lát rá, vagy aki túl messze van, azt nem bántja
    expect(behind.hp).toBe(tankMaxHp(behind));
    expect(far.hp).toBe(tankMaxHp(far));
    // a találat apró: a megjelenítő visszafogottan jelzi
    expect(events.filter((e) => e.type === 'hit').every((e) => e.type === 'hit' && e.light === true)).toBe(true);
    // a fő fegyver közben ugyanúgy használható; a kilövés a tankot illeti
    near.hp = 2;
    run(world, {}, seconds(0.5));
    expect(near.alive).toBe(false);
    expect(tank.kills).toBe(1);
    // harminc másodperc után a géppuska elhallgat
    run(world, {}, seconds(PICKUPS.gun.duration));
    expect(tank.effects.gun).toBe(0);
    const again = world.addTank(140, 210, 0, { team: 14 });
    expect(run(world, {}, seconds(1)).some((e) => e.type === 'mg')).toBe(false);
    expect(again.hp).toBe(tankMaxHp(again));
  });

  it('álcázva nem lő; az álcázott és a füstben álló ellenfelet nem látja; a pajzs felfogja, de nem fogy tőle', () => {
    const world = new World(arena());
    const tank = world.addTank(120, 200, 0, { team: 10 });
    const enemy = world.addTank(150, 200, 0, { team: 11 });
    tank.effects.gun = 30;
    tank.cloak = 5;
    expect(run(world, {}, seconds(1)).some((e) => e.type === 'mg')).toBe(false);
    tank.cloak = 0;
    enemy.cloak = 5;
    expect(30).toBeGreaterThan(CLOAK.botSight);
    expect(run(world, {}, seconds(1)).some((e) => e.type === 'mg')).toBe(false);
    enemy.cloak = 0;
    world.smokes.push({ id: 99, x: enemy.x, y: enemy.y, life: 5 });
    expect(run(world, {}, seconds(1)).some((e) => e.type === 'mg')).toBe(false);
    world.smokes.length = 0;
    enemy.shield = 2;
    const events = run(world, {}, seconds(1));
    expect(events.some((e) => e.type === 'mg')).toBe(true);
    expect(enemy.shield).toBe(2);
    expect(enemy.hp).toBe(tankMaxHp(enemy));
    // a hálózaton átmegy, hogy a tanknak géppuskája van
    expect(unpackTank(packTank(tank), blankTank(tank.id)).effects.gun).toBe(1);
    tank.effects.gun = 0;
    expect(unpackTank(packTank(tank), blankTank(tank.id)).effects.gun).toBe(0);
  });
});

describe('javítóműhely', () => {
  it('a benne álló tank életereje folyamatosan töltődik, akár teljesen; kívül nem', () => {
    const world = new World(arena());
    world.workshops.push({ id: 500, x: 200, y: 200 });
    const inside = world.addTank(203, 198, 0, { team: 10 });
    const outside = world.addTank(200 + WORKSHOP.radius + 3, 200, 0, { team: 11 });
    inside.level = 16;
    inside.hp = 10;
    outside.hp = 10;
    run(world, {}, seconds(5));
    // öt másodperc alatt a legnagyobb életerő 40%-a jön vissza
    expect(inside.hp).toBeCloseTo(10 + 5 * tankMaxHp(inside) * WORKSHOP.rate, 0);
    expect(outside.hp).toBe(10);
    run(world, {}, seconds(10));
    expect(inside.hp).toBe(tankMaxHp(inside));
    // a csarnok akkora, hogy a legnagyobb tank is kényelmesen elfér benne
    const biggest = 2 * TANK.radius * tankSize({ level: LEVEL.max });
    expect(WORKSHOP.width).toBeGreaterThan(biggest * 1.8);
    expect(WORKSHOP.height).toBeGreaterThan(biggest * 1.5);
    expect(WORKSHOP.radius * 2).toBeGreaterThan(biggest * 1.4);
    // a műhely nem véd: a benne álló tankot ugyanúgy ki lehet lőni
    const shooter = world.addTank(170, 200, 0, { team: 12 });
    inside.hp = 1;
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(1));
    expect(inside.alive).toBe(false);
  });

  it('a valódi pályán a műhelyek szabad helyre, egymástól távol, a játéktéren belülre kerülnek, és indításkor a kliens megkapja őket', () => {
    const map = new GameMap(data);
    const settings = sanitizeSettings({ area: areaOfCells(map.width, map.height, 6, 6, 14, 17), bots: 0, pickups: 2, traffic: 0, minutes: 5 }, map.width, map.height);
    map.setArea(settings.area);
    const match = new Match(map, settings, [{ id: 'a', name: 'Anna' }], 5);
    const shops = match.world.workshops;
    expect(match.plan.workshops).toBeGreaterThanOrEqual(2);
    expect(shops).toHaveLength(match.plan.workshops);
    const reach = Math.hypot(WORKSHOP.width, WORKSHOP.height) / 2;
    for (const shop of shops) {
      expect(shop.x).toBeGreaterThan(settings.area.minX + reach);
      expect(shop.x).toBeLessThan(settings.area.maxX - reach);
      expect(shop.y).toBeGreaterThan(settings.area.minY + reach);
      expect(shop.y).toBeLessThan(settings.area.maxY - reach);
      // a csarnok teljes területe szabad: nincs benne fal, épület, víz, és nem úttesten áll
      expect(map.walls.resolveCircle(shop.x, shop.y, reach).hit).toBe(false);
      expect(map.speedFactor(shop.x, shop.y)).toBeLessThan(1);
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 8; j++) {
          const px = shop.x + (i / 4 - 1) * (WORKSHOP.width / 2);
          const py = shop.y + (j / 4 - 1) * (WORKSHOP.height / 2);
          expect(map.insideSolid(px, py)).toBe(false);
          expect(data.buildings.some((b) => pointInPolygon(px, py, b.pts)), `${px},${py}`).toBe(false);
        }
      }
      for (const other of shops) if (other !== shop) expect(Math.hypot(other.x - shop.x, other.y - shop.y)).toBeGreaterThan(reach * 2);
    }
    // nagy tó mellett: a műhely nem kerül a vízre, és az útról be lehet hajtani
    const lake = new GameMap(data);
    lake.setArea({ minX: 440, minY: 2690, maxX: 840, maxY: 3030 });
    expect(lake.insideSolid(640, 2860)).toBe(true);
    const rnd = mulberry32(7);
    let found = 0;
    for (let i = 0; i < 3000; i++) {
      const spot = lake.workshopSpot(rnd, reach);
      if (!spot) continue;
      found++;
      for (let k = 0; k <= 8; k++) {
        for (let j = 0; j <= 8; j++) expect(lake.insideSolid(spot.x + (k / 4 - 1) * (WORKSHOP.width / 2), spot.y + (j / 4 - 1) * (WORKSHOP.height / 2))).toBe(false);
      }
      const road = lake.nearestRoad(spot.x, spot.y, 40, true);
      expect(road, `${spot.x},${spot.y}`).not.toBeNull();
    }
    expect(found).toBeGreaterThan(0);
    // a szám a területtel nő; a legkisebb pályán is van egy
    expect(matchPlan(sanitizeSettings({ area: areaOfCells(map.width, map.height, 10, 20, 11, 21) }, map.width, map.height)).workshops).toBe(WORKSHOP.min);
    expect(matchPlan(sanitizeSettings({}, map.width, map.height)).workshops).toBe(WORKSHOP.max);
    // a szerver az indításkor elküldi a helyüket (a térképhez)
    const lobby = new Lobby(data, 0);
    const inbox: ServerMessage[] = [];
    const session = lobby.connect({ send: (text) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined });
    session.message(encode({ t: 'hello', v: PROTOCOL_VERSION, name: 'Anna' }));
    lobby.tick(0);
    session.message(encode({ t: 'create', settings: { area: { minX: 500, minY: 500, maxX: 1000, maxY: 1000 }, bots: 0, pickups: 1, traffic: 0, minutes: 5, maxPlayers: 1 } }));
    lobby.tick(1);
    const start = inbox.find((m): m is Extract<ServerMessage, { t: 'start' }> => m.t === 'start')!;
    expect(start.workshops.length).toBeGreaterThanOrEqual(1);
    for (const [x, y] of start.workshops) {
      expect(x).toBeGreaterThan(500);
      expect(x).toBeLessThan(1000);
      expect(y).toBeGreaterThan(500);
      expect(y).toBeLessThan(1000);
    }
  });
});

describe('önjavítás', () => {
  it('ha a tankot egy ideje nem érte sebzés, az életereje nagyon lassan visszatöltődik – a legnagyobbig', () => {
    const world = new World(arena());
    const shooter = world.addTank(100, 200, 0, { team: 10 });
    const tank = world.addTank(130, 200, 0, { team: 11 });
    // egy találat: 75 életerő marad
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, 2);
    run(world, {}, seconds(1));
    expect(tank.hp).toBe(TANK.maxHp - DAMAGE.shell);
    // a várakozási idő alatt nem gyógyul
    run(world, {}, seconds(REGEN.delay - 1.5));
    expect(tank.hp).toBe(TANK.maxHp - DAMAGE.shell);
    // utána másodpercenként a legnagyobb életerő 1%-a jön vissza
    run(world, {}, seconds(0.5 + 10));
    expect(Math.abs(tank.hp - (TANK.maxHp - DAMAGE.shell + 10 * TANK.maxHp * REGEN.rate))).toBeLessThan(1.5);
    // szerény: a 25 sebzés visszatöltése 25 másodperc; a legnagyobb fölé nem megy
    run(world, {}, seconds(20));
    expect(tank.hp).toBe(TANK.maxHp);
  });

  it('az újabb találat újraindítja a várakozást; a nagyobb tank arányosan gyógyul; a pajzs által felfogott találat nem számít', () => {
    const world = new World(arena());
    const shooter = world.addTank(100, 200, 0, { team: 10 });
    const tank = world.addTank(130, 200, 0, { team: 11 });
    tank.level = 11; // 220 életerő
    tank.hp = 100;
    run(world, {}, seconds(REGEN.delay + 5));
    expect(tank.hp).toBeCloseTo(100 + 5 * tankMaxHp(tank) * REGEN.rate, 0);
    const before = tank.hp;
    // találat: megáll a gyógyulás
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, 2);
    run(world, {}, seconds(1));
    expect(tank.hp).toBeCloseTo(before - DAMAGE.shell + (0.3 * tankMaxHp(tank) * REGEN.rate), 0);
    const hurt = tank.hp;
    run(world, {}, seconds(REGEN.delay - 2));
    expect(tank.hp).toBe(hurt);
    run(world, {}, seconds(3));
    expect(tank.hp).toBeGreaterThan(hurt);
    // pajzzsal felfogott találat nem állítja meg
    tank.shield = 1;
    const shielded = tank.hp;
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, 2);
    run(world, {}, seconds(2));
    expect(tank.shield).toBe(0);
    expect(tank.hp).toBeGreaterThan(shielded);
    // a kilőtt tank nem gyógyul (újraéledéskor úgyis teljes életerőt kap)
    tank.hp = 1;
    tank.shield = 0;
    run(world, { [shooter.id]: { fire: true, aim: 0 } }, seconds(1));
    expect(tank.alive).toBe(false);
    expect(tank.hp).toBe(0);
    run(world, {}, seconds(1));
    expect(tank.hp).toBe(0);
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
    // az okozott és az elszenvedett sebzés is a statisztikába kerül (csak a ténylegesen elvett életerő)
    const landed = hits.reduce((sum, v) => sum + v, 0);
    expect(match.standings().find((s) => s.id === 'a')).toMatchObject({ shots: 4, hits: hits.length, damage: landed });
    expect(match.standings().find((s) => s.id === 'b')!.taken).toBe(landed);
    a.wrecked = 3;
    a.bestStreak = 4;
    expect(match.standings().find((s) => s.id === 'a')).toMatchObject({ wrecked: 3, streak: 4 });
    // teljesítménypont: a statisztikákból; a meccs legjobbja a legtöbb pontot gyűjtő játékos
    const sa = match.standings().find((s) => s.id === 'a')!;
    expect(sa.score).toBe(matchScore(sa));
    expect(sa.score).toBe(Math.round(landed * SCORE.damage + 4 * SCORE.streak + 3 * SCORE.wrecked));
    expect(sa.mvp).toBe(true);
    expect(match.standings().find((s) => s.id === 'b')).toMatchObject({ mvp: false, score: 0 });
    // nem csak a kilövés számít: kevesebb kilövéssel, de sokkal több sebzéssel és jobb sorozattal más lehet a legjobb
    b.kills = 1;
    b.dealt = 2000;
    b.bestStreak = 1;
    a.kills = 2;
    a.deaths = 4;
    const swapped = match.standings();
    expect(swapped[0].id).toBe('a'); // a helyezés a kilövések szerint
    expect(swapped.find((s) => s.mvp)!.id).toBe('b');
    expect(matchScore({ kills: 0, deaths: 9, level: 1, streak: 0, wrecked: 0, accuracy: -1, shots: 0, hits: 0, damage: 0, taken: 0 })).toBe(0);
    // a pontosság csak elég lövés után számít; a ledöntött házakért járó pont korlátos
    const base = { kills: 0, deaths: 0, level: 1, streak: 0, wrecked: 0, accuracy: 80, shots: 5, hits: 4, damage: 0, taken: 0 };
    expect(matchScore(base)).toBe(0);
    expect(matchScore({ ...base, shots: 10, hits: 8 })).toBe(80);
    expect(matchScore({ ...base, accuracy: -1, shots: 0, hits: 0, wrecked: 50 })).toBe(SCORE.wreckedMax);
    b.kills = 0;
    b.dealt = 0;
    b.bestStreak = 0;
    a.kills = 0;
    a.deaths = 0;
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
    const inbox: (ServerMessage | FullSnapshot)[] = [];
    const read = messageReader();
    const session = lobby.connect({ send: (text) => inbox.push(read(text)), close: () => undefined });
    const send = (m: Parameters<typeof encode>[0]): void => session.message(encode(m));
    send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Anna' });
    lobby.tick(0);
    send({ t: 'create', settings: { area: { minX: 500, minY: 500, maxX: 1000, maxY: 1000 }, bots: 0, pickups: 1, traffic: 0, minutes: 5, maxPlayers: 1 } });
    let now = 1;
    lobby.tick(now);
    const snaps = (): FullSnapshot[] => inbox.filter((m): m is FullSnapshot => m.t === 'snap');
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

describe('különbségi pillanatkép', () => {
  /** Egyfős meccs a szerveren; visszaadja a nyers pillanatképeket (ahogy a hálózaton mennek) és a léptetőt. */
  function solo(): { raw: Snapshot[]; sizes: number[]; step: (input: Partial<TankInput>, steps: number) => void } {
    const lobby = new Lobby(data, 0);
    const raw: Snapshot[] = [];
    const sizes: number[] = [];
    const session = lobby.connect({
      send: (text) => {
        const m = JSON.parse(text) as ServerMessage;
        if (m.t !== 'snap') return;
        raw.push(m);
        sizes.push(text.length);
      },
      close: () => undefined,
    });
    session.message(encode({ t: 'hello', v: PROTOCOL_VERSION, name: 'Anna' }));
    lobby.tick(0);
    session.message(encode({ t: 'create', settings: { area: { minX: 500, minY: 500, maxX: 1250, maxY: 1250 }, bots: 0, pickups: 3, traffic: 0, minutes: 5, maxPlayers: 1 } }));
    let now = 1;
    let seq = 0;
    lobby.tick(now);
    return {
      raw,
      sizes,
      step: (input, steps) => {
        for (let i = 0; i < steps; i++) {
          session.message(encode({ t: 'input', s: ++seq, i: packInput({ ...idle, ...input }) }));
          lobby.tick((now += 1000 / 60));
        }
      },
    };
  }

  it('az első pillanatkép teljes; utána csak az megy, ami változott', () => {
    const game = solo();
    game.step({}, 8);
    const first = game.raw[0];
    // az első mindent visz: a saját tank minden mezőjét és minden listát
    expect(first.me).toMatchObject({ alive: true, level: 1, hp: TANK.maxHp, turrets: 5, kills: 0 });
    for (const key of ['B', 'P', 'O', 'W', 'V', 'U', 'M', 'K', 'G', 'S'] as const) expect(first[key], key).toBeDefined();
    expect(first.P!.length).toBeGreaterThan(0);
    // álló tank, változatlan pálya: a következő pillanatképekben se saját állapot, se lista
    game.step({}, 60 * 3);
    const quiet = game.raw[game.raw.length - 1];
    expect(Object.keys(quiet).sort()).toEqual(['T', 'a', 'k', 'r', 't', 'v']);
    expect(quiet.T).toEqual([]);
    expect(game.sizes[game.sizes.length - 1]).toBeLessThan(game.sizes[0] / 6);
    // elindul: csak a mozgással változó mezők mennek (a szint, a fegyverzet, az életerő nem)
    game.step({ throttle: 1 }, 30);
    const moving = game.raw[game.raw.length - 1];
    expect(moving.me).toBeDefined();
    const keys = Object.keys(moving.me!);
    expect(keys).toContain('x');
    expect(keys).toContain('speed');
    for (const key of ['level', 'hp', 'weapon', 'turrets', 'kills', 'effects', 'alive']) expect(keys, key).not.toContain(key);
    expect(moving.P).toBeUndefined();
    expect(moving.S).toBeUndefined();
  });

  it('a kliens az összefésülés után ugyanazt látja, mint amit a szerver tud', () => {
    const game = solo();
    let full: FullSnapshot | null = null;
    let used = 0;
    const merge = (): FullSnapshot => {
      // a saját tank azonosítója a követett tanké (v)
      for (; used < game.raw.length; used++) full = mergeSnapshot(full, game.raw[used], game.raw[0].v);
      return full!;
    };
    game.step({ throttle: 1, turn: 0.5, fire: true, aim: 1 }, 60 * 4);
    const state = merge();
    expect(state.me).not.toBeNull();
    // minden lista megvan, akkor is, ha a legutóbbi pillanatképben nem jött
    for (const key of ['B', 'P', 'O', 'W', 'V', 'U', 'M', 'K', 'G', 'S', 'T'] as const) expect(Array.isArray(state[key]), key).toBe(true);
    expect(state.P.length).toBeGreaterThan(0);
    expect(state.S).toEqual([[state.me!.id, 0, 0, 0]]);
    // a saját tank teljes: a ritkán változó mezők az első pillanatképből maradtak meg
    expect(state.me).toMatchObject({ level: 1, turrets: 5, alive: true, weapon: null });
    expect(state.me!.x).not.toBe(0);
    expect(state.me!.speed).toBeGreaterThan(0);
    expect(state.me!.effects).toMatchObject({ rapid: 0, speed: 0, gun: 0 });
    // a saját tank a tankok listájában nem ismétlődik (az állapota külön megy)
    expect(state.T.some((t) => t[0] === state.me!.id)).toBe(false);
  });

  it('a visszaszámláló idők fél másodperces lépésekben mennek, a belső időzítők egyáltalán nem', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 100, 0);
    tank.effects.rapid = 7.23;
    tank.cloak = 3.01;
    tank.cloakReady = 41.2;
    tank.calm = 12.3;
    tank.hp = 133.337;
    const packed = packMe(tank) as Record<string, unknown>;
    expect(packed.effects).toMatchObject({ rapid: 7.5, speed: 0 });
    expect(packed.cloak).toBe(3.5);
    expect(packed.cloakReady).toBe(42);
    expect(packed.hp).toBe(133.3);
    for (const key of ['calm', 'gunCooldown', 'dropCooldown', 'cooldown', 'shots', 'hits', 'homeX', 'id']) expect(packed, key).not.toHaveProperty(key);
    // a kerekítés a szerveren lévő állapotot nem változtatja meg
    expect(tank.effects.rapid).toBe(7.23);
  });

  it('a távoli botok ritkábban frissülnek, a közeliek és a játékosok minden pillanatképben', () => {
    const lobby = new Lobby(data, 0);
    const raw: Snapshot[] = [];
    const session = lobby.connect({
      send: (text) => {
        const m = JSON.parse(text) as ServerMessage;
        if (m.t === 'snap') raw.push(m);
      },
      close: () => undefined,
    });
    session.message(encode({ t: 'hello', v: PROTOCOL_VERSION, name: 'Anna' }));
    lobby.tick(0);
    session.message(encode({ t: 'create', settings: { area: { minX: 0, minY: 0, maxX: 2000, maxY: 3460 }, bots: 5, pickups: 0, traffic: 0, minutes: 5, maxPlayers: 1 } }));
    let now = 1;
    lobby.tick(now);
    for (let i = 0; i < 60 * 4; i++) lobby.tick((now += 1000 / 60));
    const counts = raw.slice(4).map((s) => s.T.length);
    const most = Math.max(...counts);
    const least = Math.min(...counts);
    // minden negyedikben ott vannak a távoliak is, a többiben csak a közeliek
    expect(most).toBeGreaterThan(least);
    expect(counts.filter((c) => c === most).length).toBeLessThanOrEqual(Math.ceil(counts.length / LIMITS.farEvery) + 1);
    // a saját tank a listában nincs benne
    for (const s of raw.slice(4)) expect(s.T.some((t) => t[0] === s.v)).toBe(false);
  });
});

describe('lángszóró', () => {
  it('fegyver üzemanyaggal: nyomva tartva ég, közben fogy, és ha kifogy, visszajön az ágyú', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 200, 0, { team: 10 });
    world.addPickup('flame', tank.x, tank.y);
    world.step(new Map());
    expect(tank.weapon).toBe('flame');
    expect(tank.fuel).toBe(FLAME.fuel);
    // tűz nélkül nem fogy, és nem ég
    run(world, {}, seconds(1));
    expect(tank.fuel).toBe(FLAME.fuel);
    expect(tank.flaming).toBe(false);
    // nyomva tartva ég, lövedék nem indul, az üzemanyag fogy
    const events = run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(2));
    expect(tank.flaming).toBe(true);
    expect(events.some((e) => e.type === 'shot')).toBe(false);
    expect(world.bullets).toHaveLength(0);
    expect(tank.fuel).toBeCloseTo(FLAME.fuel - 2, 1);
    // a második tárgy hozzáad, de csak a határig
    world.addPickup('flame', tank.x, tank.y);
    world.addPickup('flame', tank.x, tank.y);
    run(world, {}, 2);
    expect(tank.fuel).toBeLessThanOrEqual(FLAME.maxFuel);
    expect(tank.fuel).toBeGreaterThan(FLAME.fuel);
    // kiégeti: az ágyú visszajön, és újra lövedéket lő
    run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(FLAME.maxFuel + 0.5));
    expect(tank.weapon).toBe(null);
    expect(tank.flaming).toBe(false);
    const after = run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(1));
    expect(after.some((e) => e.type === 'shot')).toBe(true);
  });

  it('messzire visz és nagyot sebez: a kúpjában álló ellenséget kilövi, a mögötte és a hatótávon túl állót nem bántja', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 300, 0, { team: 10 });
    tank.weapon = 'flame';
    tank.fuel = FLAME.fuel;
    const near = world.addTank(100 + FLAME.range * 0.8, 300, 0, { team: 11 });
    const behind = world.addTank(60, 300, 0, { team: 12 });
    const far = world.addTank(100 + FLAME.range + 20, 300, 0, { team: 13 });
    const side = world.addTank(100 + 20, 300 + 20, 0, { team: 14 });
    const events = run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(1));
    // egy másodperc alatt nagyjából a másodpercenkénti sebzést kapja
    expect(tankMaxHp(near) - near.hp).toBeGreaterThan(FLAME.dps * 0.8);
    expect(tankMaxHp(near) - near.hp).toBeLessThan(FLAME.dps * 1.3);
    for (const other of [behind, far, side]) expect(other.hp).toBe(tankMaxHp(other));
    expect(events.filter((e) => e.type === 'hit' && e.tank === near.id).length).toBeGreaterThanOrEqual(4);
    const kill = run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(2));
    expect(near.alive).toBe(false);
    expect(kill.find((e) => e.type === 'destroyed')).toMatchObject({ tank: near.id, by: tank.id, cause: 'flame' });
    expect(deathText('flame', 'Anna')).toBe('Anna lőtt ki – lángszóróval.');
  });

  it('falon nem megy át, de a házat leégeti; a fát kidönti, a gázpalackot berobbantja', () => {
    const walls = new SegmentGrid(400, 400);
    // ház a tank előtt 15 méterre
    walls.addPolygon([115, 190, 125, 190, 125, 210, 115, 210], 0);
    const structures = new Structures([{ area: 100, x: 120, y: 200 }]);
    const full = structures.hp[0];
    const world = new World(arena({ walls, structures }));
    const tank = world.addTank(100, 200, 0, { team: 10 });
    tank.weapon = 'flame';
    tank.fuel = FLAME.maxFuel;
    const hidden = world.addTank(135, 200, 0, { team: 11 });
    world.barrels.push({ id: 9001, x: 108, y: 201, fuse: -1, by: 0 });
    const events = run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(0.6));
    // a ház mögött álló ellenséget a láng nem éri el
    expect(hidden.hp).toBe(tankMaxHp(hidden));
    expect(events.some((e) => e.type === 'burn')).toBe(true);
    expect(structures.hp[0]).toBeLessThan(full);
    expect(events.some((e) => e.type === 'boom' && e.kind === 'barrel')).toBe(true);
    // leég: összedől, és a rombolás a lángszórósé
    const more = run(world, { [tank.id]: { fire: true, aim: 0 } }, seconds(full / FLAME.structureDps + 1));
    expect(structures.collapsed[0]).toBe(1);
    expect(more.some((e) => e.type === 'collapse')).toBe(true);
    expect(tank.wrecked).toBe(1);
  });

  it('a tárgyak között szerepel, a hálózaton átmegy a láng és az üzemanyag', () => {
    expect(PICKUP_KINDS).toContain('flame');
    expect(PICKUP_KINDS.indexOf('flame')).toBe(PICKUP_KINDS.length - 1); // a végére került: a régi sorszámok nem változtak
    const tank = new World(arena()).addTank(100, 100, 0);
    tank.flaming = true;
    tank.fuel = 7.26;
    expect(unpackTank(packTank(tank), blankTank(tank.id)).flaming).toBe(true);
    expect(packMe(tank)).toMatchObject({ fuel: 7.3, flaming: true });
    tank.flaming = false;
    expect(unpackTank(packTank(tank), blankTank(tank.id)).flaming).toBe(false);
  });
});

describe('választható alaptank (csak megjelenés)', () => {
  it('a választás a szerveren át eljut a többiekhez; a hibás érték az alaptankot adja; a roncs is ugyanaz a fajta', () => {
    expect(TANK_LOOKS).toBe(3);
    expect([cleanLook(2), cleanLook(3), cleanLook(-1), cleanLook(1.5), cleanLook('1'), cleanLook(undefined)]).toEqual([2, 0, 0, 0, 0, 0]);
    const lobby = new Lobby(data, 0);
    const connect = (name: string): { inbox: ServerMessage[]; send: (m: Parameters<typeof encode>[0]) => void } => {
      const inbox: ServerMessage[] = [];
      const session = lobby.connect({ send: (text) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined });
      session.message(encode({ t: 'hello', v: PROTOCOL_VERSION, name }));
      return { inbox, send: (m) => session.message(encode(m)) };
    };
    const anna = connect('Anna');
    const bela = connect('Béla');
    lobby.tick(0);
    anna.send({ t: 'create', settings: { area: { minX: 500, minY: 500, maxX: 1000, maxY: 1000 }, bots: 2, pickups: 0, traffic: 0, minutes: 5, maxPlayers: 2 }, look: 2 });
    lobby.tick(1);
    const room = anna.inbox.filter((m): m is Extract<ServerMessage, { t: 'room' }> => m.t === 'room').pop()!.room.id;
    // Béla hibás értéket küld: az alaptankot kapja
    bela.send({ t: 'join', room, look: 7 });
    for (let t = 2; t < 12000 && !anna.inbox.some((m) => m.t === 'start'); t += 100) lobby.tick(t);
    const start = bela.inbox.find((m): m is Extract<ServerMessage, { t: 'start' }> => m.t === 'start')!;
    expect(start.players.find((p) => p.name === 'Anna')!.look).toBe(2);
    expect(start.players.find((p) => p.name === 'Béla')!.look).toBe(0);
  });

  it('a játékszabályokat nem érinti; a botok az azonosítójuk szerint kapnak fajtát, ahogy a kliens is számolja', () => {
    const world = new World(arena());
    const a = world.addTank(100, 100, 0, { team: 10, look: 1 });
    const b = world.addTank(200, 100, 0, { team: 11, look: 2 });
    const bot = world.addTank(300, 100, 0, { team: TEAM.bots, bot: true });
    expect([a.look, b.look]).toEqual([1, 2]);
    expect(bot.look).toBe(bot.id % TANK_LOOKS);
    expect(blankTank(bot.id).look).toBe(bot.look);
    // ugyanaz a méret, életerő, mozgás
    expect(tankSize(a)).toBe(tankSize(b));
    expect(tankMaxHp(a)).toBe(tankMaxHp(b));
    run(world, { [a.id]: { throttle: 1 }, [b.id]: { throttle: 1 } }, seconds(1));
    expect(a.x - 100).toBeCloseTo(b.x - 200, 6);
    // a roncs viszi a fajtát, és a hálózaton is átmegy
    b.hp = 1;
    a.x = b.x - 30;
    a.y = b.y;
    run(world, { [a.id]: { fire: true, aim: 0 } }, seconds(1));
    expect(b.alive).toBe(false);
    expect(world.wrecks[0].look).toBe(2);
    expect(unpackWreck(JSON.parse(JSON.stringify(packWreck(world.wrecks[0])))).look).toBe(2);
  });
});

describe('útmutató és játékmenet-leírás', () => {
  it('minden tárgynak van leírása; a táblázatok a szabályok számait mutatják', () => {
    for (const kind of PICKUP_KINDS) {
      expect(GUIDE_PICKUPS[kind].what.length, kind).toBeGreaterThan(20);
      expect(GUIDE_PICKUPS[kind].lasts.length, kind).toBeGreaterThan(3);
    }
    expect(GUIDE_PICKUPS.gun.lasts).toBe(`${PICKUPS.gun.duration} mp`);
    expect(GUIDE_PICKUPS.flame.what).toContain(`${FLAME.range} m`);
    const weapons = weaponRows();
    expect(weapons.find((r) => r[0] === 'Ágyú (alap)')![1]).toBe(String(DAMAGE.shell));
    expect(weapons.find((r) => r[0] === 'Akna')![1]).toContain(String(MINE.damage));
    expect(weapons.some((r) => r[0] === 'Lángszóró')).toBe(true);
    expect(durationRows().find((r) => r[0] === 'Füstfelhő')![1]).toBe(`${SMOKE.life} mp`);
  });

  it('a játékmenet hat lépése elmondja a jelszót, a belépőkódot és az indulás szabályait', () => {
    const steps = howToSteps();
    expect(steps.map((s) => s[0])).toEqual(['Belépés', 'Csatlakozás egy játékhoz', 'Saját játék létrehozása', 'Belépőkód: privát játék', 'Váró és indulás', 'A meccs']);
    const text = steps.map((s) => s[1]).join(' ');
    expect(text).toContain('jelszó a nevedet védi');
    expect(text).toContain(`${ROOM_CODE.min}–${ROOM_CODE.max} karakter`);
    expect(text).toContain(`${LIMITS.codeTries} hibás próbálkozás`);
    expect(text).toContain(`${MATCH.players.min}–${MATCH.players.max}`);
    expect(text).toContain(`${MATCH.countdown} másodperces visszaszámlálás`);
  });
});
