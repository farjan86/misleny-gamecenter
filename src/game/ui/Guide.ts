// Útmutató a főmenüben: a felvehető tárgyak, a fegyverek sebzése, és hogy mi meddig tart.
// A számok a játékszabályok állandóiból jönnek (sim/), így a leírás nem térhet el a játéktól.

import { LIMITS } from '../../../server/lobby';
import { PICKUP_STYLE } from '../entities/pickupStyle';
import { ROOM_CODE } from '../net/protocol';
import { MATCH } from '../sim/match';
import { keysText, type Action, type KeyBindings } from '../settings';
import { BARREL, CLOAK, FLAME, MG, MINE, SMOKE, STRIKE, SUPER, WORKSHOP } from '../sim/gadgets';
import { BOOST, LASER, OIL, PICKUP, PICKUP_KINDS, PICKUPS, ROCKET, type PickupKind, RAIN_ALL_TERRAIN } from '../sim/pickups';
import { TURRET, VEHICLES, turretInterval, turretMaxHp, turretRange } from '../sim/vehicles';
import { BOT_POWER, DAMAGE, LEVEL, REGEN, TANK } from '../sim/world';

/** Szám magyar tizedesvesszővel, legfeljebb két tizedessel. */
const n = (v: number): string => String(Math.round(v * 100) / 100).replace('.', ',');
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
const fire = (factor = 1): string => `${n(TANK.fireCooldown * factor)} mp`;
const levelDamage = (level: number): number => 1 + LEVEL.damage * (level - 1);
const WEAPON_LASTS = 'amíg másik fegyvert nem veszel fel, vagy ki nem lőnek';

interface Entry {
  /** mit csinál */
  what: string;
  /** meddig tart / hány töltet */
  lasts: string;
  /** melyik billentyűvel használható (ha kell hozzá) */
  key?: Action;
}

