// A látómező az ablak képarányához igazodik: a kép mindig kitölti az ablakot.

import { describe, expect, it } from 'vitest';
import { LIMITS } from '../server/lobby';
import { canvasSize, VIEW_ASPECT, viewMeters } from '../src/game/quality';

describe('látómező és vászonméret', () => {
  it('16:9-es képernyőn 160 × 90 méter látszik', () => {
    expect(viewMeters(1920, 1080)).toEqual({ width: 160, height: 90 });
    expect(viewMeters(2560, 1440)).toEqual({ width: 160, height: 90 });
    expect(canvasSize(12, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it('szélesebb képernyőn oldalra több látszik, a magasság marad', () => {
    const wide = viewMeters(3440, 1440);
    expect(wide.height).toBe(90);
    expect(wide.width).toBeCloseTo(215, 0);
    const superWide = viewMeters(5120, 1440);
    expect(superWide.width).toBeCloseTo(320, 0);
    // ennél szélesebb ablakhoz már nem igazodik tovább (a kép két szélén sáv marad)
    expect(viewMeters(9000, 1000).width).toBeCloseTo(90 * VIEW_ASPECT.max, 5);
  });

  it('keskenyebb, magasabb ablakban függőlegesen látszik több, a szélesség marad', () => {
    expect(viewMeters(1280, 1024)).toEqual({ width: 160, height: 128 });
    expect(viewMeters(1600, 1200)).toEqual({ width: 160, height: 120 });
    // álló ablak: legfeljebb négyzet
    expect(viewMeters(800, 1400)).toEqual({ width: 160, height: 160 });
    // értelmetlen méretnél az alapérték
    expect(viewMeters(0, 0)).toEqual({ width: 160, height: 90 });
  });

  it('a vászon képaránya megegyezik az ablakéval, a mérete páros', () => {
    for (const [w, h] of [[3440, 1440], [2560, 1080], [1366, 768], [1280, 1024], [1920, 1200]]) {
      for (const ppm of [12, 10, 8]) {
        const size = canvasSize(ppm, w, h);
        expect(size.width % 2).toBe(0);
        expect(size.height % 2).toBe(0);
        expect(size.width / size.height).toBeCloseTo(w / h, 2);
      }
    }
  });

  it('a szerver a legszélesebb látómezőnél is elküldi a képernyőn látszó közeli elemeket', () => {
    const widest = viewMeters(5120, 1440);
    const tallest = viewMeters(800, 1400);
    expect(LIMITS.nearRange).toBeGreaterThan(widest.width / 2 + 15);
    expect(LIMITS.nearRange).toBeGreaterThan(tallest.height / 2 + 15);
  });
});
