// A feldolgozott pályafájl ellenőrzése: megvan-e a hivatal, az utcák, és a
// szimuláció a valódi pályán sem engedi a tankot épületbe.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GameMap, nearestOnPolyline, pointInPolygon, SpatialIndex } from '../src/game/maps/GameMap';
import { renderCanopy, renderMap } from '../src/game/maps/raster';
import { placeRoadLabels } from '../src/game/maps/roadLabels';
import type { MapData } from '../src/game/maps/types';
import { TANK, World } from '../src/game/sim/world';

const data = JSON.parse(
  readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8'),
) as MapData;
const map = new GameMap(data);
const th = data.townhall;

/** A kép közepe a megadott pont; visszaadja a kirajzolt pixeleket. */
function renderAt(x: number, y: number, size = 128, scale = 12): Uint32Array {
  const buf = new Uint32Array(size * size);
  renderMap(map, { buf, w: size, h: size, ox: Math.round(x * scale - size / 2), oy: Math.round(y * scale - size / 2), scale, detail: true });
  return buf;
}
/** Tetőcserép-vörös pixel (ABGR): az R csatorna jóval erősebb a G-nél. */
const isRoofRed = (px: number): boolean => (px & 0xff) > 0x60 && (px & 0xff) > ((px >> 8) & 0xff) * 1.8;

describe('SpatialIndex', () => {
  it('csak a dobozt érintő elemeket adja vissza, mindegyiket egyszer, sorrendben', () => {
    const index = new SpatialIndex(1000, 1000, 32);
    index.add(0, 10, 10, 20, 20);
    index.add(1, 500, 500, 700, 700); // több cellát fed
    index.add(2, 900, 900, 910, 910);
    expect(index.query(0, 0, 40, 40)).toEqual([0]);
    expect(index.query(0, 0, 650, 650)).toEqual([0, 1]);
    expect(index.query(600, 600, 601, 601)).toEqual([1]);
    expect(index.query(300, 300, 310, 310)).toEqual([]);
  });
});

