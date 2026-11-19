# TANK MISLENY --- Claude Code fejlesztési brief

## Projektcél

Készíts egy böngészőben futó, 16 bites pixel-art stílusú, felülnézetes
tankos multiplayer játékot **TANK MISLENY** munkanéven.

**Most kizárólag a játék fejlesztése a cél.** Ne készíts
marketingoldalt, nyilvános portált, regisztrációs felületet vagy teljes
weboldalt. A weboldal és a városi közösségi platform későbbi fázis.
Elsőként egy lokálisan futtatható, jól játszható prototípus készüljön,
amelynek architektúrája később támogatja az online többjátékos módot.

A pálya valós Kozármisleny-térképi adatokból induljon ki. A kiemelt
tájékozódási pont és a pálya központja a **Kozármislenyi Polgármesteri
Hivatal** legyen. A városközpontnak a helyiek számára felismerhetőnek
kell lennie; ne helyettesítsd egy általános, kitalált európai
kisvárossal.

## Vizuális és játéktervezési irány

-   Nézet: top-down / felülnézet.
-   Grafika: részletgazdag, 16 bites retro pixel art.
-   Játék: arcade tankcsata, gyors, könnyen megtanulható irányítással.
-   Első pálya munkacíme: **MISLENY KÖZPONT**.
-   A valós úthálózat, kereszteződések, épület-elhelyezkedések és
    közterületek adják a pálya földrajzi vázát.
-   A térképi alapot stilizáld játékpályává: a házak és tereptárgyak
    lehetnek pixel art elemek, de a fontos utcák és épülettömegek
    relatív helyzete maradjon hű az adatforráshoz.
-   A Polgármesteri Hivatal legyen a pálya központi, egyértelműen
    azonosítható tereptárgya. A hivatal épületét és közvetlen
    környezetét a térképi adatok alapján jelenítsd meg, ne találj ki
    hozzá helyszínt.
-   Ne jeleníts meg lakók nevét, magánjellegű adatot, rendszámot vagy
    más személyes adatot. A játékosok beceneveket használjanak.
-   Ne állítsd, hogy a generált pálya méretarányos vagy geodéziailag
    pontos, ha ezt nem ellenőrizted.

## Térképi adatbeszerzés és licenc

Elsődleges kiinduló adatforrás az **OpenStreetMap (OSM)**. A Google Maps
képeit, csempéit vagy adatait ne kapard le, ne másold és ne használd fel
engedély nélkül.

### Kötelező adat-előkészítési lépések

1.  Azonosítsd a Kozármislenyi Polgármesteri Hivatal pontos
    OSM-objektumát (név, cím, koordináta, objektumazonosító), és
    ellenőrizd a helyszínt térképen.
2.  A hivatal köré válassz ésszerű, kezdetben kb. 500--700 méter sugarú
    vagy hasonló kiterjedésű kivágást. A végleges határt úgy állítsd be,
    hogy a hivatal és a felismerhető központi utcák kényelmesen
    elférjenek.
3.  Overpass API / Overpass Turbo segítségével gyűjtsd le a szükséges
    OSM-objektumokat:
    -   utak és gyalogos átjárók;
    -   épületkontúrok;
    -   parkok, zöldterületek, fasorok, vízfelületek;
    -   közterek és fontos középületek;
    -   a Polgármesteri Hivatal objektuma.
4.  Mentsd a nyers adatokat a projektbe, például `assets/maps/osm/` alá,
    és készíts belőlük feldolgozott, játékhoz optimalizált GeoJSON vagy
    saját JSON pályafájlt.
5.  A lekérdezés legyen reprodukálható: a query és a feldolgozó script
    is kerüljön be a repóba.
6.  Ellenőrizd a lekérés eredményét: hiányzó épületkontúrok vagy hiányos
    utcák esetén jelezd, ne találj ki hamis pontosságot.
7.  Tartsd be az OSM Open Database License (ODbL) feltételeit. A
    játékban és a dokumentációban legyen megfelelő forrásmegjelölés,
    például: **„© OpenStreetMap közreműködők"**, valamint hivatkozás az
    OSM copyright oldalára. A pontos licencelési kötelezettséget a
    terjesztés módjához igazítva ellenőrizd.

Hasznos források: - https://www.openstreetmap.org/ -
https://www.openstreetmap.org/copyright - https://overpass-turbo.eu/ -
https://wiki.openstreetmap.org/wiki/Overpass_API

Ne feltételezd, hogy az összes ház és részlet szerepel az OSM-ben. Az
adatminőség területenként eltérhet.

## Játékmenet --- első prototípus

### Első mérföldkő: egyjátékos, játszható pálya

Először legyen teljesen működő helyi prototípus:

-   Egy irányítható tank.
-   WASD vagy nyílbillentyűs mozgás.
-   Egér vagy Space billentyű a lövéshez.
-   Tankforgás a mozgás irányába, illetve célzás egérrel --- válassz egy
    következetes irányítási modellt.
-   Falaknak, épületeknek és tereptárgyaknak való ütközés.
-   Lövedékek, robbanás-effektek és egyszerű hangok.
-   Kamera követi a tankot; a pálya szélei nem járhatók át.
-   Újraindítás és rövid, egyértelmű kezelési útmutató.
-   60 FPS célérték átlagos asztali böngészőben, ésszerű teljesítményű
    mobilon is tesztelve.

### Pályaelemek

A pályát tile-alapú vagy más, jól szerkeszthető réteges rendszerben
építsd fel. A térképi adat és a játéklogika váljon szét.

