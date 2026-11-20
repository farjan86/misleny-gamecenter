// Civil forgalom és telepíthető ágyú: úthálózat, vezetés, ütközés, találat,
// robbanás, rakomány, összelapítás; az ágyú lerakása, célzása és kilövése.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Lobby } from '../server/lobby';
import { GameMap, nearestOnPolyline } from '../src/game/maps/GameMap';
import type { MapData } from '../src/game/maps/types';
import { encode, packInput, packTurret, packVehicle, PROTOCOL_VERSION, unpackInput, unpackTurret, unpackVehicle, messageReader, type FullSnapshot, type ServerMessage } from '../src/game/net/protocol';
import { BotBrain } from '../src/game/sim/bots';
import { SegmentGrid } from '../src/game/sim/collision';
import { MATCH, matchPlan, sanitizeSettings } from '../src/game/sim/match';
import { CARGO_KINDS, PICKUP } from '../src/game/sim/pickups';
import { RoadNet, type NetRoad } from '../src/game/sim/roadnet';
import { Traffic, TRAFFIC, trafficMix } from '../src/game/sim/traffic';
import { TURRET, turretInterval, turretMaxHp, turretRange, VEHICLE, VEHICLES, VSTATE } from '../src/game/sim/vehicles';
import { CRUSH, DAMAGE, SIM_DT, TANK, World, type SimEvent, type TankInput, type Terrain } from '../src/game/sim/world';

const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;

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

/** 400 × 400 m-es üres pálya; `roads`: a közutak. */
function field(roads: NetRoad[] = [], extra: Partial<Terrain> = {}): Terrain {
  return { width: 400, height: 400, walls: new SegmentGrid(400, 400), speedFactor: () => 1, driveRoads: () => roads, ...extra };
}
/** Kelet–nyugati főút a pálya közepén, a két széléig. */
const MAIN_ROAD: NetRoad = { pts: [0, 200, 200, 200, 400, 200], width: 11, main: true };
/** Mellékutca délről, amely a főútba torkollik. */
const SIDE_STREET: NetRoad = { pts: [200, 400, 200, 200], width: 11, main: false };
const WHOLE = { minX: 0, minY: 0, maxX: 400, maxY: 400 };

describe('úthálózat', () => {
  it('az utak a közös pontjaiknál csomópontot kapnak, a pálya szélén kaput', () => {
    const net = new RoadNet([MAIN_ROAD, SIDE_STREET], WHOLE);
    expect(net.nodes).toHaveLength(4);
    expect(net.nodes.filter((n) => n.gate)).toHaveLength(3);
    // három útszakasz, mindkét irányban; a kapukból egy-egy él indul befelé
    expect(net.drivable()).toHaveLength(6);
    expect(net.entries).toHaveLength(3);
    expect(net.length).toBeCloseTo(600, 3);
    const junction = net.nodes.find((n) => !n.gate)!;
    expect(junction).toMatchObject({ x: 200, y: 200 });
    expect(junction.out).toHaveLength(3);
  });

  it('a játéktéren kívüli rész levágódik, a határon kapu keletkezik', () => {
    const net = new RoadNet([MAIN_ROAD, SIDE_STREET], { minX: 100, minY: 100, maxX: 300, maxY: 300 });
    expect(net.length).toBeCloseTo(300, 3);
    const gates = net.nodes.filter((n) => n.gate).map((n) => `${n.x},${n.y}`).sort();
    expect(gates).toEqual(['100,200', '200,300', '300,200']);
  });

  it('a zsákutcára nem megy forgalom', () => {
    const deadEnd: NetRoad = { pts: [100, 200, 100, 120], width: 9.5, main: false };
    const net = new RoadNet([{ pts: [0, 200, 100, 200, 400, 200], width: 11, main: true }, deadEnd], WHOLE);
    expect(net.length).toBeCloseTo(400, 3);
    for (const e of net.drivable()) expect(e.pts.every((v, i) => i % 2 === 0 || v === 200)).toBe(true);
  });

  it('a sáv a haladási irány jobb oldalán van', () => {
    const net = new RoadNet([MAIN_ROAD], WHOLE);
    const east = net.drivable().find((e) => Math.abs(e.startAngle) < 0.1)!;
    const west = net.edges[east.reverse];
    const p = { x: 0, y: 0, angle: 0 };
    // kelet felé haladva a jobb oldal dél (a képernyőn lefelé, y nő)
    expect(net.pointAt(east, 50, 2.75, p).y).toBeCloseTo(202.75, 5);
    expect(net.pointAt(west, 50, 2.75, p).y).toBeCloseTo(197.25, 5);
  });

  it('a stopvonal ahhoz az élhez tartozik, amelyik felőle érkezik a kereszteződésbe', () => {
    // a mellékutca észak felé (−90°) érkezik a főútra; a vonal 8 m-rel a kereszteződés előtt van
    const net = new RoadNet([MAIN_ROAD, SIDE_STREET], WHOLE, [202.75, 208, -Math.PI / 2, 2.4]);
    const stops = net.drivable().filter((e) => e.stop > 0);
    expect(stops).toHaveLength(1);
    expect(stops[0].stop).toBeCloseTo(8, 5);
    expect(net.nodes[stops[0].from]).toMatchObject({ x: 200, y: 400 });
  });
});

