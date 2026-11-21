// A GPS útvonaltervezője a valódi pályán: csak normál utakon vezet, mindig talál utat, és gyors.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NAV_EXCLUDED, RoadNav } from '../src/game/maps/roadNav';
import type { MapData } from '../src/game/maps/types';

const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;
const full = { minX: 0, minY: 0, maxX: data.meta.width, maxY: data.meta.height };
const normal = data.roads.filter((r) => !NAV_EXCLUDED.has(r.kind));

/** A pont távolsága a legközelebbi normál úttól (m). */
function offRoad(x: number, y: number): number {
  let best = Infinity;
  for (const road of normal) {
    const p = road.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2] - p[i];
      const dy = p[i + 3] - p[i + 1];
      const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (y - p[i + 1]) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - p[i] - dx * t, y - p[i + 1] - dy * t));
    }
  }
  return best;
}

/** Determinisztikus véletlen pontok. */
function points(count: number, area: typeof full, seed = 7): [number, number][] {
  let s = seed;
  const rnd = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: count }, () => [area.minX + rnd() * (area.maxX - area.minX), area.minY + rnd() * (area.maxY - area.minY)]);
}

describe('GPS útvonaltervező', () => {
  const nav = new RoadNav(data.roads, full);

  it('csak normál utakon vezet: az útvonal minden pontja és szakaszfelezője úton van', () => {
    const list = points(24, full);
    for (let k = 0; k + 1 < list.length; k += 2) {
      const [fx, fy] = list[k];
      const [tx, ty] = list[k + 1];
      const route = nav.route(fx, fy, tx, ty);
      expect(route, `${fx},${fy} → ${tx},${ty}`).not.toBeNull();
      const p = route!.points;
      // az első pont a tank (lehet úton kívül), utána minden pont az úton
      for (let i = 2; i < p.length; i += 2) {
        expect(offRoad(p[i], p[i + 1])).toBeLessThan(0.6);
        // a szakaszok közepe is úton van (a zsákutca-kapcsolások legfeljebb pár méteresek)
        if (i + 3 < p.length) expect(offRoad((p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2)).toBeLessThan(3);
      }
      expect(route!.length).toBeGreaterThanOrEqual(Math.hypot(route!.end.x - p[2], route!.end.y - p[3]) - 0.01);
    }
  });

  it('gyalogúton, kerékpárúton, földúton nem vezet', () => {
    const minor = data.roads.filter((r) => NAV_EXCLUDED.has(r.kind) && r.pts.length >= 4);
    expect(minor.length).toBeGreaterThan(10);
    for (const road of minor.slice(0, 40)) {
      // egy gyalogút közepe: ha messze van minden normál úttól, a GPS nem mehet oda
      const i = Math.floor(road.pts.length / 4) * 2;
      const x = road.pts[i];
      const y = road.pts[i + 1];
      if (offRoad(x, y) < 15) continue;
      const route = nav.route(1000, 1700, x, y)!;
      const p = route.points;
      for (let j = 2; j < p.length; j += 2) expect(offRoad(p[j], p[j + 1])).toBeLessThan(0.6);
      // a vége a célhoz legközelebbi normál útpont, nem a gyalogút
      expect(Math.hypot(route.end.x - x, route.end.y - y)).toBeGreaterThan(10);
    }
  });

  it('kis játéktéren a játéktéren belül marad', () => {
    const area = { minX: 800, minY: 1500, maxX: 1200, maxY: 1850 };
    const small = new RoadNav(data.roads, area);
    for (const [[fx, fy], [tx, ty]] of [[[820, 1520], [1180, 1830]], [[1000, 1600], [850, 1800]]] as const) {
      const route = small.route(fx, fy, tx, ty);
      expect(route).not.toBeNull();
      const p = route!.points;
      for (let i = 2; i < p.length; i += 2) {
        expect(p[i]).toBeGreaterThan(area.minX);
        expect(p[i]).toBeLessThan(area.maxX);
        expect(p[i + 1]).toBeGreaterThan(area.minY);
        expect(p[i + 1]).toBeLessThan(area.maxY);
      }
    }
  });

  it('gyors: a teljes pályán egy tervezés néhány ezredmásodperc', () => {
    const started = performance.now();
    const built = new RoadNav(data.roads, full);
    const build = performance.now() - started;
    const list = points(40, full, 99);
    const t0 = performance.now();
    for (let k = 0; k + 1 < list.length; k += 2) built.route(list[k][0], list[k][1], list[k + 1][0], list[k + 1][1]);
    const each = (performance.now() - t0) / 20;
    console.log(`GPS: ${built.size} csomópont, felépítés ${build.toFixed(1)} ms, tervezés átlag ${each.toFixed(2)} ms`);
    expect(build).toBeLessThan(300);
    expect(each).toBeLessThan(15);
  });
});