/** A felvehető tárgyak leírása. */
export const GUIDE_PICKUPS: Record<PickupKind, Entry> = {
  heavy: { what: `Fegyver: ${DAMAGE.heavy} sebzés lövésenként (az alap ágyú ${DAMAGE.shell}), nagyobb robbanás, gyorsabb lövedék.`, lasts: WEAPON_LASTS },
  triple: { what: `Három lövedék megy legyezőben, egyenként ${DAMAGE.shell} sebzéssel. Bármelyik fegyverrel együtt működik.`, lasts: `${PICKUP.tripleShots} lövés (több felvéve legfeljebb ${PICKUP.maxTripleShots})` },
  rapid: { what: `Gyorstöltő: két lövés között ${fire()} helyett ${fire(BOOST.rapidCooldown)} telik el.`, lasts: `${PICKUPS.rapid.duration} mp` },
  ricochet: { what: `A lövedék a falról ${BOOST.ricochetBounces}-szer visszapattan, mielőtt robban – sarok mögé is lehet lőni.`, lasts: `${PICKUPS.ricochet.duration} mp` },
  rocket: {
    what: `Fegyver: ${DAMAGE.rocket} sebzés a találatnál, és a robbanása ${DAMAGE.splashRadius} m-es körben további ${DAMAGE.splash} sebzést okoz; fákat dönt, palackot robbant. Lassan indul, felgyorsul, messzire repül; lassabban tölt (${fire(ROCKET.cooldown)}).`,
    lasts: WEAPON_LASTS,
  },
  laser: { what: `Fegyver: azonnal célba érő sugár ${LASER.range} m-ig, ${DAMAGE.laser} sebzés; gyorsabban tölt (${fire(LASER.cooldown)}).`, lasts: WEAPON_LASTS },
  oil: {
    what: `Lerakható, ${OIL.radius} m sugarú folt a tank mögé. Aki gyorsan ráhajt, ${n(OIL.slipTime)} mp-ig irányíthatatlanul pörög; aki belehajt, annak utána még ${OIL.spinTime} mp-ig kipörög a lánctalpa (a sebessége a ${Math.round(OIL.spinSpeed * 100)}%-a).`,
    lasts: `${PICKUP.oilPerPickup} töltet (legfeljebb ${PICKUP.maxOil}); a folt ${OIL.life} mp-ig marad`,
    key: 'oil',
  },
  repair: { what: `Azonnal visszaad ${PICKUP.repairAmount} életerőt, és eltünteti a tank sérüléseit. A leggyakoribb tárgy.`, lasts: 'azonnal hat' },
  speed: { what: `Turbó: a végsebesség ${n(BOOST.speed)}-szeres, a gyorsulás ${n(BOOST.accel)}-szeres.`, lasts: `${PICKUPS.speed.duration} mp` },
  allTerrain: { what: `Terepjáró lánctalp: füvön, földön, sárban sem lassul a tank, és az olajon sem csúszik meg. Esőben ${RAIN_ALL_TERRAIN}-szer több van belőle a pályán.`, lasts: `${PICKUPS.allTerrain.duration} mp` },
  shield: { what: 'Egy töltet egy találatot teljesen elnyel. A géppuska apró lövései nem fogyasztják, de át sem jutnak rajta.', lasts: `töltetenként egy találat (legfeljebb ${PICKUP.maxShield} töltet)` },
  invulnerable: { what: 'Semmi nem sebez, és az olajon sem csúszol meg.', lasts: `${PICKUPS.invulnerable.duration} mp` },
  radar: { what: 'A térképeken látszanak a felvehető tárgyak.', lasts: `${PICKUPS.radar.duration} mp` },
  turret: {
    what: `Egy további telepíthető löveg (minden tank ${TURRET.base} darabbal indul). A tank mögé rakva magától lő minden ellenségre, amelyre rálát, és a gazdája szintjével együtt erősödik.`,
    lasts: `amíg ki nem lövik; a tanknál és a pályán is legfeljebb ${TURRET.maxPerOwner} lehet`,
    key: 'deploy',
  },
  mine: {
    what: `Lerakható akna a tank mögé. ${n(MINE.arm)} mp múlva élesedik, és az első ellenséges tank alatt robban: ${n(MINE.blastRadius)} m-es körben legfeljebb ${MINE.damage} sebzés. A sajátod alatt nem robban.`,
    lasts: `${MINE.perPickup} töltet (legfeljebb ${MINE.max}); az akna ${Math.round(MINE.life / 60)} percig él, egyszerre ${MINE.maxPlaced} lehet kint`,
    key: 'mine',
  },
  smoke: {
    what: `Füstfelhő a tank köré: ${Math.round(SMOKE.radius * SMOKE.startRatio)} m sugárral indul, ${n(SMOKE.spread)} mp alatt ${SMOKE.radius} m-esre terjed, a szél lassan sodorja. Ami benne van, kívülről nem látszik; a botok és a lövegek sem látnak bele.`,
    lasts: `${SMOKE.perPickup} töltet (legfeljebb ${SMOKE.max}); a felhő ${SMOKE.life} mp-ig tart`,
    key: 'smoke',
  },
  super: {
    what: `Szupertárgy: teljes javítás, tele pajzs, és ${SUPER.power}-szoros sebzés. Nem véletlenül kerül a pályára: ${SUPER.every} másodpercenként a pálya közepén jelenik meg, ${SUPER.warn} mp-cel előtte bejelentve.`,
    lasts: `${PICKUPS.super.duration} mp`,
  },
  flame: {
    what: `Fegyver: amíg a tüzet nyomva tartod, ${FLAME.range} m hosszú lángcsóva ég a cső előtt. Másodpercenként ${FLAME.dps} sebzés mindenen, amit elér: tankon, lövegen, járművön; a fákat felgyújtja és kidönti, a házakat leégeti (${FLAME.structureDps}/mp), a gázpalackot berobbantja. Falon nem megy át.`,
    lasts: `${FLAME.fuel} mp-nyi üzemanyag (két tárgyból legfeljebb ${FLAME.maxFuel}); ha kifogy, visszakapod az ágyút`,
  },
  gun: {
    what: `Kiegészítő géppuska a tank oldalán: magától lő a legközelebbi ellenségre ${MG.range} m-en belül, a fő fegyver mellett. Lövésenként ${n(MG.damage)} sebzés, másodpercenként kb. ${Math.round(1 / MG.interval)} lövés (≈ ${Math.round(MG.damage / MG.interval)} sebzés/mp).`,
    lasts: `${PICKUPS.gun.duration} mp`,
  },
};

/** A tárgy ikonja külön vásznon (ugyanaz a rajz, mint a pályán). */
function iconOf(kind: PickupKind): HTMLCanvasElement {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.className = 'guide-icon';
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2);
  ctx.fillStyle = '#101418';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.fillStyle = PICKUP_STYLE[kind].color;
  ctx.fill();
  ctx.strokeStyle = '#fff6d0';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  PICKUP_STYLE[kind].icon(ctx);
  return canvas;
}