describe('a forgalom közlekedése', () => {
  it('a járművek a jobb oldali sávban haladnak, a pálya szélén távoznak, és helyettük újak érkeznek', () => {
    const world = new World(field([MAIN_ROAD]), 3);
    const traffic = new Traffic(world, 3);
    world.traffic = traffic;
    expect(world.vehicles).toHaveLength(3);
    const ids = new Set<number>();
    let lane = 0;
    let driving = 0;
    const steps = seconds(150);
    for (let i = 0; i < steps; i++) {
      world.step(new Map());
      driving += traffic.count;
      for (const v of world.vehicles) {
        ids.add(v.id);
        expect(world.vehicles.length).toBeLessThanOrEqual(3);
        if (v.x < 10 || v.x > 390) continue;
        // kelet felé a déli, nyugat felé az északi sávban
        const east = Math.cos(v.angle) > 0;
        lane = Math.max(lane, Math.abs(v.y - (east ? 202.75 : 197.25)));
      }
    }
    expect(lane).toBeLessThan(0.6);
    expect(ids.size).toBeGreaterThan(6);
    // a kihajtott jármű helyett néhány másodperc múlva jön a következő: átlagosan majdnem mind úton van
    expect(driving / steps).toBeGreaterThan(2.3);
  });

  it('többnyire személyautó jár, néhány busz és ritkán egy ellátó teherautó; busz csak ott, ahol főút is van', () => {
    expect(trafficMix(2, true)).toEqual(['car', 'car']);
    const mix = trafficMix(24, true);
    expect(mix.filter((k) => k === 'truck')).toHaveLength(2);
    expect(mix.filter((k) => k === 'bus')).toHaveLength(3);
    expect(mix.filter((k) => k === 'car')).toHaveLength(19);
    expect(trafficMix(24, false)).not.toContain('bus');
    // a személyautók formája és színe változatos
    const world = new World(field([MAIN_ROAD, SIDE_STREET]), 9);
    world.traffic = new Traffic(world, 12);
    const looks = new Set(world.vehicles.filter((v) => v.kind === 'car').map((v) => v.look));
    expect(looks.size).toBeGreaterThanOrEqual(6);
  });

  it('forgalom nélkül (0) nincs jármű, és út nélkül sem', () => {
    const world = new World(field([MAIN_ROAD]), 3);
    world.traffic = new Traffic(world, 0);
    run(world, {}, seconds(2));
    expect(world.vehicles).toHaveLength(0);
    const empty = new World(field([]), 3);
    empty.traffic = new Traffic(empty, 10);
    run(empty, {}, seconds(2));
    expect(empty.vehicles).toHaveLength(0);
  });

  it('az útját álló tank előtt megáll, dudál, majd megfordul – nem megy neki', () => {
    const world = new World(field([MAIN_ROAD]), 4);
    // egy-egy tank áll mindkét sávban, a pálya közepén
    const south = world.addTank(200, 202.75, 0);
    const north = world.addTank(200, 197.25, 0);
    south.effects.invulnerable = 0;
    world.traffic = new Traffic(world, 3);
    const events: SimEvent[] = [];
    let closest = Infinity;
    const turned = new Set<number>();
    const heading = new Map<number, number>();
    for (let i = 0; i < seconds(60); i++) {
      world.step(new Map());
      events.push(...world.events);
      for (const v of world.vehicles) {
        for (const t of [south, north]) closest = Math.min(closest, Math.hypot(v.x - t.x, v.y - t.y) - VEHICLES[v.kind].length / 2);
        const dir = Math.sign(Math.cos(v.angle));
        if (heading.has(v.id) && heading.get(v.id) !== dir && v.x > 20 && v.x < 380) turned.add(v.id);
        heading.set(v.id, dir);
      }
    }
    // a jármű orra és a tank közepe között mindig marad hely
    expect(closest).toBeGreaterThan(TANK.radius - 0.2);
    expect(events.some((e) => e.type === 'honk')).toBe(true);
    expect(turned.size).toBeGreaterThan(0);
  });

  it('a stopvonalnál megáll, mielőtt kihajt a főútra', () => {
    const world = new World(field([MAIN_ROAD, SIDE_STREET], { stopLines: [202.75, 208, -Math.PI / 2, 2.4] }), 11);
    world.traffic = new Traffic(world, 5);
    // a mellékutcán észak felé érkező járművek legkisebb sebessége a vonal előtt
    const slowest = new Map<number, number>();
    const passed = new Set<number>();
    for (let i = 0; i < seconds(240); i++) {
      world.step(new Map());
      for (const v of world.vehicles) {
        if (Math.abs(v.x - 202.75) > 1.5 || Math.sin(v.angle) > -0.8) continue;
        if (v.y > 205 && v.y < 218) slowest.set(v.id, Math.min(slowest.get(v.id) ?? Infinity, v.speed));
        if (v.y < 204 && slowest.has(v.id)) passed.add(v.id);
      }
    }
    expect(passed.size).toBeGreaterThan(2);
    for (const id of passed) expect(slowest.get(id)).toBeLessThan(0.5);
  });

  it('közeli lövésre megijednek: gyorsítanak, megállnak vagy megfordulnak', () => {
    const world = new World(field([MAIN_ROAD]), 6);
    const tank = world.addTank(200, 230, Math.PI / 2);
    world.traffic = new Traffic(world, 3);
    // megvárjuk, amíg egy jármű a tank közelébe ér
    let car = world.vehicles[0];
    for (let i = 0; i < seconds(90); i++) {
      world.step(new Map());
      const near = world.vehicles.find((v) => Math.abs(v.x - tank.x) < 12 && v.speed > 5);
      if (near) {
        car = near;
        break;
      }
    }
    expect(Math.abs(car.x - tank.x)).toBeLessThan(TRAFFIC.scareRange);
    const speed = car.speed;
    const heading = Math.sign(Math.cos(car.angle));
    // a tank dél felé lő (a járművektől elfelé): a lövés hangja ijeszt
    run(world, { [tank.id]: { fire: true } }, 2);
    let reacted = false;
    for (let i = 0; i < seconds(4) && !reacted; i++) {
      world.step(new Map());
      reacted = car.speed > speed * 1.25 || car.speed < 0.5 || Math.sign(Math.cos(car.angle)) !== heading;
    }
    expect(reacted).toBe(true);
  });

  it('a valódi pályán a járművek az úton maradnak, haladnak, és a szimuláció olcsó', () => {
    const map = new GameMap(data);
    const world = new World(map, 5);
    const traffic = new Traffic(world, 30);
    world.traffic = traffic;
    expect(traffic.net!.entries.length).toBeGreaterThan(5);
    expect(traffic.count).toBe(30);
    const roads = map.driveRoads();
    let worst = 0;
    let samples = 0;
    let stopped = 0;
    const steps = seconds(180);
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) {
      world.step(new Map());
      if (i % 30 !== 0) continue;
      for (const v of world.vehicles) {
        samples++;
        if (v.speed < 0.3) stopped++;
        if (v.x < 0 || v.y < 0 || v.x > map.width || v.y > map.height) continue;
        let off = Infinity;
        for (const r of roads) off = Math.min(off, nearestOnPolyline(v.x, v.y, r.pts).dist - r.width / 2);
        worst = Math.max(worst, off);
      }
    }
    const ms = (performance.now() - t0) / steps;
    console.log(`30 jármű a teljes pályán: ${ms.toFixed(3)} ms/lépés; az úttest szélén legfeljebb ${worst.toFixed(2)} m-rel lóg túl a jármű közepe; áll: ${((stopped / samples) * 100).toFixed(1)}%`);
    expect(worst).toBeLessThan(2.5);
    expect(stopped / samples).toBeLessThan(0.1);
    expect(traffic.count).toBeGreaterThanOrEqual(25);
    expect(ms).toBeLessThan(1);
  }, 60000);
});

