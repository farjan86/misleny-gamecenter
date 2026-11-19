# Játékmenet és architektúra

A többjátékos mód, a szerver és a fiókok leírása külön fájlban van:
[multiplayer.md](multiplayer.md). Ez a fájl a játék szabályait, a
megjelenítést és a kód felépítését írja le.

## A játék

Kozármisleny térképének egy kijelölt részén, tankkal, mindenki mindenki ellen.
Egy meccsben 1–8 játékos és (beállítástól függően) gép vezérelte botok vannak.
Minden játékosnak 1, 3 vagy 5 élete van; akinek elfogy, kiesik. **Az nyer, aki
utolsónak marad.**

### Menük

- **Főképernyő:** belépés vagy regisztráció (játékosnév + jelszó), utána
  *Multiplayer*, *Beállítások*, *Kijelentkezés*.
- **Beállítások:** a billentyűkiosztás. Műveletenként két billentyű adható
  meg; egy billentyű csak egy művelethez tartozhat. A beállítás a böngészőben
  megmarad.
- **Multiplayer:** a nyitott játékok listája, belépés, új játék létrehozása
  (lásd [multiplayer.md](multiplayer.md)).

### Irányítás (alapértékek)

| Bemenet | Hatás |
|---|---|
| W / ↑ | előre, amerre a tank eleje (a sárga orr) néz |
| S / ↓ | tolatás (lassabb) |
| A D / ← → | a tank testének forgatása, helyben is |
| Egér | a torony a kurzor felé fordul; bal gomb: lövés, jobb gomb: olajfolt |
| Szóköz | lövés |
| Shift | gyorsító |
| E | olajfolt lerakása a tank mögé (ha van töltet) |
| M | az egész város térképe utcanevekkel be/ki |
| F | teljes képernyős mód be/ki |
| H | információs panel be/ki |

Irányítási modell: klasszikus tankirányítás – az A/D a tank testét forgatja,
a W/S a test saját iránya szerint visz előre vagy hátra, a torony ettől
függetlenül, az egérrel céloz. A forgás fokozatosan gyorsul fel: egy rövid
billentyűnyomás csak egy-két fokot fordít (finom iránytartás íves utcán), a
nyomva tartás erős fordulást ad. Teljes sebességnél a tank lassabban fordul,
mint állva.

### Ami a képernyőn látszik

Játék közben állandóan a **térkép** (jobb felül), az **információ gombja**
(bal felül, *i*) és mellette a **tank sávja** látszik.

- **A pálya a kijelölt játéktérre van vágva:** a kamera a játéktér szélén
  megáll (a határt sárga vonal jelzi), azon túl semmi nem látszik – a térképen sem.
- **A tank sávja:** elöl a tank szintje, utána ami éppen nála van – a fegyver
  (nehéz lövedék, rakéta, lézer), a megmaradó képességek (pattanó lövedék), a
  hármas lövés hátralévő lövései, a pajzs- és olajtöltetek, valamint az időre
  szóló tárgyak a hátralévő másodpercekkel.
- A térkép a tank kb. 700 m-es környékét mutatja (kis játéktérnél az egészet); az M az egész játékteret mutatja nagyban. A botok piros, a többi játékos narancssárga pontként látszik
  (a játékosok mindig, bármilyen messze vannak).
- A saját tank zöld, a botok vörösek, a többi játékos tankja kék.
- A tankok fölött az életerősáv; a sajátod fölött még az életeid (sárga
  pontok) és – használat közben – a gyorsító hőfoka.
- Az **információs panel** (H vagy az *i* gomb): az irányítás az aktuális
  billentyűkkel, a tankod állapota (életerő, szint, életek, fegyver, aktív
  tárgyak), a játékosok állása, a forrásmegjelölés és a *Kilépés a meccsből* gomb.
- A fontos események rövid értesítésként jelennek meg felül (felvett tárgy,
  kilövés, kiesés, szintlépés).
- A tájékozódási pontok (hivatal, templom, rendőrség…) felirata a pályán marad.

### Szabályok

