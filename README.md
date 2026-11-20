# TANK MISLENY

Böngészőben futó, felülnézetes, többjátékos tankos játék. A pálya
**Kozármisleny** beépített területe (kb. 2 × 3,5 km), valós térképadatokból;
a tájékozódási pont a **Polgármesteri Hivatal** (Pécsi utca 124.).

A játékosok regisztráció után szobákat (játékokat) hozhatnak létre vagy
léphetnek be mások szobájába. A szoba létrehozója csúszkákkal állítja be a
játékteret (a térkép egy kijelölt részét – akár egy képernyőnyi arénát kétfős párbajhoz), a játékosok számát, a játékidőt (5–30 perc), a
botok, a felvehető tárgyak és a civil forgalom mennyiségét és az időjárást
(nappal, eső, este), és belépőkóddal priváttá teheti a játékot. Mindenki mindenki ellen játszik; a kilőtt tank újraéled,
és az nyer, aki az idő lejártáig a legtöbb tankot lövi ki.
Gyakorolni egyedül is lehet a botok ellen (*Egyjátékos*): ehhez sem belépés,
sem elérhető szerver nem kell.

A pályán felvehető tárgyak vannak (másféle fegyverek, pajzs, turbó, olajfolt…),
a fák és az oszlopok kidönthetők, az épületek a találatoktól összedőlnek, az
eltalált tetők, fák és tankok kigyulladnak, a tank pedig minden kilövéssel
szintet lép – a szintje a kilövése után is megmarad –, és hat egyre nagyobb,
más kinézetű típuson megy végig a felderítőtől a titánig.

## Indítás

Előfeltétel: Node.js 20 vagy újabb.

A játékhoz szerver kell: ez adja ki a játék oldalát, tartja a szobák listáját,
és futtatja a meccseket. Windows alatt két indítófájl van:

