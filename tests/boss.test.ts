// A főgonosz (Vasóriás) és a testőrei a valódi pályán: mikor jön, mekkora, hogyan védekezik a
// falka (méhraj), mit ér a legyőzése, és hogy a botok, illetve a géppuska békén hagyják.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/game/maps/GameMap';
import type { MapData } from '../src/game/maps/types';
import { BossPack } from '../src/game/sim/boss';
import { BOSS, bossAllowed, ROLE } from '../src/game/sim/bossRules';
import { areaOfCells, Match, sanitizeSettings, type MatchSettings } from '../src/game/sim/match';
import { LEVEL, SIM_DT, TANK, tankMaxHp, tankSize, type SimEvent, type TankInput, type TankState, type World } from '../src/game/sim/world';

const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;
const seconds = (s: number): number => Math.round(s / SIM_DT);

/** Meccs a valódi pálya egy nagy részén (kb. 1 km²), alapból 10 percre. */
function setup(overrides: Partial<MatchSettings> = {}, names = ['a'], endless = false): Match {
  const map = new GameMap(data);
  const settings = sanitizeSettings({ area: areaOfCells(map.width, map.height, 6, 6, 14, 17), bots: 0, pickups: 0, traffic: 0, minutes: 10, ...overrides }, map.width, map.height);
  map.setArea(settings.area);
  return new Match(map, settings, names.map((name, i) => ({ id: `p${i}`, name })), 77, endless);
}

/** Sebzés közvetlenül (a tesztekhez): mintha `by` lőtte volna meg. */
function hurt(world: World, tank: TankState, amount: number, by: number): void {
  (world as unknown as { damage(t: TankState, a: number, by: number, x: number, y: number, cause: string): void }).damage(tank, amount, by, tank.x, tank.y, 'shell');
}

/** A meccs léptetése; a játékosok bemenete üres. */
function play(match: Match, steps: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < steps; i++) {
    match.step(new Map<string, TankInput>());
    events.push(...match.world.events);
  }
  return events;
}

/** Útmenti pont a tanyától `min`–`max` méterre. */
function spotNear(world: World, at: { x: number; y: number }, min: number, max: number): { x: number; y: number } {
  for (let i = 0; i < 4000; i++) {
    const spot = world.terrain.pickupSpot!(world.rnd);
    if (!spot) continue;
    const d = Math.hypot(spot.x - at.x, spot.y - at.y);
    if (d > min && d < max) return spot;
  }
  throw new Error('nincs megfelelő hely');
}

describe('főgonosz: mikor jön', () => {
  it('csak 10 perces vagy hosszabb (vagy nyitott) meccsben, legalább 0,2 km²-es játéktéren', () => {
    expect(bossAllowed(5, false, 1)).toBe(false);
    expect(bossAllowed(10, false, 1)).toBe(true);
    expect(bossAllowed(30, false, 0.15)).toBe(false);
    expect(bossAllowed(5, true, 0.5)).toBe(true);
    expect(setup({ minutes: 5 }).boss.enabled).toBe(false);
    expect(setup({ minutes: 10 }).boss.enabled).toBe(true);
    expect(setup({ minutes: 5 }, ['a'], true).boss.enabled).toBe(true);
  });

  it('az első a 3–5. percben érkezik, 20 másodperccel előtte bejelenti; 10 perces meccsben utána is marad legalább 5 perc', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const match = setup();
      const pack = match.boss;
      expect(pack.due).toBeGreaterThanOrEqual(BOSS.first[0]);
      expect(pack.due).toBeLessThanOrEqual(BOSS.first[1]);
      const due = pack.due;
      let soonAt = -1;
      let spawnAt = -1;
      for (let t = 0; t < 600 && spawnAt < 0; t += 0.5) {
        match.world.events = [];
        pack.step(0.5, 600 - t);
        for (const ev of match.world.events) {
          if (ev.type === 'bossSoon') soonAt = t;
          if (ev.type === 'bossSpawn') spawnAt = t;
        }
      }
      expect(soonAt, `mag ${seed}`).toBeGreaterThan(due - BOSS.warn - 1);
      expect(spawnAt).toBeGreaterThan(due - 1);
      expect(spawnAt - soonAt).toBeGreaterThan(BOSS.warn - 1);
      expect(600 - spawnAt).toBeGreaterThanOrEqual(BOSS.minLeft - 1);
    }
  });

  it('ha a megérkezése után már nem maradna 5 perc a meccsből, nem jön', () => {
    const match = setup();
    const pack = new BossPack(match.world, true);
    let spawned = false;
    // 6 perces meccs: a 3–5. perc után már nincs 5 perc hátra
    for (let t = 0; t < 360; t += 0.5) {
      match.world.events = [];
      pack.step(0.5, 360 - t);
      if (match.world.events.some((e) => e.type === 'bossSpawn' || e.type === 'bossSoon')) spawned = true;
    }
    expect(spawned).toBe(false);
    expect(pack.due).toBe(Infinity);
  });
});