- **Mozgás:** burkolt úton teljes sebesség (előre 17 m/s, tolatva 9 m/s),
  terepen 72%. A zöldterületeken szabadon lehet menni.
- **Gyorsító (Shift):** amíg nyomva van, a tank 30%-kal gyorsabb. Összesen
  3 másodpercig bírja: ekkor túlmelegszik, és nem használható, amíg teljesen
  le nem hűl (kb. 6 másodperc). Ha előbb elengeded, a hő fokozatosan csökken.
- **Akadályok:** az épületek, vízfelületek, kerítések, parkoló autók és a
  roncsok nem járhatók át. A fák és a villanyoszlopok nem akadályok: a tank
  kidönti őket. A bokrokon és a patakokon át lehet hajtani.
- **A játéktér határa** fal: a tank nem megy át rajta, a lövedék ott becsapódik.
- **Sebzés:** a tank életereje 100 (szintenként több). Egy sima lövedék 25-öt
  sebez, a nehéz 50-et, a rakéta 55-öt (a robbanása 7 m-en belül további
  30-at), a lézer 18-at.
- **Kilövés:** a kilőtt tank 4 másodperc múlva éled újra – véletlen helyen, a
  többi játékostól távol –, rövid sebezhetetlenséggel, alapfegyverrel. Ha nincs
  több élete, kiesik. A roncsa ott marad, ahol kilőtték (akadály; egy ideig ég).
- **Szintek:** a játékos tankja minden kilőtt tank után szintet lép (legfeljebb
  a 20. szintig): szintenként 3%-kal nagyobb, 12-vel több a legnagyobb
  életereje, és 8%-kal többet sebez. A szint a kilövés után is megmarad. A
  botok nem lépnek szintet.

### A pálya rombolása

- **Fák, oszlopok:** kidőlnek, ha a tank nekimegy vagy lövés éri őket (a
  rakéta robbanása a közelieket is kidönti), és úgy maradnak.
- **Épületek:** minden épületnek életereje van az alapterülete szerint
  (60 + 0,9 × m², legalább 80, legfeljebb 600). A találatok fogyasztják
  (ugyanannyit, amennyit egy tankon sebeznének, a lövő szintjével növelve);
  ha elfogy, **az épület összedől**: rom marad a helyén, amelyen át lehet
  hajtani. Egy 100 m²-es ház 6 sima vagy 3 nehéz lövedéket, illetve 3 rakétát bír.
- **Magas szintű tank:** a 6. szinttől a tank az ütközésével is rombolja az
  épületet, amelynek nekifeszül (szintenként egyre gyorsabban), a 12. szinttől
  pedig az épület érintésre összedől.
- **A Polgármesteri Hivatal nem dönthető le.**
- **Tűz:** a találatot kapott háztető, a lövéstől kidőlt fa, az összedőlő
  épület és a kilőtt tank kigyullad, és egy ideig ég (kb. 10–45 másodperc).
  A tűz csak látvány: nem sebez és nem terjed.
- **Lövésnyomok:** a becsapódás helyén maradandó nyom keletkezik (kráter a
  talajon, beszakadt, kormos folt a tetőn).

### Időjárás

- **Nappal:** az alapállapot.
- **Eső:** a burkolatlan talaj (fű, kert, park, szántó) **sáros és csúszik**:
  a tank lassabb rajta, nehezen gyorsul, fékezéskor sokáig csúszik, gyors
  kanyarban pedig megcsúszik és rövid ideig irányíthatatlanul sodródik. A
  burkolt út nem csúszik; a terepjáró lánctalp megvéd. A zöld felületek sár
  színűek, esik az eső.
- **Este:** sötét van, de nem teljesen – a pálya kivehető marad. Világít a
  közvilágítás (az álló villanyoszlopok és a lámpák; a kidöntött oszlop nem),
  a tankok fényszórója, a tüzek, a torkolattüzek és a robbanások.

### Botok

A gép vezérelte, vörös tankok száma a szoba „Botok" csúszkájától és a pálya
méretétől függ. Egymásra nem céloznak és egymást nem sebzik; bármelyik
játékost megtámadják. Életük korlátlan: kilövés után máshol élednek újra.

