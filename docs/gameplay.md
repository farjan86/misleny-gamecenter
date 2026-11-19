# Játékmenet és architektúra

## Jelenlegi állapot (első prototípus)

Kozármisleny teljes beépített területén (2000 × 3460 m) lehet tankkal harcolni gép vezérelte ellenfelek ellen, felvehető tárgyakkal.

### Irányítás

| Bemenet | Hatás |
|---|---|
| W / ↑ | előre, amerre a tank eleje (a sárga orr) néz |
| S / ↓ | tolatás (lassabb) |
| A D / ← → | a tank testének forgatása, helyben is |
| Egér | a torony a kurzor felé fordul (amíg az egér nem mozdult, a torony a testet követi) |
| Bal kattintás / Space | lövés |
| M | az egész város térképe utcanevekkel be/ki; a sarokban lévő kis térkép a tank kb. 700 m-es környékét mutatja |
| F | teljes képernyős mód be/ki (a HUD bal felső gombjával is) |
| E / jobb egérgomb | olajfolt lerakása a tank mögé (ha van töltet) |
| + / − | több / kevesebb ellenséges tank |
| R | új kör: vissza a kezdőpontra, a botok és a tárgyak újra szétszóródnak |
| H | súgó be/ki |
| Q | részletesség váltása (az oldal újratöltődik) |

Irányítási modell: klasszikus tankirányítás – az A/D a tank testét forgatja,
a W/S a test saját iránya szerint visz előre vagy hátra. A torony ettől
függetlenül, az egérrel céloz. A forgás fokozatosan gyorsul fel: egy rövid
billentyűnyomás csak egy-két fokot fordít (finom iránytartás íves utcán), a
nyomva tartás erős fordulást ad. Teljes sebességnél a tank lassabban fordul,
mint állva, a legszűkebb íve ilyenkor kb. 15 m sugarú. A tank elejét sárga, hegyes orr és előre
mutató fekete nyilak jelölik; a hátulján a sötét motortér és a kipufogók
látszanak.

### Szabályok a prototípusban

- Burkolt úton teljes sebesség (előre 17 m/s, tolatva 9 m/s), terepen 72%.
- Épületek, vízfelületek, kerítések és a parkoló autók nem járhatók át; a
  fáknak és a villanyoszlopoknak csak a törzse akadály, a lombkorona alatt a
  tank elfér. A bokrokon és a patakokon át lehet hajtani.
- A pálya széle fal; a kamera a pálya határán megáll.
- A tank életereje 100. Egy sima lövedék 25-öt sebez, a nehéz 50-et, a
  rakéta 55-öt (a robbanása 7 m-en belül további 30-at), a lézer 18-at.
- A kilőtt tank 4 másodperc múlva éled újra (a játékos a kezdőponton, a botok
  véletlen helyen, a játékostól távol), rövid sebezhetetlenséggel.
- Az azonos csapatbeliek nem sebzik egymást: a botok lövedéke átmegy a többi
  boton.
- Egyetlen épület sem rombolható; a Polgármesteri Hivatal a tervek szerint
  később sem lesz az.

### Ellenséges tankok (botok)

A gép vezérelte, vörös tankok száma 0 és 12 között állítható a HUD
„Ellenfelek" sorának − / + gombjával vagy a − / + billentyűvel; a beállítás a
böngészőben megmarad (`settings.ts`). Az alapérték 3.

- **Járőr:** az utakat követik, a jobb oldali sávban, a játékosnál lassabban.
- **Támadás:** ha 75 m-en belül rálátnak a játékosra (fal nem takarja),
  0,7 másodperc múlva tüzelni kezdenek, és lőtávolságon belülre mennek. A
  játékosnál lassabban lőnek (1,2 másodpercenként), és nem céloznak tökéletesen.
- **Üldözés:** ha szem elől tévesztik a játékost, 7 másodpercig az utolsó
  ismert helye felé tartanak, utána újra járőröznek.
- Egymásra nem céloznak, és egymást nem sebzik.
- A felvehető tárgyakat ők is felveszik, ha áthajtanak rajtuk, és az olajon
  ők is megcsúsznak.