describe('főgonosz: a falka', () => {
  it('a boss és négy testőr a játékosoktól távol, tágas helyen érkezik; a boss tízszer annyit bír, mint egy 20-as tank, és nagyobb', () => {
    const match = setup();
    const lair = match.boss.findLair()!;
    expect(lair).not.toBeNull();
    const player = match.tankOf('p0')!;
    expect(Math.hypot(player.x - lair.x, player.y - lair.y)).toBeGreaterThan(59);
    match.boss.spawn(lair);
    const boss = match.boss.boss!;
    const guards = match.world.tanks.filter((t) => t.role === ROLE.guard);
    expect(boss.role).toBe(ROLE.boss);
    expect(guards).toHaveLength(BOSS.guards);
    expect(tankMaxHp(boss)).toBe(tankMaxHp({ level: 20 }) * 10);
    expect(boss.hp).toBe(tankMaxHp(boss));
    expect(tankSize(boss)).toBeCloseTo(tankSize({ level: 20 }) * BOSS.sizeMult, 5);
    expect(boss.weapon).toBe('heavy');
    for (const g of guards) {
      expect(g.level).toBe(BOSS.guardLevel);
      expect(Math.hypot(g.x - boss.x, g.y - boss.y)).toBeLessThan(BOSS.ring + 4);
    }
    // a boss lassan mozog és a tanyáján marad
    play(match, seconds(30));
    expect(Math.hypot(boss.x - lair.x, boss.y - lair.y)).toBeLessThan(BOSS.wander + 6);
  });

  it('méhraj: aki megtámad egy testőrt, azt két testőr üldözi, kettő a bossnál marad', () => {
    const match = setup();
    const { world } = match;
    const lair = match.boss.findLair()!;
    match.boss.spawn(lair);
    const boss = match.boss.boss!;
    const guards = world.tanks.filter((t) => t.role === ROLE.guard);
    const player = match.tankOf('p0')!;
    const spot = spotNear(world, lair, 70, 110);
    player.x = spot.x;
    player.y = spot.y;
    player.effects.invulnerable = 1e6; // ne lőjék ki próba közben
    const before = guards.map((g) => Math.hypot(g.x - player.x, g.y - player.y));
    const events: SimEvent[] = [];
    for (let i = 0; i < seconds(8); i++) {
      // folyamatosan „támad”: a riadó nem jár le
      if (i % 60 === 0) {
        world.events = [];
        hurt(world, guards[1], 1, player.id);
        events.push(...world.events);
      }
      match.step(new Map());
      events.push(...world.events);
    }
    expect(events.some((e) => e.type === 'bossAlarm' && e.by === player.id)).toBe(true);
    const after = guards.map((g) => Math.hypot(g.x - player.x, g.y - player.y));
    // az üldözők (a boss két ellentétes oldaláról: 0. és 2.) közelebb értek a támadóhoz
    expect(after[0]).toBeLessThan(before[0] - 15);
    expect(after[2]).toBeLessThan(before[2] - 15);
    // a másik kettő a boss közelében maradt
    for (const g of [guards[1], guards[3]]) expect(Math.hypot(g.x - boss.x, g.y - boss.y)).toBeLessThan(BOSS.ring + 12);
    // a boss nem ment a támadó után
    expect(Math.hypot(boss.x - lair.x, boss.y - lair.y)).toBeLessThan(BOSS.wander + 6);
  });

  it('a legyőzője 10 szintet lép, aki sokat segített, 2-t; a boss nem éled újra, a falka elvonul, és később új jöhet', () => {
    const match = setup({}, ['a', 'b', 'c']);
    const { world } = match;
    match.boss.spawn(match.boss.findLair()!);
    const boss = match.boss.boss!;
    const [killer, helper, idler] = ['p0', 'p1', 'p2'].map((id) => match.tankOf(id)!);
    const max = tankMaxHp(boss);
    hurt(world, boss, max * 0.3, helper.id);
    hurt(world, boss, max * 0.05, idler.id);
    world.events = [];
    hurt(world, boss, max, killer.id);
    const events = world.events;
    expect(boss.alive).toBe(false);
    expect(killer.level).toBe(1 + BOSS.reward);
    expect(killer.bossKills).toBe(1);
    expect(killer.kills).toBe(0); // kilövésnek csak a játékos számít
    expect(killer.botsDown).toBe(1);
    expect(helper.level).toBe(1 + BOSS.helperReward);
    expect(idler.level).toBe(1);
    expect(events.find((e) => e.type === 'bossDown')).toMatchObject({ by: killer.id, helpers: [helper.id] });
    // a 20. szint fölé nem megy
    expect(LEVEL.max).toBe(20);
    // nem éled újra; a tankja és a testőrök eltűnnek, a következő később jön
    play(match, seconds(TANK.respawnDelay + BOSS.removeAfter + 1));
    expect(match.boss.boss).toBeUndefined();
    expect(world.tanks.some((t) => t.role !== ROLE.tank)).toBe(false);
    expect(world.wrecks.some((w) => w.role === ROLE.boss)).toBe(true);
    expect(match.boss.due).toBeGreaterThan(BOSS.again[0]);
    expect(match.standings().find((s) => s.id === 'p0')).toMatchObject({ bosses: 1, kills: 0 });
  });

  it('a boss csak hosszabb nyugalom után, lassan gyógyul', () => {
    const match = setup();
    match.boss.spawn(match.boss.findLair()!);
    const boss = match.boss.boss!;
    const max = tankMaxHp(boss);
    boss.hp = max / 2;
    boss.calm = 0;
    play(match, seconds(BOSS.healDelay - 2));
    expect(boss.hp).toBe(max / 2);
    play(match, seconds(12));
    expect(boss.hp).toBeGreaterThan(max / 2);
    expect(boss.hp).toBeLessThan(max / 2 + max * BOSS.healRate * 12);
  });

  it('a botok és a géppuska békén hagyják a falkát, és a falka is a botokat', () => {
    const match = setup({ bots: 0 });
    const { world } = match;
    const lair = match.boss.findLair()!;
    match.boss.spawn(lair);
    const pack = world.tanks.filter((t) => t.role !== ROLE.tank);
    // egy bot a falka mellé, és a játékos géppuskával a közelbe
    const near = spotNear(world, lair, 25, 45);
    match.bots.setCount(0, 1, -1);
    const bot = world.addTank(near.x, near.y, 0, { team: 1, bot: true });
    const player = match.tankOf('p0')!;
    const close = spotNear(world, lair, 30, 38);
    player.x = close.x;
    player.y = close.y;
    player.effects.gun = 60;
    player.effects.invulnerable = 1e6;
    const events = play(match, seconds(10));
    const hits = events.filter((e) => e.type === 'hit' && pack.some((t) => t.id === e.tank));
    expect(hits).toHaveLength(0);
    // a botot a falka nem lőtte
    expect(events.filter((e) => e.type === 'hit' && e.tank === bot.id && pack.some((t) => t.id === e.by))).toHaveLength(0);
  });
});

describe('főgonosz: a tanya', () => {
  it('nem kerül javítóműhely mellé, és a játéktér szélétől beljebb van', () => {
    for (const seed of [1, 2, 3]) {
      const match = setup();
      const lair = match.boss.findLair();
      expect(lair, `mag ${seed}`).not.toBeNull();
      for (const w of match.world.workshops) expect(Math.hypot(w.x - lair!.x, w.y - lair!.y)).toBeGreaterThanOrEqual(40);
      const { area } = match.settings;
      expect(lair!.x).toBeGreaterThan(area.minX + 29);
      expect(lair!.y).toBeGreaterThan(area.minY + 29);
    }
  });
});
