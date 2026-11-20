# Játékmenet és architektúra

A többjátékos mód, a szerver és a fiókok leírása külön fájlban van:
[multiplayer.md](multiplayer.md). Ez a fájl a játék szabályait, a
megjelenítést és a kód felépítését írja le.

## A játék

Kozármisleny térképének egy kijelölt részén, tankkal, mindenki mindenki ellen.
Egy meccsben 1–8 játékos és (beállítástól függően) gép vezérelte botok vannak.
A meccs **időre megy** (5–30 perc): a kilőtt tank néhány másodperc múlva
újraéled, és **az nyer, aki az idő lejártáig a legtöbb tankot lövi ki**. Az
utcákon – ha a létrehozó nem kapcsolja ki – civil forgalom is van.

Ez az egyetlen játékmód („deathmatch"); a mód a meccs beállításainak része
(`mode`), hogy később más módok (csapatos, várvédő, küldetés) is
bekerülhessenek.

### Menük

- **Főképernyő:** belépés vagy regisztráció (játékosnév + jelszó), utána
  *Multiplayer*, *Egyjátékos*, *Beállítások*, *Kijelentkezés*.
- **Egyjátékos:** gyakorlás a botok ellen, szerver nélkül – a meccs a
  böngészőben fut. Belépés nélkül is elérhető, akkor is, ha a szerver éppen nem
  érhető el. Ugyanazokkal a csúszkákkal állítható be, mint egy többjátékos
  játék (játéktér, játékidő, botok száma, ügyessége és agresszivitása, tárgyak,
  forgalom, időjárás), és azonnal indul. Az idő lejártáig tart; az eredmény a
  kilövéseid száma.
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
| Q | ágyú telepítése a tank mögé (ha van töltet) |
| Tab | eredménytábla, amíg nyomva van |
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
(bal felül, *i*), mellette a **tank sávja**, felül középen pedig a
**visszaszámláló óra** látszik.

- **Az óra** a hátralévő játékidőt mutatja (perc:másodperc), alatta a
  kilövéseid száma és – többjátékos meccsben – a helyezésed. Az utolsó fél
  percben pirosan villog.
- **Az eredménytábla** a Tab nyomva tartására jelenik meg (vagy az órára
  kattintva, akkor kint marad, amíg rá nem kattintasz): minden játékos
  helyezése, kilövései, halálai és szintje, a végeredmény sorrendjében.
- **A pálya a kijelölt játéktérre van vágva:** a kamera a játéktér szélén
  megáll (a határt sárga vonal jelzi), azon túl semmi nem látszik – a térképen sem.
- **A tank sávja:** elöl a tank szintje, utána ami éppen nála van – a fegyver
  (nehéz lövedék, rakéta, lézer), a megmaradó képességek (pattanó lövedék), a
  hármas lövés hátralévő lövései, a pajzs-, olaj- és ágyútöltetek, valamint az
  időre szóló tárgyak a hátralévő másodpercekkel.
- A térkép a tank kb. 700 m-es környékét mutatja (kis játéktérnél az egészet); az M az egész játékteret mutatja nagyban. A botok piros, a többi játékos narancssárga pontként látszik
  (a játékosok mindig, bármilyen messze vannak).
- A saját tank zöld, a botok vörösek, a többi játékos tankja kék.
- A tankok fölött az életerősáv; a sajátod fölött – használat közben – a
  gyorsító hőfoka is.
- Az **információs panel** (H vagy az *i* gomb): az irányítás az aktuális
  billentyűkkel, a tankod állapota (életerő, szint, kilövések és halálok, fegyver, aktív
  tárgyak), a játékosok állása, a forrásmegjelölés és a *Kilépés a meccsből* gomb.
- A fontos események rövid értesítésként jelennek meg felül (felvett tárgy,
  kilövés, szintlépés).
- A tájékozódási pontok (hivatal, templom, rendőrség…) felirata a pályán marad.

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
- **Sebzés:** a tank életereje 100 (szintenként több). Egy sima lövedék 25-öt
  sebez, a nehéz 50-et, a rakéta 55-öt (a robbanása 7 m-en belül további
  30-at), a lézer 18-at.
- **Kilövés:** a kilőtt tank 4 másodperc múlva éled újra – véletlen helyen, a
  többi játékostól távol –, rövid sebezhetetlenséggel, alapfegyverrel,
  akárhányszor. A roncsa ott marad, ahol kilőtték (akadály; egy ideig ég).
- **Győzelem:** az idő lejártakor az nyer, akinek a legtöbb kilövése van (a
  botok kilövése is számít, és az is, amit a telepített ágyúja vagy egy általa
  felrobbantott jármű ért el). Azonos kilövésszámnál az nyer, akit
  kevesebbszer lőttek ki; ha ez is egyezik, döntetlen. Ha egy többjátékos
  meccsből mindenki más kilép, a bent maradó nyer.
- **Szintek:** a játékos tankja minden kilőtt tank után szintet lép (legfeljebb
  a 20. szintig): szintenként 4%-kal nagyobb, 12-vel több a legnagyobb
  életereje, és 8%-kal többet sebez. A botok nem lépnek szintet.
- **A szint megmarad:** a kilőtt tank ugyanazon a szinten, a szintjéhez járó
  teljes életerővel éled újra. Csak a felszerelése vész el: a felvett fegyver,
  a pajzs, az olaj, a telepíthető ágyú töltetei és az időre szóló hatások.
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
méretétől függ. Két további csúszka (1–5, a 3-as a közepes) szabja meg a
viselkedésüket:

| Szint | Ügyesség: célzási hiba, reakcióidő, tűzgyorsaság | Agresszivitás: látótáv, üldözés, tartott távolság |
|---|---|---|
| 1 | kezdő: ±10°, 1,4 mp, 1,9 mp-enként lő | békés: 45 m-ről vesz észre, 4 mp-ig üldöz, 30 m-re megáll |
| 2 | gyenge: ±6°, 1,0 mp, 1,5 mp | óvatos: 60 m, 6 mp, 26 m |
| 3 | közepes: ±4°, 0,7 mp, 1,2 mp | közepes: 75 m, 9 mp, 22 m |
| 4 | ügyes: ±2°, 0,45 mp, 0,95 mp | harcias: 90 m, 13 mp, 18 m; 260 m-en belül akkor is feléd tart, ha nem lát |
| 5 | mesterlövész: ±1°, 0,25 mp, 0,75 mp | vadászik rád: 110 m, 20 mp, 14 m; a pálya bármely pontjáról feléd tart |

Az alábbi leírás a közepes szintre vonatkozik. Egymásra nem céloznak és egymást nem sebzik; bármelyik
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

### Telepíthető ágyú

Felvehető tárgy; egyszerre legfeljebb két töltet lehet a tanknál. A **Q**
billentyű a tank mögé rakja le.

- Az ágyú a lerakójáé: **magától lő minden ellenséges tankra** (a többi
  játékosra és a botokra) 55 m-en belül, ha rálát – falon át nem. Másodpercenként
  egyet lő, sima lövedékkel; a találatai és a kilövései a lerakójának számítanak.
- **Kilőhető:** 120 életereje van; az ellenség lövedéke, a rakéta robbanása és
  a felrobbanó jármű is sebzi. A lerakója lövedéke nem árt neki. A magas
  szintű ellenséges tank az ütközésével is szétrombolja.
- Akadály: a tankok (a lerakójáé is) nem tudnak átmenni rajta.
- Egy játékosnak egyszerre két ágyúja állhat; a harmadik lerakásakor a
  legrégebbi eltűnik. A tank kilövésekor a nála lévő töltetek elvesznek, a
  már lerakott ágyúk megmaradnak.
- A botok megtámadják az ellenséges ágyút. A civil járművekre az ágyú nem lő.

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
| Telepíthető ágyú | lerakható (Q): magától lő a közeli ellenségre | töltet (legfeljebb 2), az ágyú a kilövéséig áll |

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
