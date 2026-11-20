# Többjátékos mód és a szerver

## Hogyan működik

A játék **szerver-authoritatív**: minden meccset a szerver számol, a böngészők
csak a billentyűk és az egér állapotát küldik el, és a szervertől kapott
állapotot rajzolják ki. Így nem lehet a kliens átírásával csalni, és ha valaki
kilép, a meccs a többieknek megy tovább.

```
böngésző  ──(https)──▶  a játék oldala (dist/)        ┐
böngésző  ◀─(wss /ws)─▶ szobalista, váró, meccsek     ├─ egyetlen Node.js program
                         fiókok (data/accounts.json)   ┘   (dist-server/server.mjs)
```

A „szerver létrehozása" a játékban egy **szoba (játék) létrehozását** jelenti
ezen az egy szerverprogramon belül – a játékosoknak semmit nem kell telepíteniük.

### Egy játék menete

1. **Belépés.** Regisztráció játékosnévvel és jelszóval (lásd lent), vagy
   belépés; a böngésző megjegyzi a belépést.
2. **Multiplayer – játékok.** A lista minden nyitott szobát mutat: a játékra
   várókat és a betelteket (indulókat, folyamatban lévőket) is, a
   beállításaikkal.
3. **Új játék.** A létrehozó a térképen, rácsban (kb. 83 m-es cellák) kijelöli a
   játékteret. A legkisebb játéktér két cella széles (kb. 165 × 165 m, nagyjából
   egy képernyőnyi): kétfős párbajhoz, hogy ne kelljen egymást keresgélni. Egy
   kattintás a térképen a legkisebb méretet jelöli ki. Ezután megadhat egy
   **belépőkódot** (lásd lent), és csúszkákkal beállítja:
   - a játékosok számát (1–8),
   - a játékidőt (5–30 perc, 5 perces lépésekben),
   - a botok és a felvehető tárgyak mennyiségét (0–5 szint) – a tényleges
     darabszámot a program számolja a pálya méretéből (szintenként és
     km²-enként 3 bot, illetve 17 tárgy; legfeljebb 100 bot és 600 tárgy;
     nagyon kis pályán a legmagasabb szint is csak 2–3 botot ad),
   - a botok ügyességét és agresszivitását (1–5 szint, lásd gameplay.md),
   - a civil forgalmat (0–5 szint; 0: nincs – szintenként és km²-enként 4
     jármű, legfeljebb 60),
   - az időjárást (nappal, eső, este).
   **Privát játék:** ha a létrehozó belépőkódot ad meg (3–16 karakter), a
   szobába csak az léphet be, aki a kódot helyesen megadja. A szoba a listában
   lakattal látszik, a „Belépés” a kódot kéri. A kis- és nagybetű, a szóközök
   nem számítanak. A kódot a szerver csak a szobában lévőknek küldi el (a
   váróban látszik, hogy tovább lehessen adni), a listába nem kerül bele. Öt
   hibás kód után fél percet várni kell az újabb próbálkozásig.
4. **Váró.** A létrehozó a szobában vár; ha minden hely elkelt, 3 másodperces
   visszaszámlálás után indul a meccs. Ha a létrehozó a váróból kilép, a szoba
   megszűnik.
5. **Meccs.** Mindenki mindenki ellen; a botok bármelyik játékost megtámadják.
   A játékosok véletlen helyen, egymástól távol születnek, és kilövés után is
   a többiektől távol élednek újra – akárhányszor, amíg tart a játékidő. A
   hátralévő időt a képernyő tetején óra mutatja.
6. **Vége.** Az idő lejártakor az nyer, akinek a legtöbb kilövése van
   (egyenlőségnél az, akit kevesebbszer lőttek ki; ha ez is egyezik, döntetlen).
   Megjelenik az eredménytábla, és a szoba eltűnik a listából. Ha mindenki más
   kilép, a bent maradó nyer. (Egyfős játéknak nincs győztese: az eredmény a
   kilövések száma.)

## Egyjátékos mód

A főképernyő *Egyjátékos* pontja szerver nélkül indít játékot: ugyanaz a
szobakezelő és meccslogika (`server/lobby.ts`, `sim/match.ts`) fut a
böngészőben, egyetlen helyi „kapcsolattal" (`net/LocalGame.ts`). Ezért az
egyjátékos és a többjátékos játék szabályai biztosan azonosak. Belépés nem
kell hozzá, és akkor is működik, ha a szerver nem érhető el (az oldalnak
persze be kell tudnia töltődni). A szerveren ilyenkor nem jön létre szoba.

## Indítás a saját gépen

Előfeltétel: Node.js 20 vagy újabb.

- `inditas.bat` – helyi játék: a szerver ezen a gépen fut, a böngésző
  megnyílik. A helyi hálózat többi gépe a gép IP-címén éri el
  (pl. `http://192.168.1.20:8787/`).
- `szerver.bat` – nyilvános szerver: a szerver mellett egy **Cloudflare
  Tunnel** alagutat is elindít, amelyen keresztül a játék az internetről is
  elérhető (routert, tűzfalat nem kell állítani, az otthoni IP-cím nem látszik).