- **Járőr:** az utakat követik, a jobb oldali sávban; az út végén és a
  játéktér határánál megfordulnak.
- **Támadás:** ha 75 m-en belül rálátnak egy játékosra (fal nem takarja),
  0,7 másodperc múlva tüzelni kezdenek, és lőtávolságon belülre mennek. A
  játékosnál lassabban lőnek, és nem céloznak tökéletesen.
- **Üldözés:** ha szem elől tévesztik, 9 másodpercig az utolsó ismert helye
  felé tartanak.
- **Akadályok:** tapogatókkal kerülik a falakat és a roncsokat. Ha mégsem
  haladnak, kitolatnak, körbenéznek, és a legszabadabb irányba indulnak; ha
  így sem szabadulnak, a játék új helyre teszi őket (csak ha 110 m-en belül
  nincs játékos).
- A felvehető tárgyakat ők is felveszik, a felvett fegyverük náluk is megmarad
  a kilövésükig.

### Felvehető tárgyak

A tárgyak a játéktér útjain vannak szétszórva (a számuk a „Felvehető tárgyak"
csúszkától és a pálya méretétől függ); a felvett tárgy helyett 12 másodperc
múlva új jelenik meg, máshol. A tank érintésre veszi fel őket.

| Tárgy | Hatás | Meddig tart |
|---|---|---|
| Nehéz lövedék | fegyver: nagyobb robbanás és lőtáv, dupla sebzés | a következő fegyverig vagy a kilövésig |
| Rakéta | fegyver: lassan indul, felgyorsul, kb. 200 m-re repül, területre sebez | a következő fegyverig vagy a kilövésig |
| Lézer | fegyver: azonnal célba érő sugár 130 m-ig | a következő fegyverig vagy a kilövésig |
| Pattanó lövedék | képesség: az alap- és a nehéz lövedék a falról kétszer visszapattan (a rakéta és a lézer nem) | a kilövésig |
| Hármas lövés | három lövedék (rakéta, lézersugár) legyezőben, bármelyik fegyverrel | 25 lövés (összeadódik, legfeljebb 75) |
| Gyorstöltő | 2,5-szer gyorsabb tüzelés | 15 mp |
| Olajfolt | 3 lerakható folt; aki ráhajt, 1,7 mp-ig irányíthatatlanul pörög és sodródik | 3 töltet, a folt 45 mp-ig marad |
| Javítókészlet | azonnal visszaad 50 életerőt | azonnali |
| Turbó | 45%-kal nagyobb végsebesség, jobb gyorsulás | 12 mp |
| Terepjáró lánctalp | terepen és sárban sem lassul a tank, olajon sem csúszik meg | 25 mp |
| Pajzs | egy töltet egy találatot nyel el (legfeljebb 3) | töltet |
| Sebezhetetlenség | semmi nem sebez, nem csúszik meg | 10 mp |
| Radar | a térképen látszanak a felvehető tárgyak | 30 mp |

Egyszerre egy fegyver lehet a tanknál: az újonnan felvett a régi helyére lép.

### Ami még nincs kész

- csapatos mód, időkorlátos meccs;
- visszatérés megszakadt kapcsolat után a folyamatban lévő meccsbe;
- ledönthető kerítések;
- érintőképernyős irányítás (a játék asztali gépre készül);
- e-mailes jelszó-visszaállítás, eredmények és ranglista a fiókokhoz.

## Megjelenítés

- A látómező mindig 160 × 90 méter, minden játékosnál ugyanannyi. A belső
  felbontás a kijelzőhöz igazodik (legfeljebb 12, legalább 8 pixel/méter;
  12-nél 1920 × 1080), az URL `?ppm=8` paraméterével kézzel csökkenthető.
- A térkép nem előre megrajzolt kép: a vektoros pályaadatot a `raster.ts`
  256 × 256 pixeles darabokban, futás közben rajzolja ki, mindig csak a
  kamera környékét. Ugyanez a rajzoló készíti a kis térképet és a
  pályakijelölő képét is.