Javasolt rétegek: 1. talaj és útfelület; 2. járdák és terek; 3.
épületek; 4. kerítések, sövények és fák; 5. ütközési geometriák; 6.
interaktív elemek és bónuszok; 7. vizuális effektek.

Az épületek és a díszítőelemek ne mind legyenek rombolhatók. A
játékmenet kedvéért kijelölt akadályok lehetnek rombolhatók, de a
Polgármesteri Hivatal mint fő tájékozódási pont maradjon stabil, jól
felismerhető elem.

### Alap játékszabályok

-   Tervezett meccsméret: 2--8 játékos.
-   Tervezett meccsidő: 5 perc.
-   Kezdő játékmód: mindenki mindenki ellen (FFA).
-   Későbbi játékmód: 2 csapatos mód.
-   Pontozás: találat/kiütés és túlélési idő alapján, egyszerűen és
    átláthatóan.
-   Bónuszok: extra páncél, gyorsabb lövés vagy javítás.
-   Ne legyen fizetős előny vagy pay-to-win mechanika.

A prototípusban a több tank lehet egyszerű helyi bot vagy tesztpéldány.
A valódi online multiplayer csak a stabil helyi játékmenet után
következzen.

## Javasolt technológia

-   **TypeScript**
-   **Vite**
-   **Phaser 3** a 2D játékhoz
-   Későbbi multiplayerhez **Node.js + Socket.IO** vagy más,
    szerveroldali állapotkezelést biztosító megoldás
-   Térképi adatfeldolgozás: GeoJSON, szükség szerint Python vagy
    Node.js segédscriptek
-   Tesztelés: Vitest és Playwright, ahol indokolt

Ne építs be most adatbázist, felhasználói regisztrációt vagy teljes
backend rendszert, ha a prototípushoz nincs rájuk szükség. A kód legyen
moduláris, hogy később hozzá lehessen adni a hitelesítést, lobbykat,
szobákat, ranglistát és szerveroldali multiplayer logikát.

## Multiplayer-előkészítés --- későbbi fázis

A kliens ne legyen a játékállapot kizárólagos hiteles forrása. A későbbi
online módhoz tervezz szerver-authoritatív modellt:

-   szerver kezeli a játékosok pozícióját, lövéseit, találatait és
    pontjait;
-   kliens inputokat küld, nem végleges állapotot;
-   szerver validálja a mozgást és a találatokat;
-   legyen szobakezelés és újracsatlakozás lehetősége;
-   a hálózati üzenetek legyenek verziózhatók.

Ezt most dokumentáld és készíts elő, de ne késleltesse az első játszható
prototípust.

## Projektstruktúra --- javaslat

``` text
tank-misleny/
  public/
  src/
    game/
      scenes/
      entities/
      systems/
      maps/
      ui/
    data/
    styles/
  assets/
    sprites/
    tilesets/
    audio/
    maps/
      osm/
      processed/
  scripts/
    fetch-osm.*
    process-map.*
  docs/
    map-data.md
    gameplay.md
  README.md
  package.json
```

A tényleges struktúrát a választott eszközökhöz igazíthatod, de a
térképi adat, a játéklogika és a grafikai assetek maradjanak
elkülönítve.

## Elfogadási kritériumok az első verzióhoz

Az első mérföldkő akkor tekinthető késznek, ha:

1.  A projekt egyértelmű README alapján elindítható.
2.  A böngészőben betölt a MISLENY KÖZPONT pálya.
3.  A pálya a Polgármesteri Hivatal valós térképi helyzetéből indul ki,
    és ezt a dokumentáció igazolja.
4.  A főbb utak és épülettömbök elhelyezkedése a letöltött OSM-adatokhoz
    igazodik.
5.  A hivatal a pályán vizuálisan kiemelt, felismerhető tereptárgy.
6.  A tank billentyűzettel irányítható, lőni tud, és az ütközések
    működnek.
7.  A kamera és a pálya szélei megfelelően működnek.
8.  A játék legalább egy teljes, újraindítható próbakört biztosít.
9.  Az OSM-forrásmegjelölés látható a játékban vagy a hozzá tartozó
    információs panelen, és szerepel a README-ben.
10. A projekt nem tartalmaz Google Maps-adatkaparást vagy engedély
    nélküli térképmásolatot.

## Munkamódszer Claude Code számára

1.  Először vizsgáld meg a meglévő repót és környezetet. Ha üres, hozz
    létre minimális Vite + TypeScript + Phaser projektet.
2.  Készíts rövid megvalósítási tervet, majd dolgozz kis, ellenőrizhető
    lépésekben.
3.  Elsőként azonosítsd és töltsd le a Polgármesteri Hivatal körüli
    OSM-adatokat. A forrást, lekérdezést, dátumot és az
    objektumazonosítókat dokumentáld.
4.  Készíts egyszerű, pontos térképi alapot, mielőtt a pixel art
    részletezésbe kezdesz.
5.  Implementáld a tank mozgását és ütközéseit.
6.  Minden fontos lépés után futtasd a buildet és a teszteket; javítsd a
    hibákat.
7.  Ha a Polgármesteri Hivatal vagy a központi úthálózat OSM-ben nem
    azonosítható egyértelműen, állj meg, és kérj pontosító térképlinket
    vagy képernyőképet. Ne találgass.
8.  A végén add meg az indítási parancsokat, az elkészült funkciókat, a
    hiányosságokat és a következő fejlesztési lépéseket.

**Prioritás:** előbb hiteles, felismerhető Kozármisleny-központi
pályaalap és élvezetes, irányítható tankjáték; csak utána multiplayer és
a későbbi weboldal.