describe('Kozármisleny pályaadat', () => {
  it('a pálya a város beépített területét fedi le', () => {
    expect(data.meta.width).toBeGreaterThanOrEqual(1900);
    expect(data.meta.height).toBeGreaterThanOrEqual(3300);
    expect(data.buildings.length).toBeGreaterThan(2500);
  });

  it('a hivatal a megadott helyen van, és épületkontúr tartozik hozzá', () => {
    expect(th.osm).toBe('node/2608053959');
    expect(th.x).toBeGreaterThan(0);
    expect(th.x).toBeLessThan(data.meta.width);
    expect(th.y).toBeGreaterThan(0);
    expect(th.y).toBeLessThan(data.meta.height);
    expect(th.buildingMatch).toBe('contains');
    const flagged = data.buildings.filter((b) => b.townhall);
    expect(flagged).toHaveLength(1);
    expect(pointInPolygon(th.x, th.y, flagged[0].pts)).toBe(true);
  });

  it('szerepelnek a város utcái, köztük a Kiskozári utca és a Csikósvölgy', () => {
    const names = new Set(data.roads.map((r) => r.name));
    for (const name of ['Pécsi utca', 'Zrínyi utca', 'Március 15. tér', 'Orgona utca', 'Kiskozári utca', 'Csikósvölgy', 'Kossuth Lajos utca', 'Viola utca', 'Petőfi utca']) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('minden koordináta a pályán belül van', () => {
    const { width, height } = data.meta;
    const all = [...data.buildings.map((b) => b.pts), ...data.roads.map((r) => r.pts), ...data.areas.flatMap((a) => a.rings)];
    for (const pts of all) {
      for (let i = 0; i < pts.length; i += 2) {
        expect(pts[i]).toBeGreaterThanOrEqual(-0.01);
        expect(pts[i]).toBeLessThanOrEqual(width + 0.01);
        expect(pts[i + 1]).toBeGreaterThanOrEqual(-0.01);
        expect(pts[i + 1]).toBeLessThanOrEqual(height + 0.01);
      }
    }
  });

  it('megvan a forrásmegjelölés', () => {
    expect(data.meta.attribution).toContain('OpenStreetMap');
    expect(data.meta.licenseUrl).toBe('https://www.openstreetmap.org/copyright');
  });

  it('a kezdőpont úton van, épületen kívül', () => {
    const spawn = map.spawnPoint();
    expect(map.speedFactor(spawn.x, spawn.y)).toBe(1);
    expect(map.walls.resolveCircle(spawn.x, spawn.y, TANK.radius).hit).toBe(false);
  });

  it('a tank minden irányban vezetve is épületen kívül és a pályán belül marad', () => {
    for (let dir = 0; dir < 8; dir++) {
      const world = new World(map);
      const spawn = map.spawnPoint();
      const tank = world.addTank(spawn.x, spawn.y, (dir / 8) * Math.PI * 2);
      const inputs = new Map([[tank.id, { throttle: 1, turn: 0, aim: null, fire: false }]]);
      for (let i = 0; i < 60 * 25; i++) world.step(inputs);
      const near = map.buildingIndex.query(tank.x, tank.y, tank.x, tank.y).map((n) => data.buildings[n]);
      expect(near.some((b) => pointInPolygon(tank.x, tank.y, b.pts)), `irány ${dir}: (${tank.x.toFixed(1)}, ${tank.y.toFixed(1)})`).toBe(false);
      expect(tank.x).toBeGreaterThanOrEqual(TANK.radius - 1e-6);
      expect(tank.x).toBeLessThanOrEqual(data.meta.width - TANK.radius + 1e-6);
      expect(Math.hypot(tank.x - spawn.x, tank.y - spawn.y)).toBeGreaterThan(5);
    }
  });

  it('a pálya széle minden oldalon megállítja a tankot', () => {
    const world = new World(map);
    const tank = world.addTank(data.meta.width - 5, data.meta.height - 5, Math.PI / 4);
    const inputs = new Map([[tank.id, { throttle: 1, turn: 0, aim: null, fire: false }]]);
    for (let i = 0; i < 600; i++) world.step(inputs);
    expect(tank.x).toBeLessThanOrEqual(data.meta.width - TANK.radius + 1e-6);
    expect(tank.y).toBeLessThanOrEqual(data.meta.height - TANK.radius + 1e-6);
  });

  it('a lombréteg átlátszó háttérre rajzol, és ahol nincs fa, üres marad', () => {
    const size = 128;
    const tree = map.trees[0];
    const buf = new Uint32Array(size * size);
    const target = { buf, w: size, h: size, ox: Math.round(tree.x * 12 - 64), oy: Math.round(tree.y * 12 - 64), scale: 12, detail: true };
    expect(renderCanopy(map, target)).toBe(true);
    expect(buf[64 * size + 64] >>> 24).toBe(255);
    expect(buf.some((px) => px === 0)).toBe(true);
  });

  it('a talajréteg minden pixelt kitölt (nem marad üres hely)', () => {
    for (const [x, y] of [[th.x, th.y], [th.x + 400, th.y + 300], [5, 5], [data.meta.width - 5, data.meta.height - 5]]) {
      expect(renderAt(x, y).some((px) => px === 0)).toBe(false);
    }
  });
});

describe('fotók alapján felvett épületek', () => {
  const lm = data.landmarks!;
  const byName = (name: string) => lm.buildings.find((b) => b.name === name)!;

  it('a hivatal, a templom és a rendőrség szerepel, és mindegyik megvan az OSM-adatban', () => {
    expect(lm).not.toBeNull();
    for (const name of ['Polgármesteri Hivatal', 'Református templom', 'Rendőrség']) {
      const spec = byName(name);
      expect(spec, name).toBeDefined();
      expect(data.buildings.some((b) => b.id === spec.id), name).toBe(true);
      expect(map.landmarkBuildings.get(spec.id)).toBe(spec);
    }
    expect(byName('Polgármesteri Hivatal').id).toBe(data.buildings.find((b) => b.townhall)!.id);
  });

  it('a tetőrészek lefedik az alaprajzot, a tornyok az épületen vannak', () => {
    for (const spec of lm.buildings) {
      if (!spec.parts) continue;
      const b = data.buildings.find((x) => x.id === spec.id)!;
      const xs = b.pts.filter((_, i) => i % 2 === 0);
      const ys = b.pts.filter((_, i) => i % 2 === 1);
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const towers = (spec.towers ?? []).map((t) => t.polygon);
      for (const ring of [...spec.parts.map((p) => p.polygon), ...towers]) {
        for (let i = 0; i < ring.length; i += 2) {
          expect(ring[i], spec.name).toBeGreaterThan(minX - 3);
          expect(ring[i], spec.name).toBeLessThan(maxX + 3);
          expect(ring[i + 1], spec.name).toBeGreaterThan(minY - 3);
          expect(ring[i + 1], spec.name).toBeLessThan(maxY + 3);
        }
      }
      let covered = 0;
      let total = 0;
      for (let x = minX; x < maxX; x += 0.5) {
        for (let y = minY; y < maxY; y += 0.5) {
          if (!pointInPolygon(x, y, b.pts)) continue;
          total++;
          if ([...spec.parts.map((p) => p.polygon), ...towers].some((ring) => pointInPolygon(x, y, ring))) covered++;
        }
      }
      expect(covered / total, spec.name).toBeGreaterThan(0.95);
    }
  });

  it('a hivatal, a templom és a rendőrség teteje cserépvörös', () => {
    for (const spec of lm.buildings) {
      const b = data.buildings.find((x) => x.id === spec.id)!;
      const cx = b.pts.filter((_, i) => i % 2 === 0).reduce((s, v) => s + v, 0) / (b.pts.length / 2);
      const cy = b.pts.filter((_, i) => i % 2 === 1).reduce((s, v) => s + v, 0) / (b.pts.length / 2);
      const buf = renderAt(cx, cy, 96);
      expect(buf.filter(isRoofRed).length / buf.length, spec.name).toBeGreaterThan(0.3);
    }
  });

  it('a templom tornya gúlasisakos, a hivatalé lapos tetejű', () => {
    expect(byName('Református templom').towers![0].kind).toBe('spire');
    expect(byName('Polgármesteri Hivatal').towers![0].kind).toBe('flat');
  });

  it('az autók, padok és zászlórudak nem épületben állnak, és a tér burkolt felületként számít', () => {
    for (const s of [...lm.cars, ...lm.benches, ...lm.flagpoles]) {
      expect(data.buildings.some((b) => pointInPolygon(s.x, s.y, b.pts)), `(${s.x}, ${s.y})`).toBe(false);
    }
    expect(map.speedFactor(th.x + 10, th.y)).toBe(1);
  });

  it('a tér, a gyep és a virágágyás területére nem kerül generált fa; a hivatal mögött erdő van', () => {
    const clear = lm.areas.filter((a) => a.kind !== 'woodland').map((a) => a.ring);
    const handPlaced = new Set(lm.trees.map((t) => `${t.x.toFixed(1)},${t.y.toFixed(1)}`));
    for (const n of map.treeIndex.query(th.x - 120, th.y - 120, th.x + 160, th.y + 120)) {
      const tree = map.trees[n];
      if (handPlaced.has(`${tree.x.toFixed(1)},${tree.y.toFixed(1)}`)) continue;
      expect(clear.some((ring) => pointInPolygon(tree.x, tree.y, ring)), `fa (${tree.x}, ${tree.y})`).toBe(false);
    }
    const woodland = lm.areas.find((a) => a.kind === 'woodland')!.ring;
    expect(map.trees.filter((t) => pointInPolygon(t.x, t.y, woodland)).length).toBeGreaterThan(15);
  });
});

describe('utcakép: zebrák, növényzet, utcanevek', () => {
  it('a zebrák közúton vannak', () => {
    expect(data.crossings.length).toBeGreaterThan(20);
    for (const cr of data.crossings) {
      expect(map.nearestRoad(cr.x, cr.y, 1, true), `zebra (${cr.x}, ${cr.y})`).not.toBeNull();
    }
  });

  it('a generált növényzet jelölve van, és nem kerül épületbe vagy úttestre', () => {
    expect(data.decor.generated).toBe(true);
    expect(map.trees.length).toBeGreaterThan(8000);
    for (const tree of map.trees.slice(data.trees.length)) {
      const near = map.buildingIndex.query(tree.x, tree.y, tree.x, tree.y).map((n) => data.buildings[n]);
      expect(near.some((b) => pointInPolygon(tree.x, tree.y, b.pts)), `fa (${tree.x}, ${tree.y})`).toBe(false);
      const road = map.nearestRoad(tree.x, tree.y, 12, true);
      if (road) expect(road.hit.dist, `fa (${tree.x}, ${tree.y})`).toBeGreaterThan(road.road.width / 2);
    }
  });

  it('a főút mentén fasor áll, a főút mellett nincs járda', () => {
    const pecsi = data.roads.filter((r) => r.name === 'Pécsi utca' && r.kind === 'secondary');
    expect(pecsi.length).toBeGreaterThan(0);
    let alley = 0;
    for (const tree of map.trees) {
      if (tree.kind !== 3) continue;
      const road = map.nearestRoad(tree.x, tree.y, 12, true);
      if (road?.road.name === 'Pécsi utca' && road.road.kind === 'secondary') alley++;
    }
    expect(alley).toBeGreaterThan(60);
    expect(data.meta.streetscape.shoulder).toBeLessThan(1);
  });

  it('a főút szélesebb a lakóutcáknál, és egyik közút úttestjére sem lóg be épület', () => {
    const widths = (kind: string): number[] => data.roads.filter((r) => r.kind === kind).map((r) => r.width);
    const median = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1];
    expect(median(widths('secondary'))).toBeGreaterThanOrEqual(15);
    expect(median(widths('residential'))).toBeGreaterThanOrEqual(10);
    expect(median(widths('secondary'))).toBeGreaterThan(median(widths('residential')));

    let checked = 0;
    for (const road of data.roads) {
      if (!['secondary', 'primary', 'tertiary', 'residential', 'living_street', 'unclassified'].includes(road.kind)) continue;
      const half = road.width / 2 - 0.2;
      for (let i = 0; i + 3 < road.pts.length; i += 2) {
        const dx = road.pts[i + 2] - road.pts[i];
        const dy = road.pts[i + 3] - road.pts[i + 1];
        const len = Math.hypot(dx, dy);
        for (let d = 0; d <= len; d += 3) {
          for (const side of [-1, 0, 1]) {
            const x = road.pts[i] + (dx * d) / (len || 1) - (dy / (len || 1)) * half * side;
            const y = road.pts[i + 1] + (dy * d) / (len || 1) + (dx / (len || 1)) * half * side;
            checked++;
            const near = map.buildingIndex.query(x, y, x, y).map((n) => data.buildings[n]);
            expect(near.some((b) => pointInPolygon(x, y, b.pts)), `épület az úttesten: ${road.name ?? road.kind} (${x.toFixed(0)}, ${y.toFixed(0)})`).toBe(false);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
  });

  it('a fák és az oszlopok nem falak: kidönthetők, és a kidőlt fa eltűnik a lombrétegről', () => {
    expect(map.fellables.count).toBe(map.trees.length + data.decor.poles.length / 2);
    const index = map.trees.findIndex((t) => map.treeIndex.query(t.x - 9, t.y - 9, t.x + 9, t.y + 9).every((n) => map.trees[n] === t || Math.hypot(map.trees[n].x - t.x, map.trees[n].y - t.y) > 9));
    expect(index).toBeGreaterThanOrEqual(0);
    const tree = map.trees[index];
    // a törzs helyén nincs ütközés
    expect(map.walls.resolveCircle(tree.x, tree.y, 0.3).hit).toBe(false);
    const size = 96;
    const target = { buf: new Uint32Array(size * size), w: size, h: size, ox: Math.round(tree.x * 12 - 48), oy: Math.round(tree.y * 12 - 48), scale: 12, detail: true };
    renderCanopy(map, target);
    const before = target.buf.slice();
    map.fellables.fell(index, 0.5);
    renderCanopy(map, target);
    expect(target.buf[48 * size + 48] >>> 24).toBe(0); // a kidőlt fa koronája nincs a lombrétegen
    expect(target.buf.some((px, i) => px !== before[i])).toBe(true);
    expect(map.underCanopy(tree.x, tree.y)).toBe(false);
    map.resetDamage();
    expect(map.fellables.fallen[index]).toBe(0);
  });

  it('a lövésnyom megmarad a pályán és megjelenik a talajon', () => {
    const [x, y] = [th.x + 48, th.y - 4]; // a Pécsi utca úttestje
    const before = renderAt(x, y, 64);
    expect(map.addScar(x, y, 1.5)).toBe(true);
    expect(map.addScar(x + 0.1, y, 1.0)).toBe(false); // ugyanoda kisebb nyom nem kerül
    const after = renderAt(x, y, 64);
    const changed = after.filter((px, i) => px !== before[i]).length;
    expect(changed).toBeGreaterThan(64 * 64 * 0.1);
    map.resetDamage();
    expect(renderAt(x, y, 64).every((px, i) => px === before[i])).toBe(true);
  });

  it('a közutak legalább kétsávosak a tankhoz mérten', () => {
    for (const road of data.roads) {
      if (road.kind === 'residential' || road.kind === 'secondary') {
        expect(road.width).toBeGreaterThanOrEqual(TANK.radius * 4);
      }
    }
  });

  it('az utcanevek az útra kerülnek, utcánként több helyre', () => {
    const labels = placeRoadLabels(map);
    expect(labels.length).toBeGreaterThan(150);
    expect(labels.filter((l) => l.text === 'Pécsi utca').length).toBeGreaterThan(5);
    for (const name of ['Kiskozári utca', 'Csikósvölgy']) expect(labels.some((l) => l.text === name), name).toBe(true);
    for (const label of labels) {
      const onOwnRoad = data.roads.some((road) => road.name === label.text && nearestOnPolyline(label.x, label.y, road.pts).dist <= road.width / 2);
      expect(onOwnRoad, `${label.text} (${label.x.toFixed(0)}, ${label.y.toFixed(0)})`).toBe(true);
      expect(Math.abs(label.angle)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    }
  });
});