describe('járművek és a tankok', () => {
  it('a jármű akadály: az alacsony szintű tank nem tud átmenni rajta', () => {
    const world = new World(field());
    const tank = world.addTank(100, 200, 0);
    const car = world.addVehicle('car', 0, 115, 200, Math.PI / 2);
    run(world, { [tank.id]: { throttle: 1 } }, seconds(3));
    // a keresztben álló autó fél szélessége + a tank sugara
    expect(tank.x).toBeLessThan(115 - VEHICLES.car.r - TANK.radius + 0.1);
    expect(car.state).toBe(VSTATE.driving);
    expect(car.hp).toBe(VEHICLES.car.hp);
  });

  it('a magas szintű tank összelapítja: nem robban fel, és át lehet hajtani rajta', () => {
    const world = new World(field());
    const tank = world.addTank(100, 200, 0);
    tank.level = CRUSH.minLevel;
    const bus = world.addVehicle('bus', 0, 118, 200, Math.PI / 2);
    const events = run(world, { [tank.id]: { throttle: 1 } }, seconds(4));
    expect(bus.state).toBe(VSTATE.flat);
    expect(events.some((e) => e.type === 'crushed')).toBe(true);
    expect(events.some((e) => e.type === 'blast')).toBe(false);
    expect(tank.x).toBeGreaterThan(125);
    // az összelapított jármű egy idő után eltűnik
    run(world, {}, seconds(VEHICLE.flatLife));
    expect(world.vehicles).toHaveLength(0);
  });

  it('a találattól kigyullad, majd felrobban: sebzi a közelben állókat, és roncs marad utána', () => {
    const world = new World(field());
    const shooter = world.addTank(100, 200, 0, { team: 10 });
    const victim = world.addTank(134, 203.5, 0, { team: 11 });
    const far = world.addTank(160, 200, 0, { team: 12 });
    const car = world.addVehicle('car', 0, 130, 200, 0);
    for (const t of [shooter, victim, far]) t.effects.invulnerable = 0;
    let events = run(world, { [shooter.id]: { fire: true } }, 1);
    events = events.concat(run(world, {}, seconds(0.8)));
    expect(car.state).toBe(VSTATE.burning);
    expect(events.some((e) => e.type === 'blast')).toBe(false);
    events = run(world, {}, seconds(VEHICLES.car.fuse));
    const blast = events.find((e) => e.type === 'blast');
    expect(blast).toMatchObject({ kind: 'car', radius: VEHICLES.car.blastRadius });
    expect(car.state).toBe(VSTATE.wreck);
    expect(victim.hp).toBeLessThan(TANK.maxHp);
    expect(victim.hp).toBeGreaterThan(TANK.maxHp - VEHICLES.car.blastDamage - 0.01);
    expect(far.hp).toBe(TANK.maxHp);
    expect(shooter.hp).toBe(TANK.maxHp);

    // a roncs akadály, és megállítja a lövedéket is
    const hpBefore = far.hp;
    run(world, { [shooter.id]: { fire: true } }, 1);
    run(world, {}, seconds(1.2));
    expect(far.hp).toBe(hpBefore);
    // egy idő után eltűnik
    run(world, {}, seconds(VEHICLE.wreckLife));
    expect(world.vehicles).toHaveLength(0);
  });

  it('a robbanás a felgyújtónak számít: kilövésért pont jár, de a saját magában tett kárért nem', () => {
    const world = new World(field());
    const shooter = world.addTank(100, 200, 0, { team: 10 });
    const victim = world.addTank(133.5, 201, 0, { team: 11 });
    victim.hp = 10;
    world.addVehicle('car', 0, 130, 200, 0);
    victim.effects.invulnerable = 0;
    run(world, { [shooter.id]: { fire: true } }, 1);
    // a lövedék a tankot is eltalálhatná: a jármű van közelebb
    const events = run(world, {}, seconds(VEHICLES.car.fuse + 1.2));
    expect(events.find((e) => e.type === 'destroyed')).toMatchObject({ tank: victim.id, by: shooter.id });
    expect(shooter.kills).toBe(1);
    expect(shooter.level).toBe(2);

    // aki a saját lövésétől felrobbanó jármű mellett áll, megsérül, de nem kap pontot érte
    const solo = new World(field());
    const self = solo.addTank(100, 200, 0);
    self.hp = 5;
    solo.addVehicle('car', 0, 105.5, 200, Math.PI / 2);
    const after = run(solo, { [self.id]: { fire: true } }, seconds(VEHICLES.car.fuse + 0.5));
    expect(after.find((e) => e.type === 'destroyed')).toMatchObject({ tank: self.id, by: 0 });
    expect(self.kills).toBe(0);
    expect(self.level).toBe(1);
  });

  it('a busz több találatot bír; az égő jármű újabb találatra azonnal robban', () => {
    const world = new World(field());
    const shooter = world.addTank(100, 200, 0);
    const bus = world.addVehicle('bus', 0, 130, 200, Math.PI / 2);
    const shot = (): SimEvent[] => run(world, { [shooter.id]: { fire: true } }, 1).concat(run(world, {}, seconds(0.6)));
    shot();
    shot();
    expect(bus.state).toBe(VSTATE.driving);
    expect(bus.hp).toBe(VEHICLES.bus.hp - 2 * DAMAGE.shell);
    shot();
    expect(bus.state).toBe(VSTATE.burning);
    const events = shot();
    expect(events.some((e) => e.type === 'blast')).toBe(true);
  });

  it('a robbanás a szomszédos járműveket is felgyújtja, és kidönti a közeli fákat', () => {
    const world = new World(field());
    const shooter = world.addTank(100, 200, 0);
    const first = world.addVehicle('car', 0, 130, 200, 0);
    const second = world.addVehicle('car', 1, 135.5, 200, 0);
    run(world, { [shooter.id]: { fire: true } }, 1);
    run(world, {}, seconds(VEHICLES.car.fuse + 0.6));
    expect(first.state).toBe(VSTATE.wreck);
    expect(second.state).toBe(VSTATE.burning);
    const events = run(world, {}, seconds(VEHICLES.car.fuse + 0.2));
    expect(events.filter((e) => e.type === 'blast')).toHaveLength(1);
    expect(second.state).toBe(VSTATE.wreck);
  });

  it('az ellátó teherautóból kilövéskor fegyverek, képességek esnek ki; felvételük után nem pótlódnak', () => {
    const world = new World(field());
    const shooter = world.addTank(100, 200, 0);
    const truck = world.addVehicle('truck', 0, 130, 200, 0);
    for (let i = 0; i < 2; i++) {
      run(world, { [shooter.id]: { fire: true } }, 1);
      run(world, {}, seconds(0.6));
    }
    expect(truck.state).toBe(VSTATE.burning);
    expect(world.pickups).toHaveLength(0);
    run(world, {}, seconds(VEHICLES.truck.fuse));
    expect(world.pickups).toHaveLength(VEHICLE.cargo);
    for (const p of world.pickups) {
      expect(CARGO_KINDS).toContain(p.kind);
      expect(p.extra).toBe(true);
      // a rakomány a roncs mellett, elérhető helyen van
      expect(Math.hypot(p.x - truck.x, p.y - truck.y)).toBeGreaterThan(VEHICLES.truck.r + TANK.radius);
    }
    // a tank felveszi mindkettőt; később sem jelenik meg helyettük új
    const [a, b] = world.pickups;
    shooter.x = a.x;
    shooter.y = a.y;
    run(world, {}, 2);
    shooter.x = b.x;
    shooter.y = b.y;
    run(world, {}, 2);
    expect(world.pickups).toHaveLength(0);
    run(world, {}, seconds(PICKUP.respawnDelay + 2));
    expect(world.pickups).toHaveLength(0);
  });

  it('a teherautó rakománya akkor is kiesik, ha egy magas szintű tank lapítja össze', () => {
    const world = new World(field());
    const tank = world.addTank(100, 200, 0);
    tank.level = CRUSH.instantLevel;
    world.addVehicle('truck', 0, 112, 200, Math.PI / 2);
    run(world, { [tank.id]: { throttle: 1 } }, seconds(1));
    expect(world.pickups.length + (tank.weapon ? 1 : 0)).toBeGreaterThanOrEqual(1);
    expect(world.vehicles[0].state).toBe(VSTATE.flat);
  });

  it('a tükörvilágban (a kliens előrejelzésében) a jármű csak akadály: nem sérül és nem mozdul', () => {
    const world = new World(field(), 1, { mirror: true });
    const tank = world.addTank(100, 200, 0);
    tank.level = CRUSH.instantLevel;
    const car = world.addVehicle('car', 0, 115, 200, Math.PI / 2);
    run(world, { [tank.id]: { throttle: 1 } }, seconds(2));
    expect(car.state).toBe(VSTATE.driving);
    expect(tank.x).toBeLessThan(115);
  });
});