A botok „agya" (`sim/bots.ts`) ugyanazt a bemenetet adja a szimulációnak, mint
egy játékos, így később a szerveren is futhat.

### Felvehető tárgyak

Egyszerre 70 tárgy van szétszórva a város útjain (ebből 8 a kezdőpont
közelében); a felvett tárgy helyett 25 másodperc múlva új jelenik meg,
máshol. A tank érintésre veszi fel őket.

| Tárgy | Hatás | Időtartam |
|---|---|---|
| Nehéz lövedék | nagyobb robbanás és lőtáv, dupla sebzés | 20 mp |
| Hármas lövés | három lövedék (rakéta, lézersugár) legyezőben | 20 mp |
| Gyorstöltő | 2,5-szer gyorsabb tüzelés | 15 mp |
| Pattanó lövedék | a falról kétszer visszapattan, mielőtt robban | 20 mp |
| Rakéta | lassan indul, felgyorsul, kb. 200 m-re repül, területre sebez | 20 mp |
| Lézer | azonnal célba érő sugár 130 m-ig | 15 mp |
| Olajfolt | 3 lerakható folt (`E` vagy jobb egérgomb); aki ráhajt, 1,7 mp-ig irányíthatatlanul pörög és sodródik | 3 töltet, a folt 45 mp-ig marad |
| Turbó | 45%-kal nagyobb végsebesség, jobb gyorsulás | 12 mp |
| Terepjáró lánctalp | terepen sem lassul a tank, olajon sem csúszik meg | 25 mp |
| Pajzs | egy töltet egy találatot nyel el (legfeljebb 3) | töltet |
| Sebezhetetlenség | semmi nem sebez, olajon sem csúszik meg | 10 mp |
| Radar | a térképeken látszanak a felvehető tárgyak | 30 mp |

A lézer elsőbbséget élvez a rakétával szemben, ha mindkettő aktív. Az olajfolt
a lerakójára is hat, miután egyszer lehajtott róla. Az aktív tárgyak a HUD bal
felső részén látszanak a hátralévő idővel.

### Ami még nincs kész

- menürendszer a beállításokhoz (a beállítások tárolása már külön modulban van);
- meccs időkorláttal és végeredménnyel, 2 csapatos mód;
- rombolható akadályok;
- érintőképernyős irányítás (mobilon a játék nincs kipróbálva);
- online többjátékos mód.

## Megjelenítés

- A látómező mindig 160 × 90 méter. A belső felbontás a részletességtől
  függ: 12 pixel/méternél 1920 × 1080. Más ablakméretnél a kép arányosan,
  simítva méreteződik.
- A térkép nem előre megrajzolt kép és nem csempékből áll: a vektoros
  pályaadatot a `raster.ts` 256 × 256 pixeles darabokban, futás közben
  rajzolja ki, mindig csak a kamera környékét. Ugyanez a rajzoló készíti a
  minitérképet is, kisebb felbontásban.
- A korábbi, 4 pixel/méteres „nagy pixeles" megjelenést a részletesebb kép
  váltotta fel; a stílus (kézzel rajzolt hatású, határozott körvonalak,
  korlátozott színpaletta) megmaradt.

## Teljesítmény

A cél: gyengébb asztali gépen is egyenletes kép. Ami ezt szolgálja:

- **Háttérszálak.** A térképdarabokat legfeljebb három Web Worker rajzolja
  (`chunkWorker.ts`); a fő szál csak a kész pixeleket tölti textúrába,
  képkockánként korlátozott időkerettel. Háttérszál nélkül a rajzolás
  tartalékként a fő szálon fut.
- **A kijelzőhöz igazodó részletesség.** Induláskor annyi pixel/méter
  állítódik be, amennyit a kijelző teljes képernyőn meg tud mutatni
  (legfeljebb 12, legalább 8). A `Q` billentyűvel vagy az URL `?ppm=8`
  paraméterével kézzel is csökkenthető.
- **Takarékos rajzoló.** A tetők alatti talajt és a később felülírt füvet
  nem számolja ki.
- **Térbeli indexek.** A fák, bokrok, oszlopok, épületek és utak rácsba
  rendezve kereshetők, így a rajzoló és a szimuláció a pálya méretétől
  függetlenül csak a közeli elemekkel dolgozik.
