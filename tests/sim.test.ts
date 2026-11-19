import { describe, expect, it } from 'vitest';
import { SegmentGrid } from '../src/game/sim/collision';
import { TANK, World, type TankInput, type Terrain } from '../src/game/sim/world';

function arena(size = 200): Terrain {
  return { width: size, height: size, walls: new SegmentGrid(size, size), speedFactor: () => 1 };
}

function run(world: World, id: number, input: Partial<TankInput>, steps: number): void {
  const inputs = new Map([[id, { throttle: 0, turn: 0, aim: null, fire: false, ...input }]]);
  for (let i = 0; i < steps; i++) world.step(inputs);
}

describe('SegmentGrid', () => {
  it('kitolja a kört a falból', () => {
    const grid = new SegmentGrid(100, 100);
    grid.addSegment(50, 0, 50, 100);
    const res = grid.resolveCircle(49, 40, 2);
    expect(res.hit).toBe(true);
    expect(res.x).toBeCloseTo(48, 5);
    expect(res.y).toBeCloseTo(40, 5);
  });

  it('nem mozdítja a faltól távoli kört', () => {
    const grid = new SegmentGrid(100, 100);
    grid.addSegment(50, 0, 50, 100);
    expect(grid.resolveCircle(20, 40, 2)).toEqual({ x: 20, y: 40, hit: false });
  });

  it('a sugárvetés a legközelebbi falat találja el', () => {
    const grid = new SegmentGrid(100, 100);
    grid.addSegment(60, 0, 60, 100);
    grid.addSegment(30, 0, 30, 100);
    const hit = grid.raycast(10, 50, 90, 50);
    expect(hit?.x).toBeCloseTo(30, 5);
    expect(grid.raycast(10, 50, 20, 50)).toBeNull();
  });
});

describe('World – klasszikus tankirányítás', () => {
  it('gázra a tank arra indul, amerre az eleje néz', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 100, Math.PI / 2);
    run(world, tank.id, { throttle: 1 }, 120);
    expect(tank.y).toBeGreaterThan(115);
    expect(tank.x).toBeCloseTo(100, 5);
    expect(tank.speed).toBeCloseTo(TANK.maxSpeed, 1);
  });

  it('a forgatás helyben fordítja a testet, elmozdulás nélkül', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 100, 0);
    run(world, tank.id, { turn: 1 }, 120);
    expect(tank.turnSpeed).toBeCloseTo(TANK.turnRate, 5);
    expect(tank.hullAngle).toBeGreaterThan(2);
    expect(tank.x).toBe(100);
    expect(tank.y).toBe(100);
    run(world, tank.id, { turn: -1 }, 120);
    expect(tank.turnSpeed).toBeCloseTo(-TANK.turnRate, 5);
  });

  it('egy rövid billentyűnyomás csak néhány fokot fordít', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 100, 0);
    run(world, tank.id, { turn: 1 }, 6); // kb. 0,1 mp-es koppintás
    run(world, tank.id, {}, 60);
    const degrees = (tank.hullAngle * 180) / Math.PI;
    expect(degrees).toBeGreaterThan(0.5);
    expect(degrees).toBeLessThan(4);
    expect(tank.turnSpeed).toBe(0);
  });

  it('a forgás fokozatosan gyorsul: a nyomva tartás aránytalanul többet fordít, mint a koppintás', () => {
    const tap = new World(arena());
    const a = tap.addTank(100, 100, 0);
    run(tap, a.id, { turn: 1 }, 6);
    const hold = new World(arena());
    const b = hold.addTank(100, 100, 0);
    run(hold, b.id, { turn: 1 }, 30);
    // ötször annyi ideig tartva jóval több, mint ötször akkora az elfordulás
    expect(b.hullAngle).toBeGreaterThan(a.hullAngle * 12);
  });

  it('teljes sebességnél lassabban fordul, mint állva', () => {
    const world = new World(arena(4000));
    const tank = world.addTank(2000, 2000, 0);
    run(world, tank.id, { throttle: 1 }, 120);
    run(world, tank.id, { throttle: 1, turn: 1 }, 120);
    expect(tank.turnSpeed).toBeCloseTo(TANK.turnRateAtSpeed, 2);
    expect(TANK.turnRateAtSpeed).toBeLessThan(TANK.turnRate);
    // a legszűkebb ív sugara teljes sebességnél: sebesség / forgási sebesség
    expect(TANK.maxSpeed / TANK.turnRateAtSpeed).toBeGreaterThan(12);
  });

  it('tolatni is tud, lassabban, a test irányának megtartásával', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 100, 0);
    run(world, tank.id, { throttle: -1 }, 120);
    expect(tank.x).toBeLessThan(90);
    expect(tank.speed).toBeCloseTo(-TANK.maxReverse, 1);
    expect(tank.hullAngle).toBe(0);
  });

  it('gáz nélkül megáll', () => {
    const world = new World(arena());
    const tank = world.addTank(100, 100, 0);
    run(world, tank.id, { throttle: 1 }, 90);
    run(world, tank.id, {}, 60);
    expect(tank.speed).toBe(0);
  });

  it('nem megy át a falon és a pálya szélén, előre és tolatva sem', () => {
    const terrain = arena();
    terrain.walls.addPolygon([120, 80, 140, 80, 140, 120, 120, 120]);
    const world = new World(terrain);
    const tank = world.addTank(100, 100, 0);
    run(world, tank.id, { throttle: 1 }, 300);
    expect(tank.x).toBeLessThanOrEqual(120 - TANK.radius + 1e-6);

    const free = world.addTank(20, 20, Math.PI);
    run(world, free.id, { throttle: 1 }, 300);
    expect(free.x).toBeCloseTo(TANK.radius, 5);

    const backing = world.addTank(180, 180, Math.PI);
    run(world, backing.id, { throttle: -1 }, 300);
    expect(backing.x).toBeCloseTo(200 - TANK.radius, 5);
  });

  it('terepen lassabb, mint úton', () => {
    const slow: Terrain = { ...arena(), speedFactor: () => 0.5 };
    const world = new World(slow);
    const tank = world.addTank(50, 100, 0);
    run(world, tank.id, { throttle: 1 }, 120);
    expect(tank.speed).toBeCloseTo(TANK.maxSpeed * 0.5, 1);
  });

  it('a lövedék becsapódik a falba, és tűzgyorsaság-korlát van', () => {
    const terrain = arena();
    terrain.walls.addSegment(150, 0, 150, 200);
    const world = new World(terrain);
    const tank = world.addTank(100, 100, 0);
    const inputs = new Map([[tank.id, { throttle: 0, turn: 0, aim: 0, fire: true }]]);
    let shots = 0;
    let impactX = NaN;
    for (let i = 0; i < 60; i++) {
      world.step(inputs);
      for (const ev of world.events) {
        if (ev.type === 'shot') shots++;
        if (ev.type === 'impact' && Number.isNaN(impactX)) impactX = ev.x;
      }
    }
    expect(shots).toBe(3); // 1 mp alatt 0,42 mp-es újratöltéssel
    expect(impactX).toBeCloseTo(150, 3);
  });
});