describe('telepíthető ágyú', () => {
  /** Lerak egy ágyút a tank mögé, és visszaadja. */
  function deploy(world: World, tankId: number) {
    world.tank(tankId)!.turrets = 1;
    const events = run(world, { [tankId]: { deploy: true } }, 1);
    expect(events.some((e) => e.type === 'deploy')).toBe(true);
    return world.turrets[world.turrets.length - 1];
  }

  it('a felvett tárgy töltetet ad; a lerakott ágyú a tank mögé kerül, és a töltet elfogy', () => {
    const world = new World(field());
    const tank = world.addTank(100, 200, 0);
    // minden tank öt löveggel indul; a tárgy egy továbbit ad (legfeljebb nyolc lehet nála)
    expect(tank.turrets).toBe(TURRET.base);
    expect(TURRET.base).toBe(5);
    world.addPickup('turret', 100, 200);
    run(world, {}, 1);
    expect(tank.turrets).toBe(TURRET.base + 1);
    run(world, { [tank.id]: { deploy: true } }, 1);
    expect(tank.turrets).toBe(TURRET.base);
    // a botok nem kapnak löveget
    expect(world.addTank(300, 300, 0, { bot: true }).turrets).toBe(0);
    expect(world.turrets).toHaveLength(1);
    const turret = world.turrets[0];
    expect(turret).toMatchObject({ owner: tank.id, team: tank.team, hp: TURRET.hp });
    expect(turret.x).toBeLessThan(tank.x - TANK.radius - TURRET.radius);
    expect(turret.y).toBeCloseTo(200, 5);
    // töltet nélkül nem rak le többet
    tank.turrets = 0;
    run(world, { [tank.id]: { deploy: true } }, seconds(2));
    expect(world.turrets).toHaveLength(1);
  });

  it('magától lő a hatótávján belüli ellenségre – a lerakójára és a távoliakra nem', () => {
    const world = new World(field());
    const owner = world.addTank(100, 200, 0, { team: 10 });
    const enemy = world.addTank(60, 200, 0, { team: 11 });
    const distant = world.addTank(96 - TURRET.range - 25, 240, 0, { team: 12 });
    for (const t of [owner, enemy, distant]) t.effects.invulnerable = 0;
    deploy(world, owner.id);
    const events = run(world, {}, seconds(4));
    expect(events.filter((e) => e.type === 'shot').length).toBeGreaterThanOrEqual(3);
    expect(enemy.hp).toBeLessThan(TANK.maxHp);
    expect(owner.hp).toBe(TANK.maxHp);
    expect(distant.hp).toBe(TANK.maxHp);
    // a kilövés a lerakójának számít
    run(world, {}, seconds(8));
    expect(enemy.alive).toBe(false);
    expect(owner.kills).toBe(1);
  });

  it('falon át nem lát, így nem is lő', () => {
    const terrain = field();
    terrain.walls.addPolyline([80, 150, 80, 250]);
    const world = new World(terrain);
    const owner = world.addTank(100, 200, 0, { team: 10 });
    const enemy = world.addTank(60, 200, 0, { team: 11 });
    deploy(world, owner.id);
    const events = run(world, {}, seconds(4));
    expect(events.some((e) => e.type === 'shot')).toBe(false);
    expect(enemy.hp).toBe(TANK.maxHp);
  });

  it('kilőhető: az ellenség lövedéke megsemmisíti, a lerakójáé átmegy rajta', () => {
    const world = new World(field());
    const owner = world.addTank(100, 200, 0, { team: 10 });
    const turret = deploy(world, owner.id);
    // a lerakó az ágyú felé fordulva lő: a lövedék nem árt neki
    owner.hullAngle = owner.turretAngle = Math.PI;
    run(world, { [owner.id]: { fire: true, aim: Math.PI } }, 1);
    run(world, {}, seconds(1));
    expect(turret.hp).toBe(TURRET.hp);

    // az ellenség a hatótávon kívülről, nehéz lövedékkel lövi
    const enemy = world.addTank(turret.x - TURRET.range - 10, 200, 0, { team: 11 });
    enemy.weapon = 'heavy';
    const events: SimEvent[] = [];
    for (let i = 0; i < 4 && world.turrets.length; i++) {
      events.push(...run(world, { [enemy.id]: { fire: true } }, 1));
      events.push(...run(world, {}, seconds(1.2)));
    }
    expect(world.turrets).toHaveLength(0);
    expect(events.find((e) => e.type === 'turretDown')).toMatchObject({ owner: owner.id });
  });

  it('egy játékosnak egyszerre legfeljebb nyolc lövege állhat; a kiesett játékos lövegei eltűnnek', () => {
    const world = new World(field(), 1, { lives: 1 });
    const owner = world.addTank(100, 200, 0, { team: 10 });
    const first = deploy(world, owner.id);
    for (let i = 0; i < TURRET.maxPerOwner; i++) {
      owner.x = 60 + ((i * 35) % 300);
      owner.y = 120 + Math.floor(i / 8) * 40;
      run(world, {}, seconds(1));
      deploy(world, owner.id);
    }
    expect(world.turrets).toHaveLength(TURRET.maxPerOwner);
    // a legrégebbi adta át a helyét
    expect(world.turrets).not.toContain(first);

    // a kilőtt tank töltetei elvesznek; ha kiesik, az ágyúi is eltűnnek
    owner.out = true;
    run(world, {}, 2);
    expect(world.turrets).toHaveLength(0);
  });

  it('a löveg a gazdája szintjét követi: szívósabb, messzebbre lát, gyorsabban és nagyobbat lő', () => {
    // a 20. szintű tank lövege sokkal erősebb a kezdőénél
    expect(turretMaxHp(1)).toBe(TURRET.hp);
    expect(turretMaxHp(20)).toBeGreaterThan(TURRET.hp * 4);
    expect(turretRange(20)).toBeGreaterThan(turretRange(1) * 1.4);
    expect(turretInterval(20)).toBeLessThan(turretInterval(1) / 2);
    const world = new World(field());
    const owner = world.addTank(100, 200, 0, { team: 10 });
    owner.level = 4;
    const turret = deploy(world, owner.id);
    expect(turret).toMatchObject({ level: 4, hp: turretMaxHp(4) });
    owner.x = 380;
    owner.y = 380;
    // a gazda szintet lép: a löveg is, és a többlet életerőt megkapja
    turret.hp -= 50;
    owner.level = 10;
    run(world, {}, 2);
    expect(turret.level).toBe(10);
    expect(turret.hp).toBe(turretMaxHp(4) - 50 + (turretMaxHp(10) - turretMaxHp(4)));
    // a gazda szintet veszít (kilőtték): a löveg felső határa is csökken
    turret.hp = turretMaxHp(10);
    owner.level = 8;
    run(world, {}, 2);
    expect(turret.level).toBe(8);
    expect(turret.hp).toBe(turretMaxHp(8));
    // a magasabb szintű löveg messzebbre lő, gyorsabban és nagyobbat sebez
    const shots = (level: number): { count: number; hp: number } => {
      const w = new World(field());
      const o = w.addTank(100, 200, 0, { team: 10 });
      o.level = level;
      const t = deploy(w, o.id);
      o.x = 380;
      o.y = 380;
      const enemy = w.addTank(t.x - 65, t.y, 0, { team: 11 });
      enemy.level = 20; // sok életerő: a mérés alatt nem lövik ki
      enemy.hp = 600;
      const events = run(w, {}, seconds(6));
      return { count: events.filter((e) => e.type === 'shot').length, hp: 600 - enemy.hp };
    };
    const low = shots(1);
    const high = shots(20);
    // 65 méterre az 1. szintű löveg nem lát el, a 20. szintű igen
    expect(low.count).toBe(0);
    expect(65).toBeGreaterThan(turretRange(1));
    expect(65).toBeLessThan(turretRange(20));
    expect(high.count).toBeGreaterThanOrEqual(10);
    // egy lövése a gazda szintje szerint sebez (20. szinten több mint kétszeres)
    expect(high.hp / high.count).toBeGreaterThan(DAMAGE.shell * 2);
  });

  it('akadály a tankoknak; a magas szintű ellenséges tank széttapossa', () => {
    const world = new World(field());
    const owner = world.addTank(100, 200, 0, { team: 10 });
    const turret = deploy(world, owner.id);
    owner.x = 300; // félreáll
    const enemy = world.addTank(turret.x - 12, 200, 0, { team: 11 });
    enemy.effects.invulnerable = 100;
    run(world, { [enemy.id]: { throttle: 1 } }, seconds(2));
    expect(enemy.x).toBeLessThan(turret.x - TANK.radius - TURRET.radius + 0.1);
    expect(world.turrets).toHaveLength(1);
    enemy.level = CRUSH.instantLevel;
    run(world, { [enemy.id]: { throttle: 1 } }, seconds(1));
    expect(world.turrets).toHaveLength(0);
  });

  it('a botok megtámadják az ellenséges ágyút', () => {
    const world = new World(field());
    const owner = world.addTank(350, 60, 0, { team: 10 });
    owner.turrets = 1;
    owner.x = 150;
    owner.y = 200;
    run(world, { [owner.id]: { deploy: true } }, 1);
    const turret = world.turrets[0];
    owner.x = 350; // a lerakó messze van, a bot csak az ágyút látja
    owner.y = 60;
    const bot = world.addTank(turret.x - 40, 200, 0, { team: 1, bot: true });
    bot.effects.invulnerable = 100;
    const brain = new BotBrain(world, bot.id);
    const inputs = new Map<number, TankInput>();
    for (let i = 0; i < seconds(5); i++) {
      inputs.set(bot.id, brain.update(SIM_DT));
      world.step(inputs);
    }
    expect(turret.hp).toBeLessThan(TURRET.hp);
  });
});