- **Kevés textúra és rajzolási hívás.** A térképdarabok közvetlenül a
  pixelekből lesznek textúrák (vászon nélkül), a látómezőn kívüliek nem
  rajzolódnak ki, a messzire kerültek fokozatosan törlődnek. Az útra írt
  utcanevek és az effektek sprite-jai csak szükség szerint jönnek létre, és
  újrahasznosulnak.
- **Nincs teljes képernyős élsimítás (MSAA)**, két videokártyás gépen a
  játék az erősebbet kéri.
- **A HUD csak változáskor ír a DOM-ba**, a minitérkép csak akkor rajzolódik
  újra, ha a tank elmozdult.

Mérés: `npm run perf` (futó játék mellett). Intel Iris Xe videokártyás
gépen, a teljes városi pályával a fő szál képkockánként átlagosan 0,4–1 ms-ot
dolgozik (60 FPS-hez 16,7 ms fér bele), 6–8 rajzolási hívással; a pálya
nagyobbítása ezen nem változtatott.

## Felépítés

```
src/
  main.ts                 belépési pont: pálya betöltése, Phaser indítása
  game/
    sim/                  JÁTÉKLOGIKA – nincs Phaser- vagy DOM-függés
      collision.ts        szakaszrács: kör–fal ütközés, sugárvetés
      world.ts            tankok, lövedékek, sebzés, tárgyak, olajfoltok; rögzített lépésközű step()
      pickups.ts          a felvehető tárgyak típusai és szabályai
      bots.ts             a gép vezérelte tankok viselkedése
    maps/                 PÁLYA
      types.ts            a pályafájl szerkezete
      GameMap.ts          betöltés, ütközési rács, út-keresés, kezdőpont
      rasterCore.ts       a rajzoló alapjai: színek, zaj, sokszög- és vonalrajzolás
      raster.ts           térképrajzoló (vektor → pixel): talaj- és lombréteg
      landmarkRaster.ts   a hivatal és környezete a fotók alapján felvett adatokból
      roadLabels.ts       az útra írt utcanevek helyének kiszámítása
      ChunkLayer.ts       a rajzolt rétegek darabonkénti, igény szerinti előállítása
      chunkWorker.ts      a térképdarabok kirajzolása háttérszálon
      RoadLabelLayer.ts   az útra írt utcanevek, csak a kamera közelében
    entities/             MEGJELENÍTÉS: tankok, tárgyikonok, kódból rajzolt sprite-ok
    settings.ts           a játék beállításai (pl. a botok száma), a böngészőben megőrizve
    systems/audio.ts      szintetizált hangok (Web Audio)
    ui/Hud.ts             HUD: utcanév, minitérkép, feliratok, forrásmegjelölés
    ui/fullscreen.ts      teljes képernyős mód (F billentyű, gomb)
    quality.ts            a részletesség (pixel/méter) megválasztása
    scenes/GameScene.ts   bemenet → szimuláció → megjelenítés
assets/maps/osm/          nyers OSM-adat + lekérdezés, kiegészítő épületalaprajzok
assets/maps/landmarks/    fotók alapján kézzel felvett részletek (hivatal)
assets/maps/processed/    feldolgozott pályafájl
pictures/                 fotók mintának (nincs verziókezelés alatt)
scripts/                  letöltő, feldolgozó, képernyőkép-készítő és mérő scriptek
inditas.bat               a játék indítása (éles változat)
commit.bat                mentés és feltöltés a GitHubra
tests/                    Vitest tesztek (szimuláció, pályaadat)
```

A három terület – **térképi adat**, **játéklogika**, **megjelenítés** – külön
modulokban van:

- A térképi adat egyetlen JSON-fájl; új pálya másik kivágásból ugyanazzal a
  két scripttel készíthető.
- A játéklogika (`sim/`) méterben és másodpercben számol, a megjelenítésről
  semmit nem tud.
- A megjelenítés csak olvassa a szimuláció állapotát.

### Pályarétegek

A rajzolási sorrend egyben a rétegrend:

1. alap talaj és területhasználat (fű, kert, szántó, erdőtalaj, park, víz…);
2. patakok;
3. gyalogutak, kerékpárutak, földutak;
4. járdák (a lakóutcák füves sávja mögött), padka a főutak mellett, úttest, felezővonal, zebrák;
5. kerítések;
6. bokrok;
7. vetett árnyékok (épületek, fák, oszlopok);
8. fatörzsek, villanyoszlopok;
9. épületek (tetők, kémények);
10. az útra írt utcanevek;
11. olajfoltok, majd a **mozgó elemek:** tankok, lövedékek, rakétafüst, lézersugár;
12. **lombréteg:** fák koronája, vezetékek, a hivatal előtti zászlók – a
    tank fölött, kissé áttetszően;
13. felvehető tárgyak, a tankok életerősávja, robbanások, valamint egy sárga
    gyűrű és nyíl, amely a lombkorona alatt álló saját tank helyét és irányát mutatja.

Az ütközési geometria ettől független réteg (`GameMap.walls`), ugyanabból az
adatból készül.

## Előkészítés az online többjátékos módra

Ez még nincs megvalósítva, de a kód már ehhez igazodik.

**Ami már így működik:**

- A `World` (`sim/world.ts`) tiszta, determinisztikus, rögzített lépésközű
  (60 Hz) szimuláció; Node.js alatt változtatás nélkül futtatható (a tesztek
  így futtatják).
- A kliens **bemenetet** ad (`TankInput`: gáz, forgatás, célzás, tűz, olajfolt),
  nem állapotot; a botok is ugyanezen a felületen keresztül irányítanak. A `GameScene` soha nem írja közvetlenül a tank helyzetét.
- A szimuláció **eseményeket** ad vissza (lövés, becsapódás, találat, kilövés,
  tárgyfelvétel, megcsúszás…), a hangok és effektek ezekből készülnek –
  hálózaton ugyanezek küldhetők.
- A véletlen elemek (a tárgyak helye és típusa, a botok döntései) rögzített
  magú generátorból jönnek: azonos magból és bemenetekből azonos játék lesz.
- A csapatok és a sebzés szabályai a szimulációban vannak (azonos csapat nem
  sebzi egymást) – a 2 csapatos mód erre épülhet.
- A megjelenítés két szimulációs állapot között interpolál; ugyanez a
  mechanizmus használható a szerverről érkező állapotokra.
- A látómező rögzített (160 × 90 m), nem függ az ablak méretétől, így
  minden játékos ugyanannyit lát.

**Tervezett szerver-authoritatív modell:**

- A szerver (Node.js + Socket.IO vagy hasonló) futtatja a `World`-öt
  szobánként; ő kezeli a pozíciókat, lövéseket, találatokat és pontokat.
- A kliens `input` üzeneteket küld sorszámmal; a szerver ellenőrzi a
  mozgást és a találatokat (a kliens állapotát nem fogadja el).
- A szerver 20–30 Hz-en állapot-pillanatképeket küld; a kliens a saját
  tankját előre számolja (prediction) és a szerver állapotához igazítja, a
  többieket interpolálja.
- Szobák: 2–8 játékos, 5 perces meccs, FFA, később 2 csapat. Újracsatlakozás
  szoba- és játékosazonosítóval.
- Verziózható üzenetek: minden üzenet `{ v, type, ... }` alakú, a `v`
  protokollverzió; a szerver az ismeretlen verziót elutasítja.

Tervezett üzenettípusok (vázlat):

| Irány | Típus | Tartalom |
|---|---|---|
| kliens → szerver | `join` | becenév, szobakód, (újracsatlakozási token) |
| kliens → szerver | `input` | sorszám, `TankInput` |
| szerver → kliens | `welcome` | játékosazonosító, pálya neve, szimulációs paraméterek |
| szerver → kliens | `snapshot` | tick, tankok és lövedékek állapota, utolsó feldolgozott inputsorszám |
| szerver → kliens | `event` | `SimEvent`-ek, kiütések, pontok |
| szerver → kliens | `matchEnd` | végeredmény |

Becenevek: a játékosok csak becenevet adnak meg; személyes adat nem kerül a
játékba.