Amíg a gép és a `szerver.bat` ablaka fut, a játék elérhető; ha leáll, a futó
meccsek megszakadnak.

### Verziószám

A játék verziója a `version.json` fájlban van, és **magától nő**: az
összeállítás előtt (`szerver.bat`, `inditas.bat`, `npm run build`) lefut a
`scripts/version.mjs`, amely ujjlenyomatot számol a játék forrásáról (`src/`,
`server/`, `index.html`, a feldolgozott pálya). Ha ez eltér a legutóbb
eltárolttól, a verzió második száma eggyel nő (1.0 → 1.1 → … → 1.9 → 1.10);
ha a forrás nem változott, a verzió marad. A leírások és a tesztek módosítása
nem számít. Az első számot kézzel lehet átírni a `version.json`-ban.

A verzió a játék bal alsó sarkában látszik, a szerver induláskor kiírja, és a
`/status` cím is visszaadja. A `version.json` a verziókezelés része: a
`commit.bat` a kóddal együtt elmenti.

### Elérés az internetről – ideiglenes cím (domain nélkül)

1. Telepítsd a `cloudflared` programot:
   `winget install --id Cloudflare.cloudflared`
2. Indítsd el a `szerver.bat` fájlt. A második ablak kiír egy
   `https://….trycloudflare.com` címet – ezt küldd el a játékosoknak.

Ez a cím minden indításkor más.

### Elérés az internetről – saját domainnel (állandó cím)

Egyszer kell beállítani; utána a `szerver.bat` mindig ugyanazon a címen teszi
elérhetővé a játékot.

1. Hozz létre egy ingyenes Cloudflare-fiókot, add hozzá a domaint, és a
   domain regisztrátoránál állítsd át a névszervereket a Cloudflare által
   megadottakra (a Cloudflare felülete végigvezet rajta).
2. Telepítsd a `cloudflared` programot (lásd fent), majd parancssorban:

   ```
   cloudflared tunnel login
   cloudflared tunnel create tank-misleny
   cloudflared tunnel route dns tank-misleny jatek.sajatdomain.hu
   ```

   Az első parancs böngészőt nyit: ott kell kiválasztani a domaint. A harmadik
   létrehozza a `jatek.sajatdomain.hu` címet (az aldomain neve szabadon
   választható, a domain a sajátod legyen).
3. A projekt mappájában hozz létre egy `alagut.txt` fájlt, amelynek az egyetlen
   sora az alagút neve: `tank-misleny`
4. Indítsd el a `szerver.bat` fájlt. A játék címe: `https://jatek.sajatdomain.hu/`

A parancsok a Cloudflare dokumentációját követik; ha a felületük vagy a
parancsaik változnak, az ő leírásuk az irányadó
(<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>).

### Költözés bérelt szerverre

A szerver egyetlen program, bárhol futhat, ahol van Node.js:

1. másold át a projektet (vagy `git clone`), majd `npm install` és `npm run build`;
2. másold át a `data/accounts.json` fájlt (ebben vannak a regisztrált játékosok);
3. indítsd el: `npm start` (a portot a `PORT` környezeti változó adja, alapértelmezés: 8787);
4. a domain aldomainjét irányítsd az új szerverre (alagúttal ugyanúgy, vagy
   közvetlenül, https-t adó fordított proxy mögött).

A játékosoknak ugyanaz a cím marad, a fiókjuk is megmarad.

### Beállítások (környezeti változók)

| Változó | Jelentés | Alapértelmezés |
|---|---|---|
| `PORT` | a figyelt port | `8787` |
| `HOST` | a figyelt cím | `0.0.0.0` |
| `WEB_ROOT` | a kiszolgált oldal mappája | `dist` |
| `MAP_FILE` | a pályafájl | `assets/maps/processed/misleny-kozpont.json` |
| `ACCOUNTS_FILE` | a fiókok fájlja | `data/accounts.json` |

A `http://localhost:8787/status` cím megmutatja, hányan vannak fent, hány szoba
és hány meccs fut, és hány regisztrált játékos van.

## Fiókok

- Regisztrációhoz **játékosnév** (3–18 karakter: betűk, számok, szóköz, pont,
  kötőjel, aláhúzás) és **jelszó** (legalább 6 karakter) kell. E-mail-címet a
  játék nem kér, személyes adatot nem tárol.
- A név egyedi (a kis- és nagybetű nem különbözik), a játékban ez látszik.
- A fiókok a szerveren, a `data/accounts.json` fájlban vannak. A jelszó nem
  tárolódik, csak a sózott, visszafejthetetlen lenyomata (scrypt); a belépve
  maradást szolgáló kulcsoknak szintén csak a lenyomata.
- Egy fiókkal egyszerre egy helyről lehet játszani: új belépéskor a régi
  kapcsolat megszakad.
- **Elfelejtett jelszó:** e-mail nélkül nincs visszaállítás. A szerver
  üzemeltetője (leállított szervernél) kitörölheti a játékos bejegyzését a
  `data/accounts.json` fájlból; ezután a név újra regisztrálható.