/** A fegyverek és robbanások táblázata: [név, sebzés, tüzelés / hatókör, megjegyzés]. */
export function weaponRows(): string[][] {
  const turretDamage = (level: number): number => Math.round(DAMAGE.shell * levelDamage(level));
  const cars = Object.values(VEHICLES);
  return [
    ['Ágyú (alap)', `${DAMAGE.shell}`, `${fire()} / lövés`, 'minden tank alapfegyvere'],
    ['Nehéz lövedék', `${DAMAGE.heavy}`, `${fire()} / lövés`, 'fegyver (tárgy)'],
    ['Rakéta', `${DAMAGE.rocket} + ${DAMAGE.splash} a robbanás`, `${fire(ROCKET.cooldown)} / lövés`, `a robbanás ${DAMAGE.splashRadius} m-es körben sebez`],
    ['Lézer', `${DAMAGE.laser}`, `${fire(LASER.cooldown)} / lövés`, `azonnal talál, ${LASER.range} m-ig`],
    ['Lángszóró', `${FLAME.dps} / mp (épületen ${FLAME.structureDps} / mp)`, `folyamatos, ${FLAME.range} m-ig`, `${FLAME.fuel} mp üzemanyag; fát, házat, palackot is felgyújt`],
    ['Hármas lövés', `3 × a fegyver sebzése`, 'a fegyveré', 'ha mindhárom talál'],
    ['Géppuska', `${n(MG.damage)} / lövés (≈ ${Math.round(MG.damage / MG.interval)} / mp)`, `${n(MG.interval)} mp / lövés`, `magától lő, ${MG.range} m-ig`],
    [
      'Telepített löveg',
      `${turretDamage(1)} (1. szint) – ${turretDamage(LEVEL.max)} (${LEVEL.max}. szint)`,
      `${n(turretInterval(1))} – ${n(turretInterval(LEVEL.max))} mp / lövés`,
      `életerő ${turretMaxHp(1)} – ${turretMaxHp(LEVEL.max)}, lőtáv ${n(turretRange(1))} – ${n(turretRange(LEVEL.max))} m`,
    ],
    ['Akna', `legfeljebb ${MINE.damage}`, `${n(MINE.blastRadius)} m-es kör`, 'a távolsággal gyengül'],
    ['Tüzérségi csapás', `${STRIKE.shells} × legfeljebb ${STRIKE.damage}`, `${n(STRIKE.blastRadius)} m-es körök, ${STRIKE.spread} m-es szórás`, `minden ${STRIKE.every}. kilövés után jár (halál nélkül); a térképen kell kijelölni`],
    ['Gázpalack', `legfeljebb ${BARREL.damage}`, `${n(BARREL.blastRadius)} m-es kör`, 'találattól vagy ráhajtástól robban, láncban is'],
    ['Felrobbanó jármű', `legfeljebb ${Math.min(...cars.map((c) => c.blastDamage))} – ${Math.max(...cars.map((c) => c.blastDamage))}`, `${Math.min(...cars.map((c) => c.blastRadius))} – ${Math.max(...cars.map((c) => c.blastRadius))} m-es kör`, 'autó, teherautó, busz – a kigyulladt jármű pár másodperc múlva robban'],
  ];
}

/** Mi meddig tart: [mi, meddig]. */
export function durationRows(): string[][] {
  const timed = PICKUP_KINDS.filter((k) => PICKUPS[k].duration > 0).map((k) => [PICKUP_STYLE[k].label, `${PICKUPS[k].duration} mp`]);
  return [
    ...timed,
    ['Olajfolt a pályán', `${OIL.life} mp`],
    ['Olajos lánctalp (kipörög)', `${OIL.spinTime} mp a folt után`],
    ['Akna a pályán', `${Math.round(MINE.life / 60)} perc`],
    ['Füstfelhő', `${SMOKE.life} mp`],
    ['Álcázás', `${CLOAK.duration} mp, utána ${CLOAK.cooldown} mp múlva használható újra`],
    ['Telepített löveg', 'amíg ki nem lövik'],
    ['Újraéledés', `${TANK.respawnDelay} mp`],
    ['Felvett tárgy helyett új', `${PICKUP.respawnDelay} mp múlva, máshol`],
    ['Önjavítás', `${REGEN.delay} mp sebzés nélkül, utána másodpercenként ${n(REGEN.rate * 100)}%`],
    ['Javítóműhely', `másodpercenként ${n(WORKSHOP.rate * 100)}% (kb. ${Math.round(1 / WORKSHOP.rate)} mp alatt teljesen feltölt)`],
  ];
}