- A pálya változásai (kidőlt fa, lövésnyom, összedőlt ház) bekerülnek a pálya
  állapotába, és csak az érintett darabok rajzolódnak újra a háttérben; a régi
  kép addig kint marad, így nincs villanás.
- **Élsimítás.** A térképdarabok kétszeres felbontásban készülnek, majd
  átlagolva kicsinyítődnek: a tetők, utak és lombok ferde élei nem lépcsősek.
  Ez a darab egyszeri kirajzolását terheli a háttérben, a képkockákat nem.
  Négynél kevesebb processzormagnál magától kikapcsol; az URL `?aa=0` /
  `?aa=1` paramétere felülbírálja.
- **A térkép részletei** (mind a darabokba rajzolva, tehát játék közben
  ingyen vannak): a falak tövében sötétebb sáv, gerincfény és sötétebb eresz a
  tetőkön, viseltes tetőfelület, tetőablakok és napelemek; az utakon szegélykő,
  keréknyomok, foltozások, aknafedelek, a főúton szélső vonal, a főútra
  kiérkező utcák végén stopvonal; a kertekben virágágyások, veteményesek,
  teraszok; tagoltabb lombkoronák, virágzó fák és bokrok.
- **Mozgó részletek:** a tankok a burkolatlan talajon lánctalpnyomot hagynak
  (kb. 45 másodpercig látszik, legfeljebb 900 nyomdarab), terepen port,
  esőben sarat vernek fel; a nagyobb robbanásokat lökéshullám, szétrepülő
  törmelék és gomolygó füst kíséri.

### Teljesítmény

A cél: gyengébb asztali gépen is egyenletes kép.

- **Háttérszálak.** A térképdarabokat legfeljebb három Web Worker rajzolja; a
  fő szál csak a kész pixeleket tölti textúrába, képkockánként korlátozott
  időkerettel. Élsimítással egy darab kb. 40–80 ms alatt készül el (nélküle
  kb. 12 ms); a pálya a meccs indulásakor 1–2,5 másodperc alatt áll össze.
- **Takarékos rajzoló és térbeli indexek.** A tetők alatti talaj nem
  számolódik ki; a fák, bokrok, oszlopok, épületek és utak rácsba rendezve
  kereshetők.
- **Kevés textúra és rajzolási hívás.** A látómezőn kívüli elemeknek nincs
  megjelenítőjük; az effektek sprite-jai újrahasznosulnak.
- **Este** a sötétség fél felbontású rétegre készül, a fények ebből
  „radírozódnak ki".
- **A felület csak változáskor ír a DOM-ba.**

Mérés (Intel Iris Xe, 8 szálas processzor, 1920 × 1080; 10 másodperc vezetés
és folyamatos lövés közben): a jelenet frissítése képkockánként átlagosan
0,6–1,3 ms (60 FPS-hez 16,7 ms fér bele), a képkockák 95%-a 3 ms alatt van,
8 ms fölötti képkocka nem volt – nappal, esőben és este, botokkal is.

## Felépítés