- A `data/` mappa nincs verziókezelés alatt; érdemes időnként biztonsági
  másolatot készíteni róla.
- A jelszó a böngésző és a szerver között a kapcsolat titkosításával védett,
  ha a játék https-címen fut (az alagúton keresztül így van). Sima, helyi
  hálózati `http://` címen a kapcsolat nincs titkosítva.

## A hálózati működés részletei

- **Ütem:** a szimuláció 60 lépés/másodperc; a szerver 20 pillanatképet küld
  másodpercenként. A kliens minden lépésben elküldi a bemenetét sorszámmal.
- **Előrejelzés:** a kliens a saját tank mozgását azonnal, helyben is
  kiszámolja (ugyanazzal a kóddal, mint a szerver), így az irányítás nem
  késik. A pillanatkép megmondja, melyik bemenetig jutott a szerver; a kliens
  onnan újrajátssza a még nem nyugtázott bemeneteket, az eltérést pedig simán
  tünteti el.
- **A többi tank** két pillanatkép között interpolálva mozog (kb. 50 ms
  késéssel), a lövedékek a sebességük szerint repülnek tovább.
- **Mit kap egy játékos:** a közelében lévő tankokat (380 m-en belül), minden
  játékos tankját (ők a térképen mindig látszanak), valamint a közeli
  lövedékeket, tárgyakat, olajfoltokat, roncsokat, civil járműveket és
  telepített ágyúkat (185 m – ez a legszélesebb, 32:9-es látómezőnél is túlér a képernyő szélén). A pálya változásai
  (kidőlt fa, összedőlt ház, kilövés) eseményként mindenkihez
  eljutnak; a csak látványt adó események (lövés, becsapódás) csak a közelben
  lévőkhöz.
- **Adatforgalom:** mérés szerint 8 játékossal és 100 bottal játékosonként
  kb. 50 KB/s; egy szimulációs lépés a pillanatképekkel együtt kb. 1,5 ms a
  szerveren, a legsűrűbb forgalommal (60 jármű) kb. 2 ms – a keret 16,7 ms.
- **Korlátok:** legfeljebb 400 kapcsolat és 60 szoba. Folyamatban lévő meccsbe
  nem lehet belépni, és megszakadt kapcsolat után nem lehet visszatérni a
  meccsbe (a játékos kilépettnek számít, az addigi eredménye megmarad).

### Üzenetek

Minden üzenet JSON, a `t` mező a típusa (`src/game/net/protocol.ts`). A
protokoll verziózott: eltérő verziójú kliens azt az üzenetet kapja, hogy
töltse újra az oldalt.

| Irány | Típus | Tartalom |
|---|---|---|
| kliens → szerver | `register`, `login`, `resume`, `logout` | belépés névvel és jelszóval, vagy megőrzött kulccsal |
| kliens → szerver | `create`, `join`, `leave` | szoba létrehozása (beállításokkal, privát játéknál belépőkóddal), belépés (privát szobába a kóddal), kilépés |
| kliens → szerver | `input` | sorszám és a bemenet (gáz, forgatás, célzás, tűz, olaj, gyorsító, ágyú telepítése, akna, füst, a tüzérségi csapás célpontja) |
| szerver → kliens | `auth`, `authError` | a belépés eredménye |
| szerver → kliens | `rooms`, `room`, `left` | a szobalista, a váró állapota (visszaszámlálással), kilépés |
| szerver → kliens | `start` | a meccs beállításai, a saját tank azonosítója, a játékosok |
| szerver → kliens | `snap` | pillanatkép: lépésszám, nyugtázott bemenet, a saját tank teljes állapota, a közeli elemek (tankok, lövedékek, tárgyak, járművek, ágyúk, aknák, füst, gázpalackok), a játékosok állása, a hátralévő játékidő |
| szerver → kliens | `ev` | a szimuláció eseményei |
| szerver → kliens | `over` | a győztes és az eredménytábla |

A szerver minden bejövő adatot ellenőriz: a szoba beállításait a megengedett
határok közé szorítja, a bemenet értékeit levágja, a nevet a fiókból veszi.

## A kód helye

```
server/
  main.ts        http (a dist/ kiszolgálása) + WebSocket (/ws), környezeti változók
  gate.ts        belépés: csak hitelesített kapcsolat érheti el a szobákat
  accounts.ts    fiókok: regisztráció, belépés, tárolás fájlban
  lobby.ts       szobalista, váró, a meccsek léptetése, pillanatképek (hálózat nélkül tesztelhető)
src/game/sim/match.ts    a meccs szabályai: játékmód, létszámok a pálya méretéből, játékidő, győztes
src/game/net/
  protocol.ts    az üzenetek típusai és tömörítése
  NetClient.ts   a kliens kapcsolata a szerverrel
  ClientWorld.ts a szerverállapot tükre a kliensen, a saját tank előrejelzésével
  LocalGame.ts   egyjátékos mód: a szobakezelő a böngészőben fut, szerver nélkül
```
