// A roncsok félretolása: az 5. szinttől a tank akadály nélkül átgázol a kilőtt tankok és a
// kiégett járművek roncsain és félrelöki őket; a kisebb tank a szintjével arányos erővel, lassabban tolja.
import { describe, expect, it } from 'vitest';
import { SegmentGrid } from '../src/game/sim/collision';
import { VEHICLES, VSTATE } from '../src/game/sim/vehicles';
import { PUSH, pushShare, SIM_DT, TANK, tankRadius, TEAM, World, wreckRadius, type SimEvent, type TankInput, type Terrain, type WreckState } from '../src/game/sim/world';

function arena(size = 400, walls = new SegmentGrid(size, size)): Terrain {
  return { width: size, height: size, walls, speedFactor: () => 1 };
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

function wreck(world: World, x: number, y: number, level = 1): WreckState {
  const w: WreckState = { id: 900 + world.wrecks.length, x, y, hullAngle: Math.PI / 2, turretAngle: 0, team: TEAM.bots, level, look: 0, age: 0 };
  world.wrecks.push(w);
  return w;
}

/** Ennyit halad a tank `time` mp alatt teljes gázzal (roncs nélkül vagy roncsokkal). */
function drive(level: number, time: number, place: (world: World) => void = () => {}): { dist: number; world: World } {
  const world = new World(arena());
  place(world);
  const tank = world.addTank(100, 200, 0);
  tank.level = level;
  run(world, { [tank.id]: { throttle: 1 } }, seconds(time));
  return { dist: tank.x - 100, world };
}

describe('roncsok félretolása', () => {
  it('az 5. szinttől a tank lassulás nélkül átgázol a roncson, és félrelöki az útjából', () => {
    const free = drive(5, 3).dist;
    const { dist, world } = drive(5, 3, (w) => wreck(w, 115, 200, 20));
    expect(dist).toBeGreaterThan(free - 0.5);
    const w = world.wrecks[0];
    const tank = world.tanks[0];
    // a roncs oldalra csúszott, és nem fedi a tankot
    expect(Math.abs(w.y - 200)).toBeGreaterThan(2);
    expect(Math.hypot(tank.x - w.x, tank.y - w.y)).toBeGreaterThanOrEqual(tankRadius(tank) + wreckRadius(w) - 0.05);
  });

  it('a kisebb tank is eltolja, de lassabban – a nehezebb roncsot még lassabban', () => {
    const free = drive(1, 3).dist;
    const light = drive(1, 3, (w) => wreck(w, 108, 200, 1)).dist;
    const heavy = drive(1, 3, (w) => wreck(w, 108, 200, 20)).dist;
    // továbbjut a roncson (nem akad el előtte), de lassul
    expect(light).toBeGreaterThan(15);
    expect(light).toBeLessThan(free - 0.3);
    expect(heavy).toBeLessThan(light);
    expect(heavy).toBeGreaterThan(5);
    // a 4. szintű erősebben tol, mint az 1.
    expect(pushShare(4, 4)).toBeGreaterThan(pushShare(1, 4));
    expect(pushShare(PUSH.freeLevel, 100)).toBe(1);
  });

  it('a kiégett járművet is félretolja; az összelapítás helyett (6. szinttől) is csak félrelöki', () => {
    for (const level of [1, 5, 8]) {
      const world = new World(arena());
      const tank = world.addTank(100, 200, 0);
      tank.level = level;
      const car = world.addVehicle('car', 0, 112, 200, Math.PI / 2);
      car.state = VSTATE.wreck;
      const events = run(world, { [tank.id]: { throttle: 1 } }, seconds(3));
      expect(tank.x).toBeGreaterThan(125);
      expect(car.state).toBe(VSTATE.wreck);
      expect(Math.hypot(car.x - 112, car.y - 200)).toBeGreaterThan(2);
      expect(events.some((e) => e.type === 'shove' && e.tank === tank.id)).toBe(true);
    }
  });

  it('a busz roncsa nehezebb, mint az autóé: a kis tankot jobban lassítja', () => {
    const through = (kind: 'car' | 'bus'): number => {
      const world = new World(arena());
      const tank = world.addTank(100, 200, 0);
      const v = world.addVehicle(kind, 0, 110, 200, Math.PI / 2);
      v.state = VSTATE.wreck;
      run(world, { [tank.id]: { throttle: 1 } }, seconds(2));
      return tank.x;
    };
    expect(through('bus')).toBeLessThan(through('car'));
    expect(VEHICLES.bus.length).toBeGreaterThan(VEHICLES.car.length);
  });

  it('a roncs nem tolható falba: a falnak szorult roncs megállítja a kis tankot', () => {
    const walls = new SegmentGrid(400, 400);
    walls.addSegment(120, 150, 120, 250);
    const world = new World(arena(400, walls));
    const w = wreck(world, 112, 200, 10);
    const tank = world.addTank(100, 200, 0);
    tank.level = 5;
    run(world, { [tank.id]: { throttle: 1 } }, seconds(3));
    expect(w.x).toBeLessThanOrEqual(120 - wreckRadius(w) + 0.05);
    expect(tank.x).toBeLessThan(120 - TANK.radius + 0.05);
    expect(Math.hypot(tank.x - w.x, tank.y - w.y)).toBeGreaterThanOrEqual(tankRadius(tank) + wreckRadius(w) - 0.05);
  });

  it('a félretolt roncs a mögötte álló másikat is odébb löki', () => {
    const { world } = drive(6, 3, (w) => {
      wreck(w, 115, 200, 5);
      wreck(w, 118, 201.5, 5);
    });
    const [a, b] = world.wrecks;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(wreckRadius(a) + wreckRadius(b) - 0.05);
  });

  it('a tükörvilág (előrejelzés) is tol, de nem ad eseményt', () => {
    const world = new World(arena(), 1, { mirror: true });
    const w = wreck(world, 110, 200, 1);
    const tank = world.addTank(100, 200, 0);
    tank.level = 5;
    const events = run(world, { [tank.id]: { throttle: 1 } }, seconds(2));
    expect(tank.x).toBeGreaterThan(115);
    expect(Math.abs(w.y - 200)).toBeGreaterThan(1);
    expect(events.some((e) => e.type === 'shove')).toBe(false);
  });
});
