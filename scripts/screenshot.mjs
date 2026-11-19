// Füstteszt és képernyőképek: megnyitja a futó játékot a gépen telepített
// Edge/Chrome böngszővel, vezeti egy kicsit a tankot, és képeket ment.
// Használat:  npm run dev   (külön terminálban), majd   npm run shots
// Kimenet: screenshots/*.png

import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'screenshots');
const url = process.argv[2] ?? 'http://localhost:5173/';
await mkdir(outDir, { recursive: true });

let browser;
for (const channel of ['msedge', 'chrome']) {
  try {
    // GPU=1 környezeti változóval a gép videokártyáját használja (valósabb FPS), különben szoftveres rajzolást
    const args = process.env.GPU ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
    browser = await chromium.launch({ channel, args });
    break;
  } catch {
    /* következő böngésző */
  }
}
if (!browser) {
  console.error('Nem található telepített Edge vagy Chrome.');
  process.exit(1);
}

const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const state = () =>
  page.evaluate(() => {
    const game = window.__TANK__;
    const scene = game.scene.getScene('game');
    return { ...scene.debugState(), fps: Math.round(game.loop.actualFps), frame: game.loop.frame, now: performance.now() };
  });
const shot = async (name) => {
  await page.screenshot({ path: path.join(outDir, name) });
  console.log('  kép:', name);
};
const hold = async (keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of keys) await page.keyboard.up(k);
};

await page.goto(url);
await page.waitForFunction(() => window.__TANK__?.scene.getScene('game')?.debugState?.().ready, null, { timeout: 30000 });
await page.waitForTimeout(1000);
const s0 = await state();
console.log('indulás:', s0);
await shot('01-start.png');

await page.mouse.move(1400, 300);
await page.mouse.down();
await page.waitForTimeout(250);
await shot('02-shot.png');
await page.mouse.up();

// klasszikus tankirányítás: W előre, S tolat, A/D forgat
const steps = [
  { keys: ['KeyW'], ms: 6000, expect: 'move' },
  { keys: ['KeyD'], ms: 700, expect: 'turn' },
  { keys: ['KeyW', 'KeyA'], ms: 2000, expect: 'move' },
  { keys: ['KeyS'], ms: 1500, expect: 'move' },
];
for (const [i, step] of steps.entries()) {
  await page.waitForTimeout(1200); // megállás az előző lépés után
  const before = await state();
  await hold(step.keys, step.ms);
  const after = await state();
  const moved = Math.hypot(after.x - before.x, after.y - before.y);
  const turned = Math.abs(after.angle - before.angle);
  const fps = ((after.frame - before.frame) / (after.now - before.now)) * 1000;
  console.log(`${step.keys.join('+')}: elmozdulás ${moved.toFixed(1)} m, elfordulás ${((turned * 180) / Math.PI).toFixed(0)}°, közben ${fps.toFixed(0)} FPS`);
  if (step.expect === 'move' && moved < 3) errors.push(`${step.keys.join('+')}: a tank nem mozdult.`);
  if (step.expect === 'turn' && (turned < 0.5 || moved > 0.5)) errors.push(`${step.keys.join('+')}: a tank nem helyben fordult.`);
  await shot(`03-drive-${i + 1}.png`);
}

await page.keyboard.press('KeyM');
await page.waitForTimeout(300);
await shot('04-map.png');
await page.keyboard.press('KeyM');

await page.keyboard.press('KeyR');
await page.waitForTimeout(400);
const s1 = await state();
console.log('újraindítás után:', s1);
if (Math.hypot(s1.x - s0.x, s1.y - s0.y) > 0.5) errors.push('Az újraindítás nem a kezdőpontra tett vissza.');

await browser.close();
if (errors.length) {
  console.error('HIBÁK:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('Rendben, nincs konzolhiba.');