/**
 * A játékmenet lépései a főképernyőre: [cím, leírás (HTML)]. A határok (létszám, játékidő, a kód
 * hossza, a visszaszámlálás) a szabályok állandóiból jönnek.
 */
export function howToSteps(): [string, string][] {
  return [
    [
      'Belépés',
      'Regisztrálj egy játékosnévvel és egy jelszóval. A <b>jelszó a nevedet védi</b>: ezzel a névvel csak te tudsz belépni. E-mail-cím nem kell, ezért az elfelejtett jelszót nem lehet visszaállítani. Ha csak kipróbálnád: az <i>Egyjátékos</i> gombbal belépés nélkül, botok ellen azonnal játszhatsz.',
    ],
    [
      'Csatlakozás egy játékhoz',
      'A <i>Multiplayer</i> alatt látod a futó és a játékosra váró játékokat. Amelyik „Játékra vár”, abba be lehet lépni. A 🔒 privát játékot jelöl: oda a létrehozójától kapott <b>belépőkód</b> kell.',
    ],
    [
      'Saját játék létrehozása',
      `<i>Multiplayer → Új játék</i>: adj nevet a játéknak, a térképen az egér húzásával jelöld ki a játékteret (a kisebb terület pörgősebb – kétfős párbajhoz a legkisebb, kb. ${Math.round(MATCH.cell * MATCH.minCells)} méteres való), majd állítsd be a játékosok számát (${MATCH.players.min}–${MATCH.players.max}), a játékidőt (${MATCH.minutes.min}–${MATCH.minutes.max} perc), a botokat, a tárgyakat, a forgalmat és az időjárást.`,
    ],
    [
      'Belépőkód: privát játék',
      `Ha létrehozáskor <b>belépőkódot</b> adsz meg (${ROOM_CODE.min}–${ROOM_CODE.max} karakter), a játék privát: csak az tud belépni, akinek megmondod a kódot – így csak azokkal játszol, akikkel szeretnél. Üresen hagyva bárki csatlakozhat. A kód nem a fiókod jelszava, játékonként mást adhatsz. ${LIMITS.codeTries} hibás próbálkozás után ${Math.round(LIMITS.codeWait / 1000)} másodpercet várni kell.`,
    ],
    [
      'Váró és indulás',
      `A játék akkor indul, amikor összegyűlt a beállított létszám: ${MATCH.countdown} másodperces visszaszámlálás után mindenki a pályára kerül. Ha a létrehozó még a váróból kilép, a játék megszűnik. Meccs közben bárki kiléphet (bal fent: <i>Menü → Kilépés</i>), a többiek tovább játszanak; ha már csak egy játékos marad, a meccs véget ér.`,
    ],
    [
      'A meccs',
      'Death Match: az idő lejártáig mindenki mindenki ellen. Az nyer, aki a legtöbb tankot lövi ki. A kilövésekkel szintet lépsz – nagyobb, erősebb a tankod –, a pályán fegyvereket és képességeket vehetsz fel, a házak rombolhatók. A végén statisztika mutatja, ki mennyire volt jó, és ki volt a meccs legjobbja. A tárgyakról és a fegyverekről az <i>Útmutató</i>, a billentyűkről a <i>Beállítások</i> szól; a tankodat a <i>Tankom</i> alatt választod ki.',
    ],
  ];
}

/** A játékmenet leírása a főképernyőn. */
export function buildHowTo(root: HTMLElement): void {
  root.replaceChildren();
  for (const [title, html] of howToSteps()) {
    const item = document.createElement('li');
    item.innerHTML = `<b>${esc(title)}</b><span>${html}</span>`;
    root.appendChild(item);
  }
}

