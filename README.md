# TANK MISLENY

Böngészőben futó, felülnézetes tankos játék prototípusa. A pálya
**Kozármisleny** teljes beépített területe (kb. 2 × 3,5 km), valós
térképadatokból; a kiindulópont a **Polgármesteri Hivatal** (Pécsi utca 124.).

A pályán gép vezérelte ellenséges tankok járőröznek (a számuk állítható), az
utakon pedig felvehető tárgyak vannak: másféle lövedékek, pajzs, turbó,
olajfolt és társaik. A fák és az oszlopok kidönthetők, a lövések nyoma és a
kilőtt tankok roncsa megmarad, a saját tank pedig minden kilövéssel szintet lép. Látszanak az utak, a járdák, a zebrák, az épületek, a
parkok, a fák és a tájékozódási pontok; az utcanevek az útburkolatra vannak írva.

## Indítás

Előfeltétel: Node.js 20 vagy újabb.

Windows alatt a legegyszerűbb az `inditas.bat` fájlra duplán kattintani: ez
az optimalizált (éles) változatot állítja össze és nyitja meg a böngészőben.
A `commit.bat` a változásokat menti és feltölti a GitHub-tárolóba.

Fejlesztéshez, parancssorból:

```bash
npm install
npm run dev
```

Ezután nyisd meg a böngészőben a kiírt címet (alapesetben
<http://localhost:5173/>).

## Irányítás

Klasszikus tankirányítás. A tank elejét a sárga, hegyes orr jelöli.

| Bemenet | Hatás |
|---|---|
| W / ↑ | előre, amerre a tank eleje néz |
| S / ↓ | tolatás |
| A D / ← → | a tank forgatása (helyben is) |
| Egér | a torony célzása |
| Bal kattintás / Space | lövés |
| Shift | gyorsító: +30% sebesség legfeljebb 3 másodpercig, utána le kell hűlnie |
| M | az egész város térképe utcanevekkel (a sarokban lévő kis térkép a tank környékét mutatja) |
| F | teljes képernyős mód be/ki (a bal felső gombbal is) |
| E / jobb egérgomb | olajfolt lerakása (ha van töltet) |
| + / − | több / kevesebb ellenséges tank, legfeljebb 100 (a HUD gombjaival tízesével is) |
| R | új kör |
| H | súgó be/ki |
| Q | részletesség váltása (12 → 10 → 8 pixel/méter); gyengébb gépen az alacsonyabb érték gyorsabb |

## Parancsok

| Parancs | Mit csinál |
|---|---|
| `npm run dev` | fejlesztői szerver |
| `npm run build` | típusellenőrzés + éles build a `dist/` mappába |
| `npm run preview` | az éles build kipróbálása |
| `npm test` | Vitest tesztek (szimuláció, ütközés, pályaadat) |
| `npm run map` | térképadatok újraletöltése (OSM + kiegészítő épületek) és feldolgozása |
| `npm run map:fetch` / `map:buildings` | csak az OSM-adat, illetve csak a kiegészítő épületalaprajzok letöltése |
| `npm run map:process` | csak feldolgozás a meglévő nyers adatból |
| `npm run perf` | teljesítménymérés a futó játékon (betöltés, képkockánkénti számítási idő, memória) |
| `npm run shots` | füstteszt + képernyőképek a futó játékról (a gépen telepített Chrome/Edge kell hozzá, és közben fusson az `npm run dev`) |

## Technológia

TypeScript, Vite, Phaser 3; tesztek: Vitest; képernyőképek: playwright-core.
A játék legfeljebb Full HD (1920 × 1080) belső felbontásban, 12 pixel/méter
részletességgel rajzol; kisebb kijelzőn magától kevesebb pixellel dolgozik.
A térkép kirajzolása háttérszálakon fut. A térkép, a sprite-ok és a hangok kódból készülnek,
külső kép- vagy hangfájl nincs.

## Dokumentáció

- [docs/map-data.md](docs/map-data.md) – adatforrás, a hivatal azonosítása,
  lekérdezés, feldolgozás, mi valós adat és mi generált, ismert hiányosságok
- [docs/gameplay.md](docs/gameplay.md) – játékmenet, kódfelépítés, a
  többjátékos mód előkészítése

## Térképadat és licenc

A pálya térképi adatai: **© OpenStreetMap közreműködők**, az
[Open Database License (ODbL)](https://www.openstreetmap.org/copyright)
feltételei szerint. Ahol az OSM-ben nincs épületkontúr (főleg a város déli
és keleti részén), ott az épületek alaprajza a
[Microsoft Global ML Building Footprints](https://github.com/microsoft/GlobalMLBuildingFootprints)
nyílt adatbázisából származik (szintén ODbL). A forrásmegjelölés a játékban
is látható (jobb alsó sarok).

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
nem geodéziai pontosságú. A projekt nem használ Google Maps-adatot.
