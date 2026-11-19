// Teljesítménymérés a futó játékon: betöltés, képkockánkénti számítási idő,
// rajzolási hívások, memória – többféle helyzetben.
// Használat:  npm run dev  (vagy npm run preview) külön terminálban, majd
//             npm run perf -- [url] [lassítás]
//   url       alapértelmezés: http://localhost:5173/
//   lassítás  a processzor mesterséges lassítása (pl. 4 = négyszer lassabb gép)
//
// Megjegyzés: a fej nélküli böngésző kb. 31 képkocka/mp-re korlátoz, ezért a
// script nem FPS-t, hanem a képkockánkénti számítási időt méri (60 FPS-hez
// 16,7 ms fér bele).

import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const throttle = Number(process.argv[3] ?? 1);

let browser;
for (const channel of ['chrome', 'msedge']) {
  try {
    browser = await chromium.launch({ channel, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
    break;
  } catch {
    /* következő böngésző */
  }
}
if (!browser) {
  console.error('Nem található telepített Chrome vagy Edge.');
  process.exit(1);
}
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
if (throttle > 1) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  console.log(`processzor lassítva: ${throttle}×`);
}
await page.addInitScript(() => {
  window.__LT = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__LT.push(Math.round(e.duration));
  }).observe({ entryTypes: ['longtask'] });
});

const t0 = Date.now();
await page.goto(url);
await page.waitForFunction(() => window.__TANK__?.scene.getScene('game')?.debugState?.().ready, null, { timeout: 120000, polling: 30 });
console.log(`betöltés a navigációtól a kész képig: ${Date.now() - t0} ms`);
await page.waitForTimeout(1500);
console.log('50 ms-nál hosszabb megszakítás nélküli feladatok betöltéskor (ms):', JSON.stringify(await page.evaluate(() => window.__LT)));
console.log('állapot:', JSON.stringify(await page.evaluate(() => window.__TANK__.scene.getScene('game').debugState())));

await page.evaluate(() => {
  const g = window.__TANK__;
  const scene = g.scene.getScene('game');
  const P = (window.__P = {
    reset() {
      this.upd = [];
      this.ground = [];
      this.render = [];
      this.draws = [];
      this.worker = [];
      this.add = [];
    },
    cur: 0,
  });
  P.reset();
  const u = scene.update.bind(scene);
  scene.sys.sceneUpdate = (t, d) => {
    const a = performance.now();
    u(t, d);
    P.upd.push(performance.now() - a);
  };
  const layer = scene.ground;
  const gu = layer.update.bind(layer);
  layer.update = (v) => {
    const a = performance.now();
    gu(v);
    P.ground.push(performance.now() - a);
  };
  const add = layer.addChunk.bind(layer);
  layer.addChunk = (...args) => {
    const a = performance.now();
    add(...args);
    P.add.push(performance.now() - a);
    P.worker.push(layer.lastRenderMs);
  };
  const gl = g.renderer.gl;
  for (const fn of ['drawArrays', 'drawElements']) {
    const o = gl[fn].bind(gl);
    gl[fn] = (...args) => {
      P.cur++;
      return o(...args);
    };
  }
  let pre = 0;
  g.events.on('prerender', () => {
    pre = performance.now();
    P.cur = 0;
  });
  g.events.on('postrender', () => {
    P.render.push(performance.now() - pre);
    P.draws.push(P.cur);
  });
});

const stat = async (label) => {
  const r = await page.evaluate(() => {
    const P = window.__P;
    const g = window.__TANK__;
    const scene = g.scene.getScene('game');
    const s = (a) => {
      if (!a.length) return '–';
      const b = [...a].sort((x, y) => x - y);
      const avg = b.reduce((x, y) => x + y, 0) / b.length;
      return `átlag ${avg.toFixed(2)} / p95 ${b[Math.floor(b.length * 0.95)].toFixed(2)} / max ${b[b.length - 1].toFixed(2)}`;
    };
    const total = P.upd.map((v, i) => v + (P.render[i] ?? 0));
    const st = scene.debugState();
    const out = {
      'fő szál, összes ms/képkocka': s(total),
      '  ebből update ms': s(P.upd),
      '    ebből térképréteg ms': s(P.ground),
      '  ebből render ms': s(P.render),
      'rajzolási hívás/képkocka': s(P.draws),
      'térképdarab a háttérszálon ms': s(P.worker) + ` (${P.worker.length} db)`,
      'térképdarab átvétele a fő szálon ms': s(P.add),
      'objektumok / térképdarabok / textúrák': `${scene.children.length} / ${st.chunks} / ${g.textures.getTextureKeys().length}`,
      'JS-memória MB': performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 'n/a',
    };
    P.reset();
    return out;
  });
  console.log('\n== ' + label);
  for (const [k, v] of Object.entries(r)) console.log('  ' + k + ': ' + v);
};
const teleport = (x, y, a = 0) =>
  page.evaluate(
    ([x, y, a]) => {
      const s = window.__TANK__.scene.getScene('game');
      s.player.x = x;
      s.player.y = y;
      s.player.hullAngle = a;
    },
    [x, y, a],
  );

await page.evaluate(() => window.__P.reset());
await page.waitForTimeout(3000);
await stat('1. áll a tank (kezdőpont)');

await page.keyboard.down('KeyW');
await page.waitForTimeout(8000);
await page.keyboard.up('KeyW');
await stat('2. halad a Pécsi utcán (8 mp, teljes sebesség)');

await teleport(430, 640, 0.6);
await page.waitForTimeout(2000);
await page.evaluate(() => window.__P.reset());
await page.keyboard.down('KeyW');
await page.waitForTimeout(6000);
await page.keyboard.up('KeyW');
await stat('3. halad a parkerdőben (6 mp)');

await page.keyboard.press('KeyM');
await page.waitForTimeout(3000);
await stat('4. nagy térkép nyitva, áll (3 mp)');
await page.keyboard.press('KeyM');

for (const [x, y] of [[200, 200], [400, 250], [700, 200], [1000, 250], [1000, 500], [900, 800], [600, 1000], [300, 950], [200, 700], [450, 450], [800, 600], [650, 596]]) {
  await teleport(x, y);
  await page.waitForTimeout(700);
}
await page.waitForTimeout(2000);
await page.evaluate(() => window.__P.reset());
await page.waitForTimeout(3000);
await stat('5. áll, hosszú bejárás után');

await page.mouse.move(1400, 300);
await page.mouse.down();
await page.waitForTimeout(4000);
await page.mouse.up();
await stat('6. folyamatos lövés (4 mp)');

await browser.close();