```
server/                   a játékszerver (lásd multiplayer.md)
src/
  main.ts                 belépési pont: pálya, menü, a meccs indítása
  game/
    sim/                  JÁTÉKLOGIKA – nincs Phaser- vagy DOM-függés; a szerver és a kliens közösen használja
      collision.ts        szakaszrács: kör–fal ütközés, sugárvetés; a falaknak gazdája lehet (épület)
      props.ts            kidönthető tereptárgyak (fák, oszlopok) állapota
      structures.ts       ledönthető épületek életereje
      world.ts            tankok, lövedékek, sebzés, szintek, gyorsító, sár, roncsok, tárgyak; rögzített lépésközű step()
      pickups.ts          a felvehető tárgyak típusai és szabályai
      bots.ts             a gép vezérelte tankok viselkedése
      match.ts            a meccs szabályai: létszámok a pálya méretéből, életek, kiesés, győztes
    net/                  HÁLÓZAT: protokoll, kapcsolat, a szerverállapot tükre előrejelzéssel
    maps/                 PÁLYA
      types.ts            a pályafájl szerkezete
      GameMap.ts          betöltés, ütközési rács, játéktér, út-keresés, a pálya változó állapota
      rasterCore.ts       a rajzoló alapjai: színek, zaj, sokszög- és vonalrajzolás
      raster.ts           térképrajzoló (vektor → pixel): talaj- és lombréteg, romok, sár
      landmarkRaster.ts   a hivatal és környezete a fotók alapján felvett adatokból
      roadLabels.ts       az útra írt utcanevek helyének kiszámítása
      chunkRender.ts      egy térképdarab kirajzolása élsimítással
      ChunkLayer.ts       a rajzolt rétegek darabonkénti, igény szerinti előállítása
      chunkWorker.ts      a térképdarabok kirajzolása háttérszálon
      RoadLabelLayer.ts   az útra írt utcanevek, csak a kamera közelében
    entities/             MEGJELENÍTÉS: tankok, tárgyikonok, tüzek, időjárás, lánctalpnyomok, kódból rajzolt sprite-ok
    scenes/GameScene.ts   bemenet → szerver; szerverállapot → megjelenítés
    settings.ts           a játékos beállításai (név, belépés, billentyűk), a böngészőben megőrizve
    systems/audio.ts      szintetizált hangok (Web Audio)
    ui/Menu.ts            menük: belépés, beállítások, játékok listája, új játék, váró, eredmény
    ui/Hud.ts             játék közbeni felület: térkép, információs panel, értesítések
    quality.ts            a részletesség (pixel/méter) megválasztása
assets/maps/osm/          nyers OSM-adat + lekérdezés, kiegészítő épületalaprajzok
assets/maps/landmarks/    fotók alapján kézzel felvett részletek
assets/maps/processed/    feldolgozott pályafájl
data/                     a szerver adatai: fiókok (nincs verziókezelés alatt)
pictures/                 fotók mintának (nincs verziókezelés alatt)
scripts/                  letöltő és feldolgozó scriptek, böngészős próba (e2e.mjs)
inditas.bat               a játék indítása ezen a gépen
szerver.bat               nyilvános szerver indítása alagúttal
commit.bat                mentés és feltöltés a GitHubra
tests/                    Vitest tesztek
```

A három terület – **térképi adat**, **játéklogika**, **megjelenítés** – külön
modulokban van:

- A térképi adat egyetlen JSON-fájl; új pálya másik kivágásból ugyanazzal a
  két scripttel készíthető.
- A játéklogika (`sim/`) méterben és másodpercben számol, a megjelenítésről
  és a hálózatról semmit nem tud; determinisztikus, rögzített lépésközű.
- A megjelenítés csak olvassa az állapotot, és eseményekből készíti a
  hangokat, effekteket.

### Pályarétegek

A rajzolási sorrend egyben a rétegrend:

1. alap talaj és területhasználat (fű, kert, szántó, erdőtalaj, park, víz…);
2. patakok;
3. gyalogutak, kerékpárutak, földutak;
4. járdák, padka, úttest, felezővonal, zebrák;
5. kerítések;
6. bokrok, az összedőlt épületek romjai;
7. vetett árnyékok (épületek, fák, oszlopok);
8. fatörzsek, villanyoszlopok, a kidőlt fák és oszlopok;
9. épületek (tetők, kémények), majd a lövésnyomok;
10. az útra írt utcanevek;
11. lánctalpnyomok, olajfoltok, roncsok, majd a **mozgó elemek:** tankok, lövedékek, rakétafüst, lézersugár;
12. **lombréteg:** az álló fák koronája, vezetékek, zászlók – a tank fölött, kissé áttetszően;
13. tüzek és füstjük, felvehető tárgyak, a tankok életerősávja, robbanások;
14. időjárás: az eső, illetve az esti sötétség a fényekkel.

Az ütközési geometria ettől független réteg (`GameMap.walls`), ugyanabból az
adatból készül.