- **`inditas.bat`** – összeállítja a játékot, elindítja a szervert ezen a
  gépen, és megnyitja a böngészőt (<http://localhost:8787/>). Egyedül vagy a
  helyi hálózaton játszáshoz, kipróbáláshoz.
- **`szerver.bat`** – ugyanez, de a szervert az interneten is elérhetővé
  teszi egy alagúton keresztül. Beállítása: [docs/multiplayer.md](docs/multiplayer.md).

A `commit.bat` a változásokat menti és feltölti a GitHub-tárolóba.

Fejlesztéshez, parancssorból (két ablakban):

```bash
npm install
npm run server   # a játékszerver a 8787-es porton
npm run dev      # fejlesztői oldal: http://localhost:5173/ (a szerverhez továbbít)
```

## Irányítás

Klasszikus tankirányítás; a tank elejét a sárga, hegyes orr jelöli. A
billentyűk a főmenü **Beállítások** pontjában átállíthatók; ezek az alapértékek:

| Bemenet | Hatás |
|---|---|
| W / ↑ | előre, amerre a tank eleje néz |
| S / ↓ | tolatás |
| A D / ← → | a tank forgatása (helyben is) |
| Egér | a torony célzása; bal gomb: lövés, jobb gomb: olajfolt |
| Szóköz | lövés |
| Shift | gyorsító: +30% sebesség legfeljebb 3 másodpercig, utána le kell hűlnie |
| E | olajfolt lerakása (ha van töltet) |
| Q | ágyú telepítése a tank mögé (ha van töltet) |
| R / C | akna lerakása / füst (ha van töltet) |
| X | tüzérségi csapás a célkeresztre (három kilövésenként jár, halál nélkül) |
| Bal Ctrl / V | álcázás: 10 másodpercig halvány sziluett (percenként egyszer) |
| Enter / T | üzenet írása / beszéd, amíg nyomva van (többjátékos meccsen) |
| Tab | eredménytábla, amíg nyomva van (vagy kattintás az órára) |
| M | az egész város térképe utcanevekkel |
| F | teljes képernyős mód |
| H | információ: az irányítás, a tank állapota, a játékosok – és a kilépés |

Játék közben a képernyőn csak a térkép és az információ gombja (**i**) látszik
állandóan, felül középen pedig a visszaszámláló óra és az állás; a tank fölött
az életereje és a gyorsító hőfoka.

## Parancsok

| Parancs | Mit csinál |
|---|---|
| `npm run server` | a szerver összeállítása és indítása (a `dist/` mappából adja ki az oldalt) |
| `npm run dev` | fejlesztői oldal (a `/ws` kéréseket a helyben futó szervernek továbbítja) |
| `npm run build` | típusellenőrzés + éles build: az oldal a `dist/`, a szerver a `dist-server/` mappába |
| `npm start` | a már összeállított szerver indítása |
| `npm test` | Vitest tesztek (szimuláció, meccsszabályok, szerver, fiókok, pályaadat) |
| `npm run e2e` | végigjátszott próba két böngészővel a futó szerveren, képernyőképekkel (telepített Chrome kell hozzá) |
| `npm run map` | térképadatok újraletöltése (OSM + kiegészítő épületek) és feldolgozása |
| `npm run map:fetch` / `map:buildings` | csak az OSM-adat, illetve csak a kiegészítő épületalaprajzok letöltése |
| `npm run map:process` | csak feldolgozás a meglévő nyers adatból |

## Technológia

TypeScript, Vite, Phaser 3 a kliensen; Node.js és WebSocket (`ws`) a
szerveren; tesztek: Vitest; böngészős próba: playwright-core. A játéklogika
(`src/game/sim/`) közös: a szerver számol vele mindent, a kliens ugyanezzel
jelzi előre a saját tank mozgását. A térkép kirajzolása háttérszálakon fut; a
térkép, a sprite-ok és a hangok kódból készülnek, külső kép- vagy hangfájl nincs.

## Dokumentáció

- [docs/map-data.md](docs/map-data.md) – adatforrás, a hivatal azonosítása,
  lekérdezés, feldolgozás, mi valós adat és mi generált, ismert hiányosságok
- [docs/gameplay.md](docs/gameplay.md) – játékmenet, szabályok, megjelenítés, kódfelépítés
- [docs/multiplayer.md](docs/multiplayer.md) – a szerver működése, indítása a saját gépen, elérés az internetről saját domainnel, fiókok, költöztetés

## Térképadat és licenc

A pálya térképi adatai: **© OpenStreetMap közreműködők**, az
[Open Database License (ODbL)](https://www.openstreetmap.org/copyright)
feltételei szerint. Ahol az OSM-ben nincs épületkontúr (főleg a város déli
és keleti részén), ott az épületek alaprajza a
[Microsoft Global ML Building Footprints](https://github.com/microsoft/GlobalMLBuildingFootprints)
nyílt adatbázisából származik (szintén ODbL). A forrásmegjelölés a játékban
is látható (a főképernyőn és az információs panelen).

A pálya stilizált játéktér. **Az OSM-ből származik:** az utak nyomvonala és
neve, az épületek alaprajza és helye, a területhasználat, a vizek, a
tájékozódási pontok és a zebrák helye. **Nem valós adat:** az útszélességek
(a valóságosnál szélesebbek; az így útra kerülő házak alaprajzát a
feldolgozó az út széléhez vágja, néhányat kihagy – lásd `docs/map-data.md`),
a tetők formája és színe, a kémények, valamint a fák, bokrok és
villanyoszlopok helye (ezek generáltak). **Fotók alapján, kézzel felvett:**
a Polgármesteri Hivatal, a református templom és a rendőrség megjelenése és
közvetlen környezete, valamint a főút utcaképe – a `pictures/` mappa
képeiből. A képek csak mintául szolgálnak, a játékba nem kerülnek be, és a
mappa nincs verziókezelés alatt. A pálya nem méretarányos térkép és
nem geodéziai pontosságú. Egy új beépítésű részen 49 ház a pálya
készítőjének vázlatrajza alapján, kézzel került fel, mellettük 11 generált
(kitalált) ház áll – részletek: `docs/map-data.md`. A letöltő és feldolgozó
scriptek nem használnak Google Maps-adatot.