const table = (head: string[], rows: string[][], cls = ''): string =>
  `<div class="guide-scroll"><table class="guide-table ${cls}"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="name"' : ''}>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;

/** Az útmutató felépítése a megadott elembe; `keys`: a beállított billentyűk (a tárgyaknál megjelennek). */
export function buildGuide(root: HTMLElement, keys: KeyBindings): void {
  root.replaceChildren();
  const section = (title: string, html = ''): HTMLElement => {
    const box = document.createElement('section');
    box.className = 'guide-section';
    box.innerHTML = `<h3>${esc(title)}</h3>${html}`;
    root.appendChild(box);
    return box;
  };

  // --- felvehető tárgyak
  const total = PICKUP_KINDS.reduce((sum, k) => sum + PICKUPS[k].weight, 0);
  const items = section('Felvehető tárgyak', '<p class="note">A tárgyak a pályán hevernek: ráhajtva veszed fel őket. Az ellátó teherautó kilövése után is marad egy.</p>');
  const list = document.createElement('div');
  list.className = 'guide-items';
  for (const kind of PICKUP_KINDS) {
    const info = GUIDE_PICKUPS[kind];
    const row = document.createElement('div');
    row.className = 'guide-item';
    row.appendChild(iconOf(kind));
    const text = document.createElement('div');
    const share = PICKUPS[kind].weight > 0 ? `a tárgyak kb. ${Math.max(1, Math.round((PICKUPS[kind].weight / total) * 100))}%-a` : 'külön érkezik';
    const key = info.key ? ` <span class="guide-key">${esc(keysText(keys, info.key))}</span>` : '';
    text.innerHTML = `<b>${esc(PICKUP_STYLE[kind].label)}</b>${key}<br />${esc(info.what)}<br /><span class="guide-lasts">Meddig tart: ${esc(info.lasts)} · ${share}</span>`;
    row.appendChild(text);
    list.appendChild(row);
  }
  items.appendChild(list);

  // --- fegyverek
  section(
    'Fegyverek és sebzés',
    table(['Fegyver', 'Sebzés', 'Tüzelés / hatókör', 'Megjegyzés'], weaponRows()) +
      `<p class="note">A kezdő tank életereje ${TANK.maxHp}, szintenként ${LEVEL.hp}-gyel több. A sebzés a lövő tank szintjével nő: szintenként ${Math.round(LEVEL.damage * 100)}%-kal (a ${LEVEL.max}. szinten ${n(levelDamage(LEVEL.max))}-szeres). A szupertárgy alatt minden sebzés ${SUPER.power}-szoros. A robbanások a távolsággal gyengülnek (a szélükön a 40%-uk).</p>`,
  );

  // --- időtartamok
  section('Mi meddig tart', table(['Mi', 'Meddig'], durationRows(), 'narrow'));

  // --- a tank és a szintek
  section(
    'A tank és a szintek',
    `<ul class="guide-list">
      <li><b>Szintek:</b> 1–${LEVEL.max}. Egy játékos kilövése egy szint; ha legalább ${LEVEL.upsetGap} szinttel erősebb volt nálad, ${LEVEL.upsetGain}. ${LEVEL.botKills} bot ér egy szintet. A botok szívóssága a játék beállítása: közepes szinten kisebbet sebeznek (${Math.round(BOT_POWER.damage * 100)}%) és gyengébb a páncéljuk (${Math.round(BOT_POWER.armor * 100)}% sebzést kapnak), a legszívósabb bot egyenrangú a játékossal. A botok nem vesznek fel tárgyat és nem fejlődnek – kivéve a két legügyesebb szintet (nagyon ügyes, ultra ügyes). Ha kilőnek, ${LEVEL.deathLoss} szintet veszítesz, és a felszerelésed elvész (a lövegekből újra ${TURRET.base} jár).</li>
      <li><b>Kilövéssorozat:</b> minden ${STRIKE.every}. kilövés után (halál nélkül) tüzérségi csapás jár – ${esc(keysText(keys, 'strike'))}: feljön a nagy térkép, és azon kell kattintani a célpontra.</li>
      <li><b>Álcázás:</b> minden tank alapképessége (${esc(keysText(keys, 'cloak'))}): ${CLOAK.duration} mp-ig halvány sziluett vagy, a térképen nem látszol; a lövés megszünteti.</li>
      <li><b>Rombolás:</b> minden tank rombolja az épületet, amelynek nekifeszül; a nagyobb tank gyorsabban, a nehéz tankok a kisebb házakon megállás nélkül áthajtanak. A fák és oszlopok kidőlnek.</li>
      <li><b>GPS:</b> a nagy térképen (M) kattints a célra – a GPS a normál utakon odavezet (kék sáv a földön, nyíl a kép szélén, távolság a térkép sarkában). Kikapcsolás: ${esc(keysText(keys, 'gps'))} vagy jobb klikk a nagy térképen.</li>
      <li><b>Javítás:</b> javítókészlet (+${PICKUP.repairAmount}), javítóműhely (a térképen zöld kereszt), és lassú önjavítás, ha ${REGEN.delay} mp-ig nem ér találat.</li>
    </ul>`,
  );
}
