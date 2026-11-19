// Végigjátszott próba két böngészővel a futó szerveren: regisztráció, szoba
// létrehozása, belépés, meccs, kilépés, eredmény. Képernyőképeket ment a
// screenshots/ mappába, és jelzi a böngésző konzolhibáit.
// Előtte indítsd el a szervert (npm run server). Használat:
//   npm run e2e -- [időjárás: 0 nappal, 1 eső, 2 este] [cím]
import { chromium } from 'playwright-core';

const weather = process.argv[2] ?? '2';
const url = process.argv[3] ?? 'http://localhost:8787/';
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
const open = async (label) => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label}: ${m.text()}`);
  });
  await page.goto(url);
  return page;
};
const shot = (page, name) => page.screenshot({ path: `screenshots/mp-${name}.png` });
const state = (page) => page.evaluate(() => window.__TANK__?.scene.getScene('game')?.debugState?.() ?? null);
const stamp = Date.now() % 100000;

const a = await open('A');
const b = await open('B');
await a.waitForSelector('#auth-box:not(.hidden)');
await shot(a, '01-main');

// regisztráció
for (const [page, name] of [[a, `Anna${stamp}`], [b, `Béla${stamp}`]]) {
  await page.fill('#auth-name', name);
  await page.fill('#auth-password', 'teszt-jelszo');
  await page.click('#auth-register');
  await page.waitForSelector('#user-box:not(.hidden)');
}
await shot(a, '03-logged-in');
await a.click('#main-settings');
await shot(a, '02-settings');
await a.click('#settings-back');
await a.click('#main-multiplayer');
await b.click('#main-multiplayer');
await a.waitForSelector('#screen-lobby:not(.hidden)');
await shot(a, '04-lobby-empty');

// új játék: 2 játékos, kevés bot, a megadott időjárás
await a.click('#lobby-create');
await a.waitForSelector('#screen-create:not(.hidden)');
const setSlider = (page, id, value) =>
  page.evaluate(([id, value]) => {
    const input = document.getElementById(id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }, [id, String(value)]);
await setSlider(a, 'sl-players', 2);
await setSlider(a, 'sl-bots', 3);
await setSlider(a, 'sl-pickups', 4);
await setSlider(a, 'sl-lives', 1);
await setSlider(a, 'sl-weather', weather);
await shot(a, '05-create');
await a.click('#create-ok');
await a.waitForSelector('#screen-room:not(.hidden)');
await shot(a, '06-waiting');
await b.waitForSelector('.room .btn:not(.disabled)');
await shot(b, '07-lobby-list');
await b.click('.room .btn:not(.disabled)');

// indulás
for (const page of [a, b]) await page.waitForFunction(() => window.__TANK__?.scene.getScene('game')?.debugState?.().ready, null, { timeout: 60000 });
await a.waitForTimeout(1500);
console.log('A indul:', JSON.stringify(await state(a)));
console.log('B indul:', JSON.stringify(await state(b)));
await shot(a, '08-game-a');
await shot(b, '09-game-b');

// A vezet és lő, B is mozog
await a.mouse.move(1500, 300);
await a.keyboard.down('KeyW');
await b.keyboard.down('KeyW');
await a.mouse.down();
await a.waitForTimeout(3000);
await a.mouse.up();
await a.keyboard.down('KeyD');
await a.waitForTimeout(1200);
await a.keyboard.up('KeyD');
await a.keyboard.up('KeyW');
await b.keyboard.up('KeyW');
await a.waitForTimeout(600);
const sa = await state(a);
const sb = await state(b);
console.log('A 5 mp után:', JSON.stringify(sa));
console.log('B 5 mp után:', JSON.stringify(sb));
await a.keyboard.press('KeyH');
await a.waitForTimeout(700);
await shot(a, '10-info');
await a.keyboard.press('KeyH');
await a.keyboard.press('KeyM');
await a.waitForTimeout(500);
await shot(a, '11-bigmap');
await a.keyboard.press('KeyM');

// B kilép: A nyer
await b.keyboard.press('KeyH');
await b.click('#hud-info-leave');
await a.waitForSelector('#screen-results:not(.hidden)', { timeout: 15000 });
await shot(a, '12-results');
await b.waitForSelector('#screen-lobby:not(.hidden)', { timeout: 15000 });
console.log('B visszakerült a listához; szobák:', await b.evaluate(() => document.querySelectorAll('.room').length));
await a.click('#results-back');
await a.waitForSelector('#screen-lobby:not(.hidden)', { timeout: 15000 });
console.log('A visszakerült a listához (belépve maradt)');
console.log(errors.length ? 'HIBÁK:\n' + errors.join('\n') : 'nincs hiba a konzolon');
await browser.close();