describe('beállítás és hálózat', () => {
  it('a forgalom szintje 0–5 (alapérték: 2); a járművek száma a pálya méretétől függ', () => {
    const area = { minX: 0, minY: 0, maxX: 500, maxY: 500 };
    expect(sanitizeSettings({ area }, 2000, 3460).traffic).toBe(2);
    expect(sanitizeSettings({ area, traffic: 99 }, 2000, 3460).traffic).toBe(5);
    expect(sanitizeSettings({ area, traffic: -1 }, 2000, 3460).traffic).toBe(0);
    const small = sanitizeSettings({ area, traffic: 3 }, 2000, 3460);
    const whole = sanitizeSettings({ area: { minX: 0, minY: 0, maxX: 2000, maxY: 3460 }, traffic: 3 }, 2000, 3460);
    expect(matchPlan({ ...small, traffic: 0 }).traffic).toBe(0);
    expect(matchPlan(small).traffic).toBeGreaterThanOrEqual(4);
    expect(matchPlan(whole).traffic).toBeGreaterThan(matchPlan(small).traffic * 4);
    expect(matchPlan({ ...whole, traffic: 5 }).traffic).toBeLessThanOrEqual(MATCH.maxTraffic);
  });

  it('a jármű és az ágyú állapota, meg a telepítés gombja átmegy a tömörítésen', () => {
    const world = new World(field());
    const v = world.addVehicle('bus', 2, 12.5, 30.25, 1.5);
    v.state = VSTATE.burning;
    expect(unpackVehicle(packVehicle(v))).toMatchObject({ id: v.id, kind: 'bus', look: 2, x: 12.5, y: 30.25, angle: 1.5, state: VSTATE.burning });
    const turret = { id: 7, owner: 3, team: 12, x: 5, y: 6, angle: 0.5, hp: 80, level: 9, cooldown: 0.3, target: 4 };
    expect(unpackTurret(packTurret(turret))).toMatchObject({ id: 7, owner: 3, team: 12, x: 5, y: 6, angle: 0.5, hp: 80, level: 9 });
    expect(unpackInput(packInput({ ...idle, deploy: true }))?.deploy).toBe(true);
    expect(unpackInput(packInput(idle))?.deploy).toBe(false);
  });

  it('a szerveren a meccsben közlekednek a járművek, és a közeliek bekerülnek a pillanatképbe', () => {
    const lobby = new Lobby(data, 0);
    const inbox: (ServerMessage | FullSnapshot)[] = [];
    const read = messageReader();
    const session = lobby.connect({ send: (text) => inbox.push(read(text)), close: () => undefined });
    session.message(encode({ t: 'hello', v: PROTOCOL_VERSION, name: 'Sofőr' }));
    session.message(encode({ t: 'create', settings: { area: { minX: 500, minY: 1500, maxX: 1250, maxY: 2250 }, maxPlayers: 1, bots: 0, pickups: 0, traffic: 5 } }));
    let now = 10;
    lobby.tick(now);
    const start = inbox.find((m) => m.t === 'start');
    expect(start && start.t === 'start' ? start.room.plan.traffic : 0).toBeGreaterThanOrEqual(5);
    let seen = 0;
    for (let i = 0; i < 60 * 20; i++) {
      now += 1000 / 60;
      lobby.tick(now);
    }
    for (const m of inbox) if (m.t === 'snap') seen = Math.max(seen, (m as FullSnapshot).V.length);
    const last = inbox.filter((m): m is FullSnapshot => m.t === 'snap').pop()!;
    expect(last.U).toEqual([]);
    expect(seen).toBeGreaterThan(0);
  });
});
