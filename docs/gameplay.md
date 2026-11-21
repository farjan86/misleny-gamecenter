# Játékmenet és architektúra

A többjátékos mód, a szerver és a fiókok leírása külön fájlban van:
[multiplayer.md](multiplayer.md). Ez a fájl a játék szabályait, a
megjelenítést és a kód felépítését írja le.

## A játék

Kozármisleny térképének egy kijelölt részén, tankkal, mindenki mindenki ellen.
Egy meccsben 1–20 játékos (nyitott játékban 2–100) és (beállítástól függően) gép vezérelte botok vannak.
A meccs **időre megy** (5–30 perc): a kilőtt tank néhány másodperc múlva
újraéled, és **az nyer, aki az idő lejártáig a legtöbb tankot lövi ki**. Az
utcákon – ha a létrehozó nem kapcsolja ki – civil forgalom is van.

Ez az egyetlen játékmód („deathmatch"); a mód a meccs beállításainak része
(`mode`), hogy később más módok (csapatos, várvédő, küldetés) is
bekerülhessenek.

### Játéktempó

Új játék létrehozásakor (és egyjátékos módban) a **Játéktempó** csúszka egy
mozdulattal beállítja az egész meccset a játékosszámhoz. Alapérték: **Pörgős**.

| Tempó | Pálya játékosonként | Legkisebb pálya | Botok (2 / 20 játékosnál) | Bot ügyesség, agresszivitás, szívósság | Tárgyak, forgalom |
|---|---|---|---|---|---|
| Egyéni | – minden kézzel állítható | – | – | – | – |
| Lopakodó vadászat | kb. 0,08 km² | 0,3 km² | 3 / 1 | közepes, óvatos, szívós | kevés, kevés |
| Taktikus | kb. 0,06 km² | 0,22 km² | 4 / 1 | ügyes, közepes, szívós | közepes, kevés |
| Kiegyensúlyozott | kb. 0,045 km² | 0,16 km² | 6 / 1 | közepes, közepes, közepes | közepes, kevés |
| **Pörgős** | kb. 0,032 km² | 0,11 km² | 9 / 2 | ügyes, harcias, közepes | sok, nagyon kevés |
| Aréna | kb. 0,022 km² | 0,07 km² | 11 / 4 | nagyon ügyes, vadászik rád, gyenge | nagyon sok, nincs |

- A pálya legfeljebb 1 km², és kevés játékosnál sem kisebb a tempó legkisebb
  pályájánál (a pörgős legalább kb. 380 × 290 m) – ne legyen szűk. A botok
  száma a játékosszámmal csökken: kevés játékosnál a botok adják az akciót,
  sokaknál már a játékosok.
- **A pályát a gép jelöli ki** véletlen helyen, de mindig játszható helyen: a
  kijelölt cellák legalább 60%-ában utca van, legfeljebb 15%-uk víz, és az
  utak, épületek szerint a legjobb néhány hely közül választ. A **„Másik
  helyszín”** gomb ugyanakkora pályát máshová sorsol.
- Tempó állásban a pálya, a botok, a tárgyak és a forgalom **zárolva van** (az
  értékük látszik); szabadon állítható a név, a belépőkód, a létszám, a
  játékidő és az időjárás. Kézi beállításhoz az **Egyéni** állás kell: ilyenkor
  a csúszkák az addigi tempó értékeiről indulnak. (Egyéni állásban a botok
  száma a régi módon, a pálya méretéhez arányosan számolódik – egészen kicsi
  pályán így kevesebb lehet, mint az Aréna tempóban.)
- A szerver is a tempó táblázatából számol: ha a játékok listájában „Pörgős”
  áll, az valóban a pörgős beállítás.
- **Nyitott játéknál** a pálya és a botszám a **várható létszámhoz** igazodik
  (külön csúszka, alapból 10 fő), nem a 100 fős felső korláthoz.

### Menük

- **Főképernyő:** belépés vagy regisztráció (játékosnév + jelszó), utána
  *Multiplayer*, *Egyjátékos*, *Beállítások*, *Kijelentkezés*.
- **Egyjátékos:** gyakorlás a botok ellen, szerver nélkül – a meccs a
  böngészőben fut. Belépés nélkül is elérhető, akkor is, ha a szerver éppen nem
  érhető el. Ugyanazokkal a csúszkákkal állítható be, mint egy többjátékos
  játék (játéktér, játékidő, botok száma, ügyessége és agresszivitása, tárgyak,
  forgalom, időjárás), és azonnal indul. Az idő lejártáig tart; az eredmény a
  kilövéseid száma.
- **Beállítások:** a hangerő (0–100%, alapérték 80; a csúszka elengedésekor
  próbahang szól) és a billentyűkiosztás. Műveletenként két billentyű adható
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
| Q | ágyú telepítése a tank mögé (ha van töltet) |
| R | akna lerakása a tank mögé (ha van töltet) |
| C | füst a tank köré (ha van töltet) |
| X | tüzérségi csapás (ha jár): feljön a nagy térkép, azon kell kattintani a célpontra; utána a térkép magától bezárul |
| Bal Ctrl / V | álcázás (percenként egyszer, 10 másodpercre) |
| T vagy Enter | üzenet írása mindenkinek (többjátékos meccsen) – a mező a képernyő közepén nyílik, az üzenetek a jobb szélen jelennek meg |
| B | beszéd, amíg nyomva van (többjátékos meccsen) |
| Tab | eredménytábla, amíg nyomva van |
| M | nagy térkép ki/be – **rögzített billentyű**, nem állítható át (a térkép keretében is ki van írva); a nagy térképre kattintva **GPS-cél** |
| G | a GPS kikapcsolása (a nagy térképen jobb klikk is) |
| F | teljes képernyős mód be/ki (a játék bal alsó sarkában halványan ki is van írva; teljes képernyőn eltűnik) |
| H | információs panel be/ki |
| Esc | menü (billentyűk, kilépés) |

Irányítási modell: klasszikus tankirányítás – az A/D a tank testét forgatja,
a W/S a test saját iránya szerint visz előre vagy hátra, a torony ettől
függetlenül, az egérrel céloz. A forgás fokozatosan gyorsul fel: egy rövid
billentyűnyomás csak egy-két fokot fordít (finom iránytartás íves utcán), a
nyomva tartás erős fordulást ad. Teljes sebességnél a tank lassabban fordul,
mint állva.

### Ami a képernyőn látszik

Játék közben állandóan a **térkép** (jobb felül), a **menü gombja**
(bal felül, ☰ Menü), mellette a **tank sávja**, felül középen pedig a
**visszaszámláló óra** látszik.

- **Az óra** a hátralévő játékidőt mutatja (perc:másodperc), alatta a
  kilövéseid száma és – többjátékos meccsben – a helyezésed. Az utolsó fél
  percben pirosan villog.
- **Játékmenet a főképernyőn:** a főképernyő alján (belépés előtt és után is)
  hat lépésben ott áll, hogyan működik a játék: belépés és mire való a jelszó,
  csatlakozás egy játékhoz, saját játék létrehozása, a belépőkód (privát
  játék), a váró és az indulás, és maga a meccs. Összecsukható; a böngésző
  megjegyzi, hogy nyitva hagytad-e.
- **Választható alaptank:** a főmenü *Tankom* gombja alatt hat tank közül
  lehet választani. Három modern: *Harckocsi* (lánctalpas), *Vadász* (kerekes
  páncélvadász: lapos ék-test, nagyon hosszú cső) és *Cirkáló* (légpárnás:
  csepp alakú test, ventilátorok, kerek kupola). Három klasszikus, II.
  világháborús, korhű festéssel: *T-34* (szovjet védőzöld; T-34/76 → T-34-85 →
  T-34-100), *Tigris* (sötétsárga alapon olívzöld–vörösbarna terepminta; Tiger I
  → Királytigris) és *Sherman* (olívbarna, fehér csillaggal; M4 → „Easy Eight”
  → „Jumbo” → Firefly). A modern tankokat a játék a csapat színére festi
  (saját zöld, bot vörös, másik játékos kék); a klasszikusak megtartják a
  festésüket, náluk a motortéren és a torony tetején lévő **légi azonosító lap**
  mutatja a csapat színét. **Csak a megjelenés más**, a játékszabályokra nincs
  hatása. A szintekkel mindegyik a saját formavilágában fejlődik (hat fokozat,
  saját nevekkel), a képernyő meg is mutatja a teljes fejlődési sort. A többiek
  is azt a tankot látják, amit választottál; a botok vegyesen kapnak a hatból.
- **Teljes képernyő:** a meccs elején 3 másodpercig villog a felhívás, hogy
  teljes képernyőn (F) érdemes játszani – rá is lehet kattintani –, utána
  eltűnik; a bal alsó sarokban halványan ott marad az emlékeztető.
- **A felületre kattintás nem lő:** a menüre, a menüpontokra, a térképre
  kattintva a tank nem tüzel; egérrel csak a játéktéren lehet lőni.
- **Útmutató a főmenüben:** az *Útmutató* gomb alatt minden felvehető tárgy
  ott van az ikonjával – mit csinál, meddig tart, mivel lehet használni
  (a nálad beállított billentyűvel) –, mellette a fegyverek és robbanások
  sebzése, a tüzelési idők, és egy táblázat arról, mi meddig tart. A számok a
  játék szabályaiból jönnek, ezért mindig egyeznek azzal, ami a pályán történik.
- **Ki lőtt ki:** ha kilőnek, a képernyő közepe alatt az újraéledésig ott
  áll, **ki és mivel** végzett veled – pl. „Béla lőtt ki – aknával.”, „Egy bot
  lőtt ki – rakétával.”, „Felrobbant melletted egy gázpalack.” –, alatta a
  szintvesztés és a visszaszámlálás. A fegyver lehet ágyú, nehéz lövedék,
  rakéta, lézer, géppuska, telepített löveg, akna, tüzérségi csapás,
  felrobbantott gázpalack vagy jármű. A jobb oldali kilövési értesítő
  mindenkinek mutatja, mivel történt a kilövés, és a kilövő is megtudja, ha az
  aknája, a lövege vagy a tüzérsége talált.
- **Meccs végi statisztika:** a végeredmény táblázata játékosonként mutatja a
  kilövéseket (csak a kilőtt ellenséges játékosok), a **kilőtt botokat** (külön
  oszlopban, csak statisztika), a halálokat, az arányukat, az okozott és a kapott sebzést, a
  találatokat és a leadott lövéseket, a pontosságot, a leghosszabb sorozatot,
  a ledöntött házakat, a szintet és a **teljesítménypontot**. A pont: kilövés
  100, halál −50, sebzés pontonként 0,3, sorozat 20, pontosság %-onként 1
  (legalább 10 lövésnél), ledöntött ház 10 (legfeljebb 100), szint 15. Több
  játékosnál a legtöbb pontot gyűjtő a **meccs legjobbja** (★) – ez nem
  feltétlenül a győztes, mert a helyezés a kilövések száma szerint dől el.
- **A végeredményben** játékosonként a legjobb kilövéssorozat, a ledöntött
  házak száma és a lövések pontossága is szerepel; több játékosnál különdíj
  jár a leghosszabb sorozatért, a legtöbb ledöntött házért és a legpontosabb
  lövésért.
- **Az eredménytábla** a Tab nyomva tartására jelenik meg (vagy az órára
  kattintva, akkor kint marad, amíg rá nem kattintasz): minden játékos
  helyezése, kilövései, halálai és szintje, a végeredmény sorrendjében.
- **A pálya a kijelölt játéktérre van vágva:** a kamera a játéktér szélén
  megáll (a határt sárga vonal jelzi), azon túl semmi nem látszik – a térképen sem.
- **A tank sávja** a bal szélen, egymás alatt (így nem lóg bele az órába):
  felül a tank szintje, alatta az álcázás állapota, majd ami éppen nála van – a
  fegyver (nehéz lövedék, rakéta, lézer), a hármas lövés hátralévő lövései, a pajzs, az olaj, a lövegek, az
  aknák, a füst, valamint az időre szóló tárgyak a hátralévő másodpercekkel.
  Amit billentyűvel lehet használni, annál a **beállított billentyű** is ott
  áll zárójelben, pl. „Löveg (Q) ×5”, „Akna (R) ×2”.
- A térkép a tank kb. 700 m-es környékét mutatja (kis játéktérnél az egészet, kitöltve); az M az egész játékteret mutatja nagyban, a képernyőhöz illő felbontásban (kis játéktéren sem kockás; a képe a játék elején a háttérben készül el, így azonnal nyílik). A térképen **csak a botok** látszanak (piros pont); az ellenséges
  játékosok nem – őket a saját szemeddel kell megtalálnod.
- A saját tank zöld, a botok vörösek, a többi játékos tankja kék.
- A tankok fölött az életerősáv; a sajátod fölött – használat közben – a
  gyorsító hőfoka is.
- Az **információs panel** (H, vagy a menü *Billentyűk és információ* pontja): az irányítás az aktuális
  billentyűkkel, a tankod állapota (életerő, szint, kilövések és halálok, fegyver, aktív
  tárgyak), a játékosok állása, a forrásmegjelölés és a *Kilépés a meccsből* gomb.
- A fontos események rövid értesítésként jelennek meg felül (felvett tárgy,
  kilövés, szintlépés).
- **Kilövési értesítő** a térkép alatt: ki kit lőtt ki (a saját neved sárga,
  a botok halványak). Néhány másodperc után elhalványul.
- **Bosszú:** aki kilőtt, az az újraéledésed után 25 másodpercig jelölve van:
  piros nyíl mutat rá (ha nincs a képen, a kép széléről felé); ha bot volt, a
  térképen villogó keret is jelzi (játékos a térképen nem látszik). Ha közben kilövöd, „Bosszú!” üzenetet kapsz; ha más
  lövi ki, vagy füstbe bújik, a jel eltűnik. Pont nem jár érte külön.
- **Sebzésszámok:** a találat helyén felröppen a sebzés (piros: téged ért,
  sárga: te okoztad, fehér: másoké).
- **Honnan lőnek:** ha találat ér, a tankod körül piros ív mutatja egy
  másodpercig, melyik irányból jött.
- A tájékozódási pontok (hivatal, templom, rendőrség…) felirata a pályán marad.
- **A többi játékos neve** a tankja fölött látszik, kis, halvány felirattal
  (a saját tankod és a botok fölött nincs név). Füstben a név sem látszik.
- **Menü** a bal felső sarokban (☰ Menü, vagy az **Esc**): lenyitva két pont
  van benne – *Billentyűk és információ* (az irányítás az éppen beállított
  billentyűkkel, a tankod állapota, a játékosok) és *Kilépés a játékból*
  (megerősítést kér). A kilépés egyjátékos és többjátékos meccsből is
  kiléptet: egyjátékosból a főképernyőre, többjátékosból a játékok listájához.
- **Verziószám** a bal alsó sarokban (a menüben és játék közben is), pl. „v1.0”.
  Ebből látszik, hogy a böngésző a legfrissebb játékot tölti-e be. Játék közben
  mellette áll a **képkockaszám** és a szerver **válaszideje** („v1.4 · 60 fps ·
  35 ms”); ha a gép lassú (45 fps alatt) vagy a hálózat (150 ms fölött), a
  kijelzés narancsra vált. Ha valakinél akad a játék, ebből látszik, melyik a ludas.

### Szabályok

- **Mozgás:** burkolt úton teljes sebesség (előre 17 m/s, tolatva 9 m/s),
  terepen 72%. A zöldterületeken szabadon lehet menni.
- **Gyorsító (Shift):** amíg nyomva van, a tank 30%-kal gyorsabb. Összesen
  3 másodpercig bírja: ekkor túlmelegszik, és nem használható, amíg teljesen
  le nem hűl (kb. 6 másodperc). Ha előbb elengeded, a hő fokozatosan csökken.
- **Akadályok:** az épületek, vízfelületek, kerítések, parkoló autók, a
  közlekedő járművek, a telepített ágyúk és a roncsok nem járhatók át. A fák és a villanyoszlopok nem akadályok: a tank
  kidönti őket. A bokrokon és a patakokon át lehet hajtani.
- **A játéktér határa** fal: a tank nem megy át rajta, a lövedék ott becsapódik.
- **Sebzés:** a tank életereje 200 (szintenként 24-gyel több, a 20. szinten
  656), vagyis a kezdő tank nyolc sima lövedéket bír ki. Egy sima lövedék 25-öt
  sebez, a nehéz 50-et, a rakéta 55-öt (a robbanása 7 m-en belül további
  30-at), a lézer 24-et.
- **Rombolás fegyverenként:** az épületekben okozott kár a sebzés többszöröse –
  ágyú 1×, lézer 1,4×, nehéz lövedék 2,4×, rakéta 3× (egy kis házat egy rakéta
  is ledönt), és a rakéta robbanása a 6 m-en belüli szomszéd házakat is rombolja.
  A becsapódás nyoma is a fegyverrel nő: az ágyúé kis folt, a nehéz lövedéké
  2,6 m-es, a rakétáé 3,8 m-es mély kráter (sötét mélyedés, árnyékos fal, körülötte
  kidobott föld).
- **Kilövés:** a kilőtt tank 4 másodperc múlva éled újra – véletlen helyen, a
  többi játékostól távol –, **3 másodperces teljes védelemmel** (semmi nem sebzi), alapfegyverrel,
  akárhányszor. A roncsa ott marad, ahol kilőtték (akadály; egy ideig ég).
- **Győzelem:** az idő lejártakor az nyer, akinek a legtöbb kilövése van.
  **Kilövésnek csak az ellenséges játékos kilövése számít** (az is, amit a
  telepített ágyúja vagy egy általa felrobbantott jármű ért el); a kilőtt botok
  száma csak statisztika (a meccs végi táblában és az információs panelen), a
  helyezésbe és a pontba nem számít. Egyedül játszva az eredmény a kilőtt botok száma. Azonos kilövésszámnál az nyer, akit
  kevesebbszer lőttek ki; ha ez is egyezik, döntetlen. Ha egy többjátékos
  meccsből mindenki más kilép, a bent maradó nyer.
- **Önjavítás:** ha a tankot 8 másodpercig nem éri sebzés, az életereje
  nagyon lassan visszatöltődik: másodpercenként a legnagyobb életerő 1%-a
  (az 1. szinten 2 életerő; a nulláról 100 másodperc lenne a teljes feltöltés).
  Az újabb találat újraindítja a várakozást; a pajzs által felfogott találat
  nem. Harc közben nem számít, a javítókészletet nem pótolja. A botok tankja
  is így gyógyul.
- **Szintek:** a tank a kilövésekkel fejlődik, legfeljebb a 20. szintig:
  szintenként 4%-kal nagyobb, 24-gyel több a legnagyobb életereje, és 8%-kal
  többet sebez. A botok nem lépnek szintet.
  - **Játékos kilövése:** egy szint. Ha a kilőtt játékos **jóval magasabb
    szintű** volt – legalább három szinttel –, a győztes **két szintet** lép.
    Nagyjából egyszintű tankok párharcában tehát a győztes egyet nyer, a
    vesztes egyet veszít.
  - **Botok kilövése:** három bot ér egy szintet. A tank sávja mutatja, hol
    tartasz („bot 2/3”); a számláló a halállal nem vész el.
  - **Halál:** a kilőtt tank **egy szintet veszít** (az 1. szint alá nem megy),
    és az új szintjéhez járó teljes életerővel éled újra. A felszerelése is
    elvész: a felvett fegyver, a pajzs, az olaj, az akna, a füst, a
    telepíthető ágyú töltetei és az időre szóló hatások.
  Így a vezető előnye nem nő a végtelenségig, és aki lemaradt, egy jó
  kilövéssel sokat behozhat.
- **Tanktípusok:** a szintek hat osztályba tartoznak, és osztályváltáskor a
  tank más típus lesz – más a teste és a tornya, és a mérete is ugrik (további
  7%-kal). A váltást aranyszínű fénygyűrű és hang jelzi; a tank sávja és az
  információs panel a típus nevét is mutatja. A roncs akkora és olyan, amilyen
  a kilőtt tank volt.
- **A szint látszik a tankon:** az életerősáv elején csillag és a szint száma
  áll (a 2. szinttől, minden játékos tankján). A típuson belüli szintlépéseket
  fehér gyűrűk jelzik a csövön (a titánnál arany csillagok a tornyon). A
  nagyobb tank lövedéke és torkolattüze is nagyobb; a nehéz tanktól fölfelé a
  kipufogó füstöl, az ostromtank és a romboló alatt parázsló, a titán alatt
  kék fény lüktet, és a titán lövedéke kéken izzik.
- **A sérülés látszik a tankon** (minden tankon, a megmaradt életerő aránya
  szerint): 75% alatt karcok és belövések; 50% alatt korom, repedések, szürke
  füst; 25% alatt megfeketedett, kiszakadt, belül izzó páncél, láng a testén
  és sűrű fekete füst. A javítókészlet a sérüléseket is eltünteti. Ha a saját
  tank életereje 25% alá esik, három rövid figyelmeztető hang szól.
- **Hangok:** minden hang kódból készül. A lövés hangja a fegyvertől és a
  tank méretétől függ (a nagyobb ágyú mélyebben szól), a motoré is. Külön
  hangja van a becsapódásnak, a kilőtt tanknak, az összedőlő épületnek, a
  felrobbanó járműnek, a találatnak (ha téged ér, illetve ha te találsz), a
  kilövésnek, az újraéledésnek, a szintlépésnek, a gyorsítónak, a tárgyak
  felvételének (fajtánként más) és az órának (figyelmeztetés 60 és 30
  másodpercnél, kattogás az utolsó tízben, kürt a végén). Esőben az eső zúg.
  - **Lövés:** az ágyú hangja több rétegből áll – a torkolat éles csattanása,
    a dörrenés teste, mély döngés, a hátrasikló cső fémes koppanása, és a
    tájról visszaverődő, elnyúló visszhang. Távoli lövésnél a csattanás elvész,
    a tompa dörgés marad. A nehéz lövedék után a talaj is morajlik, a löveg
    csöve megcsendül, a rakéta begyújt és felsüvít.
  - **Kidőlő fa:** a törzs elreccsen, recsegve megdől, a lomb suhog, majd a fa
    puffanva földet ér (a nagyobb fa lassabban és mélyebben). Az oszlop csak reccsen.
  - **Háznak ütközés:** az első ütésnél a fal megdöndül, tégla reped, ablak
    csörren, pereg a vakolat; amíg a tank a falnak feszül, a fal csikorog és
    hullik a törmelék.

  | Szint | Típus | Miről ismerhető fel |
  |---|---|---|
  | 1–2 | Felderítő | kis, hegyes orrú test |
  | 3–5 | Közepes harckocsi | sárvédők, lökhárító, málhaládák, géppuska a tornyon |
  | 6–8 | Nehéz harckocsi | széles lánctalp, acél törőék az orrán (innen rombol az ütközése) |
  | 9–11 | Ostromtank | láncvédő kötény, reaktív páncél, tüskés ék, izzó motor |
  | 12–15 | Romboló | négy külön futómű, tolólap, ikerlöveg, rakétavetők (érintésre dönt házat) |
  | 16–20 | Titán | sötét páncél arany szegéllyel, energiaágyú, lüktető fény a tank alatt |

  A 20. szintű tank a kezdő méretének kb. 2,1-szerese. A típus csak a
  kinézetet és a méretet adja; az erőt (életerő, sebzés, rombolás) a szint.

### A pálya rombolása

- **Fák, oszlopok:** kidőlnek, ha a tank nekimegy vagy lövés éri őket (a
  rakéta robbanása a közelieket is kidönti), és úgy maradnak.
- **Épületek:** minden épületnek életereje van az alapterülete szerint
  (60 + 0,9 × m², legalább 80, legfeljebb 600). A találatok fogyasztják
  (ugyanannyit, amennyit egy tankon sebeznének, a lövő szintjével növelve);
  ha elfogy, **az épület összedől**: rom marad a helyén, amelyen át lehet
  hajtani. Egy 100 m²-es ház 6 sima vagy 3 nehéz lövedéket, illetve 3 rakétát bír.
- **A tank az ütközésével is rombol:** minden szintű tank sebzi az épületet,
  amíg nekifeszül (gázt ad a fal felé): az 1. szinten másodpercenként 14
  életerőt, szintenként 30%-kal többet (a 6. szinten 52-t, a 11.-en 193-at).
  Egy 100 m²-es házat az 1. szintű tank kb. 11 másodperc alatt dönt le.
- **Áthajtás:** az elég nagy tank a kisebb (vagy már megrongált) épületen
  megállás nélkül áthajt – az épület az érintésre összedől, a tank csak kicsit
  lassul. A határ az épület pillanatnyi életereje: a 3. szinten 80 (kis
  fészer), szintenként 15-tel több; a 6. szinttől (nehéz harckocsi) 170 – ez
  már egy kisebb családi ház –, szintenként 45-tel több; a 12. szinttől
  minden épület érintésre összedől. Egy nagy épületet tehát érdemes előbb
  megbontani néhány lövéssel. A botok az ütközésükkel nem rombolnak.
- **Sérülésjelző:** a megsérült épület fölött rövid időre megjelenik az
  életerősávja (lövésnél és nekifeszülésnél is); a falnál por száll, recseg.
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

A gép vezérelte, vörös tankok száma a „Botok" csúszkától és a pálya
méretétől függ. Három további csúszka szabja meg, milyenek:

| Szint | Ügyesség: célzási hiba, reakcióidő, tűzgyorsaság | Agresszivitás: látótáv, üldözés, tartott távolság |
|---|---|---|
| 1 | kezdő: ±10°, 1,4 mp, 1,9 mp-enként lő | békés: 45 m-ről vesz észre, 4 mp-ig üldöz, 30 m-re megáll |
| 2 | gyenge: ±6°, 1,0 mp, 1,5 mp | óvatos: 60 m, 6 mp, 26 m |
| 3 | közepes: ±4°, 0,7 mp, 1,2 mp | közepes: 75 m, 9 mp, 22 m |
| 4 | ügyes: ±2°, 0,45 mp, 0,95 mp | harcias: 90 m, 13 mp, 18 m; 260 m-en belül akkor is feléd tart, ha nem lát |
| 5 | **nagyon ügyes**: ±1°, 0,25 mp, 0,75 mp – tárgyat vesz fel, fejlődik | vadászik rád: 110 m, 20 mp, 14 m; a pálya bármely pontjáról feléd tart |
| 6 | **ultra ügyes**: ±0,5°, 0,15 mp, 0,6 mp – tárgyat vesz fel, fejlődik | – |

- **Szívósság (1–5):** minél szívósabb a bot, annál erősebb a páncélja és
  annál nagyobbat lő. Egy ágyúlövése a játékos tankján, illetve hogy hány
  ágyútalálatot bír ki (a játékos 1. szintű tankja nyolcat):

  | Szint | Lövése | Kibír |
  |---|---|---|
  | 1 – törékeny | 10 | 4 találatot |
  | 2 – gyenge | 12,5 | 5 |
  | 3 – közepes (alapérték) | 15 | 5 |
  | 4 – szívós | 20 | 7 |
  | 5 – páncélos | 25 | 8 – egyenrangú a játékossal |

- **Tárgyak és fejlődés:** a botok alapesetben **nem vesznek fel tárgyat**
  (áthajtanak rajta, és az ott marad a játékosoknak), és **nem lépnek
  szintet** – mindig 1. szintű felderítők. A **nagyon ügyes** és az **ultra
  ügyes** bot viszont felveszi a tárgyakat (ha nincs ellenfél a látóterében,
  70 m-en belül el is megy értük), és a kilövésekkel ugyanúgy szintet lép,
  mint a játékos (kilövéskor szintet is veszít).

Az alábbi leírás a közepes szintre vonatkozik. Egymásra nem céloznak és egymást nem sebzik; bármelyik
játékost megtámadják. Életük korlátlan: kilövés után máshol élednek újra.

- **Járőr:** az utakat követik, a jobb oldali sávban; az út végén és a
  játéktér határánál megfordulnak.
- **Támadás:** ha 75 m-en belül rálátnak egy játékosra (fal nem takarja),
  0,7 másodperc múlva tüzelni kezdenek, és lőtávolságon belülre mennek. A
  játékosnál lassabban lőnek, és nem céloznak tökéletesen. **A képernyőn
  kívülről nem lőnek:** csak akkor tüzelnek, ha ők maguk is a játékos
  képernyőjén vannak (a legkisebb látómező 160 × 90 m, a széle előtt pár méter
  ráhagyással) – messzebbről csak közelednek.
- **Üldözés:** ha szem elől tévesztik, 9 másodpercig az utolsó ismert helye
  felé tartanak.
- **Akadályok:** tapogatókkal kerülik a falakat és a roncsokat. Ha mégsem
  haladnak, kitolatnak, körbenéznek, és a legszabadabb irányba indulnak; ha
  így sem szabadulnak, a játék új helyre teszi őket (csak ha 110 m-en belül
  nincs játékos).
- A felvehető tárgyakat ők is felveszik, a felvett fegyverük náluk is megmarad
  a kilövésükig.

### Forgalom

Az utcákon civil járművek közlekednek: többnyire **személyautók** (hat forma –
limuzin, ferdehátú, kombi, terepjáró, furgon, platós – tíz színben), néhány
**busz** (csak a főutakon marad, ha teheti) és ritkán egy **ellátó
teherautó**. A számukat a „Forgalom" csúszka (0–5) és a pálya mérete adja
(szintenként és km²-enként 4 jármű, legfeljebb 60); a 0 kikapcsolja.

- **Közlekedés:** a jobb oldali sávban haladnak, a játéktér szélén érkeznek és
  távoznak. A főútra kihajtás előtt megállnak a stopvonalnál, kanyarban
  lassítanak, esőben lassabban mennek, este világítanak.
- **A tank előtt megállnak.** Ha sokáig nem jutnak tovább, dudálnak, aztán
  megfordulnak. A roncsot ugyanígy kerülik.
- **Ijedtség:** közeli lövésre, robbanásra fékeznek, megfordulnak vagy
  gyorsítva elhajtanak.
- **Akadályok:** az alacsony szintű tank nem tud átmenni rajtuk. A 6. szinttől
  a tank az ütközésével rombolja, a 12.-től érintésre **összelapítja** őket –
  az összelapított jármű nem robban fel, és át lehet hajtani rajta.
- **Kilőhetők:** egy személyautó egy találattól kigyullad, a teherautó
  kettőtől, a busz háromtól (a nehéz lövedék és a rakéta többet ér). Az égő
  jármű megáll, és 2–3 másodperc múlva **felrobban** (újabb találatra
  azonnal): 7–10 m-es körben sebez (közvetlen közelben 35–55 életerőt, a
  szélén ennek a 40%-át), felgyújtja a szomszédos járműveket, kidönti a fákat.
  A robbanás azt is sebzi, aki a járművet kilőtte; az így kilőtt tank a
  lövésznek számít. A kiégett roncs 40 másodpercig elzárja az utat.
- **Ellátó teherautó:** sárga-fekete csíkos ponyvájáról és a körülötte lüktető
  sárga gyűrűről ismerhető fel. Ha kilövik vagy összelapítják, **két tárgy
  esik ki belőle** (fegyver, pattanó lövedék, hármas lövés, pajzs,
  sebezhetetlenség vagy telepíthető ágyú).
- A járművek kilövéséért nem jár szint.

### Lövegek (telepíthető tüzérség)

Minden tank **öt löveggel** indul, és újraéledéskor újra megkapja az ötöt; a
*Löveg* tárgy egy továbbit ad (egyszerre legfeljebb nyolc lehet a tanknál). A
**Q** a tank mögé rakja le. A botok nem kapnak és nem telepítenek löveget.

- A löveg a lerakójáé: **magától lő minden ellenséges tankra** (a többi
  játékosra és a botokra), amelyre rálát – falon át nem. A találatai és a
  kilövései a lerakójának számítanak.
- **A löveg a gazdája szintjét követi**, akkor is, ha a gazda később lép szintet
  (vagy veszít): a csöve a tank típusáé, és a tankkal együtt nő.

  | A gazda szintje | Életerő | Lőtáv | Két lövés között | Egy lövés sebzése |
  |---|---|---|---|---|
  | 1. | 100 | 55 m | 1,0 mp | 25 |
  | 10. | 208 | 68,5 m | 0,65 mp | 43 |
  | 20. | 328 | 83,5 m | 0,47 mp | 63 |

  A 20. szintű tank egy lövege így kb. ötször annyit sebez másodpercenként,
  mint a kezdőé, és kb. háromszor annyit bír ki – de ki lehet lőni: egy azonos szintű
  tanknak öt-hat lövés, egy kezdő tanknak a legerősebb löveghez is elég 14 alaplövés. Szintlépéskor a löveg a többlet
  életerőt megkapja; ha a gazda szintet veszít, a löveg felső határa is csökken.
- **Kilőhető:** az ellenség lövedéke, a rakéta robbanása, az akna, a tüzérségi
  csapás és a felrobbanó jármű is sebzi. A lerakója lövedéke nem árt neki. A
  magas szintű ellenséges tank az ütközésével is szétrombolja.
- Akadály: a tankok (a lerakójáé is) nem tudnak átmenni rajta.
- Egy játékosnak egyszerre nyolc lövege állhat; a kilencedik lerakásakor a
  legrégebbi eltűnik. A már lerakott lövegek a gazda kilövése után is megmaradnak.
- A botok megtámadják az ellenséges löveget; a füstben álló és az álcázott
  tankot a löveg nem (illetve csak közelről) látja. A civil járművekre nem lő.

### Üzenetek és hang

- **Ki van bejelentkezve:** a csevegő tetején névcímkék mutatják a
  bejelentkezett játékosokat és hogy hol vannak: zöld az előszobában, kék a
  váróban, narancs a meccsen lévő; a saját neved sárga. A lista magától frissül.
- **Előszoba:** belépés után a főképernyőn és a játékok listájánál csevegő
  látszik: amit ide írsz, mindenki megkapja, aki be van lépve és nincs
  szobában. Aki később lép be, az utolsó 30 üzenetet is látja.
- **A váróban** a csevegő a szobáé: csak a szobatársak látják.
- **Meccs közben** a **T** (vagy az **Enter**) a képernyő közepén nyit
  beviteli mezőt (Enter: küldés, Esc: mégsem); gépelés közben a tank megáll, a
  billentyűk nem irányítják. Az üzenetek a képernyő jobb szélén (a kis térkép alatt) jelennek meg
  mindenkinél, aki a meccsben van, és néhány másodperc múlva elhalványulnak.
- **Hang (adóvevő):** a **B** nyomva tartása alatt a mikrofonod hangját a
  szobatársak hallják; elengedve vége. Az első használatkor a böngésző
  engedélyt kér a mikrofonhoz (utána a meccs végéig nyitva tartja, de hang csak
  a gomb nyomva tartása alatt megy). A beszéd elejét és végét rövid rádiójel
  jelzi, és a bal alsó sarokban látszik, ki beszél. Egyszerre legfeljebb hárman
  beszélhetnek. A hang a hangerő-beállítást követi.
- A hang **a játék saját szerverén** megy át: nincs külső szolgáltatás, és a
  játékosok nem látják egymás hálózati címét. Telefonminőségű, rádiószerű hang
  (12 kHz), kb. 0,2 másodperc késéssel. Mikrofon csak biztonságos kapcsolaton
  (https vagy a saját gép) érhető el: a helyi hálózati IP-címen megnyitott
  játékban a hang nem működik, a szöveges üzenet igen.
- Egyjátékos módban nincs csevegő és hang. A szerver az üzeneteket megtisztítja
  (legfeljebb 200 karakter), és aki elárasztja a csevegőt, annak az üzenetei
  néhány másodpercig nem mennek át.

### Álcázás

Minden tank alapképessége, tárgy nem kell hozzá: a **bal Ctrl** (vagy a **V**)
10 másodpercre álcázza a tankot, és a bekapcsolástól számítva **percenként
egyszer** használható. A tank sávja mutatja, hogy éppen tart, készen áll, vagy
mennyi idő múlva lesz újra használható.

- **Nem láthatatlanság:** a tank halvány, kékes, vibráló sziluett lesz. Aki
  figyel, észreveszi – a lánctalpa nyoma is megmarad a füvön –, de nincs
  fölötte életerősáv, név és szintjelvény, nem füstöl, nincs fénye, és a
  térképen sem látszik. A saját álcázott tankod félig áttetsző.
- **A lövés leleplez:** az első lövésnél az álcázás azonnal megszűnik.
- A botok és a telepített ágyúk az álcázott tankot csak 20 méteren belülről
  veszik észre.
- A találatok (sebzésszám, robbanás) álcázva is látszanak; az akna alatta is
  felrobban. A bosszújel az álcázott tankot nem mutatja.
- **A Ctrl és a böngésző:** a böngésző néhány gyorsbillentyűjét (Ctrl+W: a
  lap bezárása) az oldal nem tudja letiltani, ezért meccs közben a böngésző
  megerősítést kér, mielőtt bezárná a lapot. Teljes képernyőn (F) a Chrome és
  az Edge ezeket a billentyűket is átengedi a játéknak. Aki nem szeretné, a
  Beállításokban másik billentyűt adhat meg.

> **Lőtáv:** egyik fegyver sem lő messzebb kb. 160 méternél (nagyjából a
> képernyő szélessége), így a pálya túlsó végéről nem lehet eltalálni senkit.
> A botok csak akkor lőnek, ha ők maguk is a képernyődön vannak.
>
> **Újraéledés:** a tankod újraéledéskor és belépéskor a térkép teteje felé
> (felfelé) néz.

### Főgonosz: a Vasóriás

- **Mikor jön:** csak **10 perces vagy hosszabb** meccsben (és a nyitott játékokban),
  legalább **0,2 km²-es** játéktéren. Az első a meccs **3–5. percében** érkezik; ha
  legyőzik, 8–10 perc múlva jöhet új – de csak akkor, ha a megérkezése után a meccsből
  még legalább 5 perc hátravan (5 perces meccsben soha).
- **Bejelentés:** 20 másodperccel előtte üzenet és sziréna; a térképen villogó koponya
  jelzi a helyét, és vörös nyíl mutat felé. Érkezéskor még 15 másodpercig nyíl mutat rá.
- **A tanya:** egy tágas hely a játékosoktól távol. A boss lassan araszol rajta
  (legfeljebb 12 m-re a közepétől), onnan nem megy el.
- **A boss:** fekete, vörösen izzó óriás (a 20. szintű tank másfélszerese), a neve
  fölötte, az életereje (a 20. szintű tank tízszerese: **6560**) a képernyő tetején, ha
  260 m-en belül vagy. Nagyon nagyot lő (nehéz lövedék, kb. 126 sebzés), de ritkán
  (2,6 mp-enként). **Csak védekezik:** azt lövi, aki a falkát megtámadta, vagy aki
  25 m-nél közelebb jön. Ha 30 másodpercig nem éri találat, lassan gyógyul.
- **A testőrök:** négy sötét bíborvörös, 12. szintű tank körben a boss körül (18 m-re).
  **Méhraj:** ha valaki a bosst vagy bármelyik testőrt megtámadja, **riadó**: két
  testőr (a boss két ellentétes oldaláról) rátámad és üldözi – a tanyától legfeljebb
  150 m-ig –, a másik kettő a bossnál marad, és a közelébe jövőket támadja. A riadó az
  utolsó támadás után 20 másodpercig tart. A kilőtt testőr nem éled újra.
- **A botok** és a falka békén hagyják egymást (amíg egy bot meg nem támadja őket), a
  géppuska és a telepített lövegek sem lőnek rájuk magától – csak az, aki szándékosan.
- **Jutalom:** aki **legyőzi**, **10 szintet lép** (legfeljebb a 20.-ig); aki a boss
  életerejének legalább 10%-át lebontotta, **2 szintet**. A kilövés a botok közé számít
  (nem kilövés), a meccs végi eredménynél külön sor jelzi: „A Vasóriás legyőzője: …”.
  A boss legyőzése után a testőrök elvonulnak.

### GPS

- **Cél kijelölése:** az **M**-mel feljövő nagy térképen kattints oda, ahová menni
  szeretnél: ott egy kék zászló jelenik meg. Újabb kattintás máshová: a cél átkerül.
- **Csak normál utakon vezet** (fő utak, lakóutcák, kiszolgáló utak) – gyalogúton,
  kerékpárúton, földúton és zöldterületen nem. Ha a cél nem úton van (pl. egy
  kertben), a GPS a hozzá legközelebbi útpontig visz, onnan pontozott vonal mutatja.
  A játéktérből nem vezet ki.
- **Amit mutat:** a talajon áttetsző kék sáv, rajta a cél felé áramló fehér
  nyilacskák (nem keverhető össze a sárga felezővonallal); a kép szélén kék nyíl
  a cél felé; a térképeken kék vonal és zászló; a térkép sarkában a hátralévő
  távolság („GPS 340 m · G: ki”).
- **Újratervez:** fél másodpercenként a tank helyéről – ha letérsz, onnan vezet tovább.
- **Kikapcsolás:** **G** (átállítható), vagy jobb klikk a nagy térképen. Megérkezéskor
  (10 m-en belül) magától kikapcsol. Kilövéskor a cél megmarad.
- **Csak te látod**, a többiek nem. A tüzérségi csapás célzása (**X**) közben a
  kattintás a csapás helye, nem GPS-cél.
- A lerombolt házak helyén nem vág át: a GPS mindig az utakon marad.

### Javítóműhely

A pályán néhány **javítóműhely** áll, minden meccsen máshol (négyzetkilométerenként
négy, legalább egy, legfeljebb tizenkettő): 17 × 14 méteres nyitott csarnok,
figyelmeztető csíkos betonpadlóval, zöld csavarkulcs-jellel, piros-fehér
táblával és villogó zöld fénnyel – a legnagyobb tank is kényelmesen elfér benne.
Fala nincs, be lehet hajtani.

- Amíg a tank a csarnokban áll, az életereje töltődik: másodpercenként a
  legnagyobb életerő 8%-a, vagyis kb. 12 másodperc alatt a nulláról teljesen
  feltölt. Közben szikrák és racsnikattogás jelzi a javítást.
- A műhely nem véd: a benne álló tankot ugyanúgy lehet lőni.
- A térképen (a kicsin és a nagyon is) zöld négyzet jelöli fehér kereszttel.
- Mindig egy út mellé kerül, ahonnan egy tank egyenesen be tud hajtani (nincs útban fal, kerítés, víz). Úttestre, épületre (a csarnok körül egy kis sávban sem), vízre és fák alá nem kerül; két műhely nincs egymás közelében.

### Kilövéssorozat és tüzérségi csapás

- Minden harmadik kilövés után, amelyet halál nélkül érsz el, jár egy
  **tüzérségi csapás** (egyszerre legfeljebb kettő lehet nálad; a botok nem
  kapnak). A halál a sorozatot nullázza, a már megszerzett csapás megmarad.
- **Kérése:** az **X** feljön a nagy térkép, és csak azon lehet célpontot
  választani: kattints oda, ahová kéred – a pálya bármely pontjára. A kérés
  után a térkép magától bezárul; az X újra megnyomva, az M vagy az Esc a kérés
  nélkül zárja be.
- 2,2 másodperc figyelmeztetés után (piros kör a földön és a térképen, süvítő
  hang) 18 lövedék hull a 24 méter sugarú körbe, egyenletesen elosztva (a kör
  minden részére jut, nem csomósodnak), kb. 2,7 másodperc alatt. Egy lövedék 7 méteres
  körben legfeljebb 60-at sebez, a távolsággal gyengülve; az épületeket is
  rombolja, a fákat kidönti. A kérőt és a saját lövegeit nem sebzi; a kilövés
  neki számít.

### Akna, füst, gázpalack

- **Akna** (tárgy, 2 töltet, legfeljebb 4 lehet nálad): az **R** a tank mögé
  rakja. 1,2 másodperc múlva élesedik, és az első ellenséges tank alatt
  robban (6,5 méteres körben legfeljebb 70 sebzés). A sajátod jól látszik, az
  ellenfélé alig. A lerakója alatt nem robban; egyszerre 6 lehet kint, 3 perc
  után eltűnik. A kilövés a lerakóé.
- **Füst** (tárgy, 2 töltet, legfeljebb 4): a **C** füstöt ereszt a tank
  köré 16 másodpercre. A felhő 9 méter sugárral indul, és 4,5 másodperc alatt
  **30 méter sugarúra** terjed szét (egy kisebb háztömböt beborít); közben a
  szél lassan kelet felé sodorja (16 másodperc alatt kb. 10 métert). Gomolyog,
  a széle foszlik, a végén a széléről befelé oszlik el. Ami benne van, az
  kívülről nem látszik (a térképen sem), és a botok meg a telepített lövegek
  sem látnak bele. Aki benne áll, a közvetlen környezetét halványan látja.
- **Gázpalackok** állnak a házak fala mellett (négyzetkilométerenként 30,
  legalább 4, legfeljebb 140). Találattól vagy ráhajtástól felrobbannak
  (8,5 méteres körben legfeljebb 55 sebzés), és a közeli palackokat, aknákat
  is beindítják – láncreakció. Mindenkit sebez, azt is, aki beindította; a
  saját robbanásáért senkinek nem jár pont. (A pálya adataiban nincs
  benzinkút, ezért az nem került a játékba.)

### Szupertárgy

Percenként egyszer megjelenik a játéktér közepe táján egy **szupertárgy**;
tíz másodperccel előtte mindenki értesítést kap, és a térképen lila jel, a
képernyőn lila nyíl mutatja a helyét. Aki felveszi: teljes javítás, tele
pajzs (3), és 20 másodpercig **háromszoros sebzés** – a tankja körül ez idő
alatt lila fény lüktet, mindenki látja. Egyszerre csak egy van a pályán.

### Felvehető tárgyak

A tárgyak a játéktér útjain vannak szétszórva (a számuk a „Felvehető tárgyak"
csúszkától és a pálya méretétől függ); a felvett tárgy helyett 12 másodperc
múlva új jelenik meg, máshol. A tank érintésre veszi fel őket.

| Tárgy | Hatás | Meddig tart |
|---|---|---|
| Nehéz lövedék | fegyver: nagyobb robbanás, gyorsabb lövedék, dupla sebzés | a következő fegyverig vagy a kilövésig |
| Rakéta | fegyver: lassan indul, felgyorsul, kb. 160 m-re repül, területre sebez | a következő fegyverig vagy a kilövésig |
| Lézer | fegyver: azonnal célba érő sugár 160 m-ig, 24 sebzés; a sugár a csőből indul (menet közben is), vakító sárga mag kettős lila spirállal | a következő fegyverig vagy a kilövésig |
| Pattanó lövedék | az alap- és a nehéz lövedék a falról kétszer visszapattan (a rakéta és a lézer nem) | 60 mp |
| Hármas lövés | három lövedék (rakéta, lézersugár) legyezőben, bármelyik fegyverrel | 25 lövés (összeadódik, legfeljebb 75) |
| Gyorstöltő | 2,5-szer gyorsabb tüzelés | 15 mp |
| Olajfolt | 3 lerakható, 7 méter sugarú folt (egy utcát teljes szélességében elzár); aki gyorsan hajt rá, 1,7 mp-ig irányíthatatlanul pörög és sodródik, és aki belehajt (akár lassan), annak **olajos lesz a lánctalpa**: a folton és utána még 4 mp-ig kipörög, mint a jégen – a végsebessége a 45%-a, a gyorsulása és a fékezése a 30%-a | 3 töltet, a folt 45 mp-ig marad |
| Javítókészlet | azonnal visszaad 100 életerőt; a leggyakoribb tárgy (kb. minden ötödik) | azonnali |
| Turbó | 45%-kal nagyobb végsebesség, jobb gyorsulás | 12 mp |
| Terepjáró lánctalp | terepen és sárban sem lassul a tank, olajon sem csúszik meg; esőben négyszer több van belőle | 25 mp |
| Pajzs | egy töltet egy találatot nyel el (legfeljebb 3) | töltet |
| Sebezhetetlenség | semmi nem sebez, nem csúszik meg | 10 mp |
| Radar | a térképen látszanak a felvehető tárgyak | 30 mp |
| Löveg | lerakható (Q): magától lő a közeli ellenségre, és a tankkal együtt fejlődik | egy további löveg (legfeljebb 8 lehet a tanknál); a löveg a kilövéséig áll |
| Akna | lerakható (R): az ellenséges tank alatt robban | 2 töltet (legfeljebb 4) |
| Füst | lerakható (C): 12 m sugárral indul, 7 mp alatt 60 m sugarúra terjed, eltakar, a szél sodorja | 2 töltet (legfeljebb 4), a felhő 20 mp |
| Géppuska | a tank jobb oldalára szerelt géppuska magától lő a legközelebbi ellenségre (40 m-en belül, ha rálát): másodpercenként kb. 8 lövés, egyenként 2,5 sebzés; a fő fegyver mellett működik, álcázva hallgat. A lövedékek rövid csíkként repülnek a célig (minden harmadik fényes nyomjelző), a csőnél torkolattűz villog, oldalra hüvelyek repülnek, a becsapódásnál szikra és por | 60 mp |
| Szupertárgy | teljes javítás, tele pajzs, háromszoros sebzés (csak a pálya közepén jelenik meg, percenként) | 20 mp |

Egyszerre egy fegyver lehet a tanknál: az újonnan felvett a régi helyére lép.

### Ami még nincs kész

- további játékmódok (csapatos, várvédő, küldetés);
- parkoló, kilőhető autók; buszmegállók (az OSM-adatból);
- visszatérés megszakadt kapcsolat után a folyamatban lévő meccsbe;
- ledönthető kerítések;
- érintőképernyős irányítás (a játék asztali gépre készül);
- e-mailes jelszó-visszaállítás, eredmények és ranglista a fiókokhoz.

## Megjelenítés

- **A kép mindig kitölti az ablakot.** A látómező 16:9-es képernyőn
  160 × 90 méter; ennél szélesebb képernyőn (21:9, 32:9) a magasság marad, és
  oldalra több látszik (21:9-en kb. 215 m), keskenyebb ablakban (16:10, 4:3)
  a szélesség marad, és függőlegesen látszik több. Az ablak átméretezését
  (teljes képernyő, másik monitor) menet közben követi. 32:9-nél szélesebb
  ablaknál a kép két szélén sáv marad.
- A belső felbontás a kijelzőhöz igazodik (legfeljebb 12, legalább 8
  pixel/méter; 12-nél a kép 1080 pixel magas, 16:9-en 1920 × 1080), nagyobb
  felbontású monitoron a kép felnagyítva tölti ki a képernyőt. Az URL
  `?ppm=8` paraméterével kézzel csökkenthető.
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
      roadnet.ts          úthálózat a forgalomhoz: csomópontok, irányított élek, kapuk, stopvonalak
      vehicles.ts         a civil járművek és a telepíthető ágyú adatai, állapota
      traffic.ts          a forgalom vezetése: sávkövetés, megállás, megfordulás, ijedtség
      match.ts            a meccs szabályai: játékmód, létszámok a pálya méretéből, játékidő, győztes
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
assets/maps/landmarks/    fotók alapján kézzel felvett részletek, vázlatrajz alapján felvett házak
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
