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
   **belépőkódot** (lásd lent), kiválasztja a **játékmódot** (egyelőre egy van,
   a Death Match; a lista a `GAME_MODES`-ból épül, új mód magától megjelenik
   benne), és csúszkákkal beállítja:
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

## Biztonság

A szerver az internetről is elérhető, ezért:

- **Csak a `dist/` mappa** (a játék oldala) adható ki; a projekt többi fájlja
  – a fiókok, a napló, a szerver programja – nem. A hibás kódolású cím
  „400 – Hibás cím” választ kap, egy hibás kérés nem állíthatja le a szervert.
- **Jelszó:** csak a sózott, visszafejthetetlen lenyomata (scrypt) tárolódik; a
  belépve maradás kulcsa véletlenszerű, abból is csak a lenyomat. A hibás és a
  nem létező névre ugyanannyi idő alatt jön a válasz.
- **A szerver dönt mindenről** (mozgás, találat, sebzés, szint), a kliens csak a
  billentyűket küldi: a játék kliensoldali átírásával nem lehet sebezhetetlenné
  vagy gyorsabbá válni. A nyitott játék kezelését a szerver is a fiók nevéhez köti.
- **Nevek, üzenetek:** a szerver kiszűri belőlük a `<` és `>` jelet, a
  kliens pedig minden kiírásnál hatástalanítja a HTML-t.
- **Elárasztás ellen:** kapcsolatonként legfeljebb 240 üzenet másodpercenként
  (fölötte bontás), legfeljebb 16 KB-os üzenet; egy címről legfeljebb 60
  kapcsolat, óránként 30 regisztráció, és 30 sikertelen belépés után 15 percig
  nem lehet jelszóval belépni. (A címet az alagúton át a Cloudflare adja – a
  `cf-connecting-ip` fejléc –, helyi hálózatról a kapcsolat címe.) Összesen
  400 kapcsolat és 60 szoba.
- **Fejlécek:** `Content-Security-Policy` (csak a saját oldal szkriptjei
  futhatnak, és csak a saját szerverhez kapcsolódhatnak – ha mégis bekerülne
  idegen kód, ne tudjon adatot kivinni), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN` (idegen oldal nem ágyazhatja be),
  `Referrer-Policy: no-referrer`, `Permissions-Policy` (kamera, helyadat tiltva;
  a mikrofon a hanghoz megmarad).
- **Idegen weboldal** nem kapcsolódhat a szerverhez a játékos böngészőjéből
  (a WebSocket `Origin` fejlécét a szerver ellenőrzi).
- **Jelszótalálgatás:** egy fiókra 20 sikertelen belépés után 15 percig – bárhonnan
  – nem lehet jelszóval belépni; a megőrzött kulccsal (a böngésző emlékszik) a
  gazda ilyenkor is be tud lépni.
- **A valódi cím** (`cf-connecting-ip`) fejlécét a szerver csak a saját gépén
  futó alagúttól fogadja el; a helyi hálózatról jövő kérés nem hamisíthatja.
- **Amire neked kell figyelni:** a ProWolf fiók erős jelszava (aki tudja, az
  nyitott játékot nyithat, módosíthat, leállíthat); a `data/` mappa és a
  `C:Users….cloudflared` mappa tartalma ne kerüljön ki. A helyi hálózati
  címen (http://…:8787) a forgalom titkosítatlan – nyilvános wifin inkább a
  https-es címet használd.

## Nyitott játék: szabad belépés, korlátlan ideig

A szerver gazdája **nyitott játékot** indíthat: azonnal indul, bárki bármikor
beléphet és kiléphet, és addig fut, amíg a gazdája le nem állítja. (A kódban
és a protokollban a neve `demo`.)

- **Ki indíthatja, módosíthatja, állíthatja le:** csak a `data/admins.txt`
  fájlban felsorolt fiókok (soronként egy fióknév, a `#` utáni rész
  megjegyzés; most: ProWolf). A változás a szerver újraindítása után érvényes;
  induláskor a szerver kiírja, ki a gazda. A `data/` mappa nincs
  verziókezelés alatt. Minden ilyen kérést a szerver is ellenőriz.
- **Indítás:** *Multiplayer → Új játék*, a gazdának megjelenik a „Nyitott
  játék” jelölőnégyzet. A beállítások a szokásosak (terület, botok, tárgyak,
  forgalom, időjárás); a létszám 2–100 fő között állítható, játékidő és
  belépőkód nincs. Egyszerre több nyitott játék is futhat.
- **A gazda nem kerül bele:** a játék üresen indul, ő a játékok listájánál
  marad, és ha akar, a „Belépés” gombbal ugyanúgy becsatlakozhat, mint bárki.
- **Belépés:** a listában „Nyitott játék – bármikor beléphetsz” felirattal
  látszik; menet közben is be lehet lépni, amíg van hely. A belépő rögtön
  tankot kap; aki kilép, annak a tankja eltűnik, a játék megy tovább. Az óra
  helyén „NYITOTT” áll; a csevegés és a hang mindig működik.
- **Kilépés és visszatérés:** aki kilép (vagy véletlenül újratölti az
  oldalt), annak a szintje, az eredményei és a felszerelése (fegyver, pajzs,
  aknák, füst, lövegek…) 2 percig megmarad: ha addig visszalép, onnan folytatja.
- **Módosítás menet közben:** a listában a gazdának „Módosítás” gombja van; a
  létrehozó képernyő a játék mostani beállításaival nyílik meg, és bármi
  átállítható (a terület is). A létszám nem vehető a bent lévők száma alá. Mentéskor
  a szerver új pályát épít a megadott beállításokkal (botok, forgalom, tárgyak,
  időjárás), a bent lévők oldala magától újratölt (pár másodperc), visszalép,
  és az új pályán éled újra – a szintjük, az eredményeik és a felszerelésük megmarad.
- **Üresen szünetel:** ha senki nincs bent, a szimuláció áll (nem fogyaszt
  gépidőt), és a következő belépővel onnan folytatódik.
- **A pálya újraépül:** a ledöntött épületek, kidőlt fák és oszlopok véletlen
  idő múlva újra megjelennek – fa, oszlop 2–5, épület 4–7 perc múlva –, egyenként
  (legalább 0,6 mp különbséggel), így a pálya folyamatosan, nem egyszerre épül
  vissza. Ha a helyén éppen tank, jármű, roncs vagy löveg áll, megvárja, amíg
  elmegy (senki nem szorul bele). A rom tüze ilyenkor kialszik. A rendes, időre
  menő meccsben nincs visszanövés.
- **Menet közbeni belépés:** a belépő megkapja, mi van éppen ledöntve, így nála
  is romként látszik, ami a szerveren rom.
- **Leállítás:** a gazdának „Leállítás” gombja van; a bent lévők visszakerülnek
  a játékok listájához.
- **Újraindítás után is megmarad:** a szerver minden létrehozáskor, módosításkor
  és leállításkor elmenti a nyitott játékokat a `data/open-games.json` fájlba
  (az `OPEN_GAMES_FILE` környezeti változóval más fájl adható meg), és
  induláskor ugyanazokkal a beállításokkal, ugyanazon az azonosítón újra
  megnyitja őket – üresen, szüneteltetve, amíg valaki be nem lép. A szerver
  induláskor kiírja, melyik nyitott játékok futnak. A játékosok szintje az
  újraindítást nem éli túl (az csak a meccs alatt él). Csak az a játék nyílik
  meg újra, amelynek a gazdája a `data/admins.txt` szerint ma is gazda; a
  sérült bejegyzés kimarad.
- **Sok játékos:** 8 főnél több játékosnál a távoli (csak a kis térképen
  látszó) játékosok is ritkábban frissülnek, mint a közeliek – így a forgalom
  játékosonként nem nő a létszámmal arányosan.

## Játéknapló: ki mennyit játszott

A szerver egy egyszerű szöveges fájlba írja, **ki mikor és mennyi ideig
játszott**: `logs/statisztika.txt` (a `logs/` mappa nincs verziókezelés
alatt). Jegyzettömbbel és Excellel is megnyílik; statisztikát később ebből
lehet készíteni.

Egy sor egy látogatás – az oldal megnyitásától a bezárásáig vagy
újratöltéséig –, pontosvesszővel tagolva:

```
kezdet;vege;jatekos;bent_mp;tobbjatekos_mp;egyjatekos_mp
2026-11-21 20:15:03;2026-11-21 20:47:10;Pista;1927;1200;312
2026-11-21 20:16:40;2026-11-21 20:21:02;(nincs belépve);262;0;240
```

| Oszlop | Jelentése |
|---|---|
| `kezdet`, `vege` | mikor nyitotta meg és mikor hagyta el az oldalt (a szerver helyi ideje) |
| `jatekos` | a játékosnév; aki nem lépett be (a belépőképernyőn van, vagy onnan az „Egyjátékos (szerver nélkül)” gombbal játszik), annál „(nincs belépve)” |
| `bent_mp` | ennyi másodpercig volt az oldalon (menü, váró, meccs együtt) |
| `tobbjatekos_mp` | ebből a szerveren futó meccsen töltött idő |
| `egyjatekos_mp` | ebből a böngészőben futó egyjátékos meccs (a böngésző jelzi, hogy elindult) |

- A sor akkor kerül a fájlba, **amikor a látogató elmegy**; a szerver
  leállításakor a még bent lévőké is kiíródik. Egy meccs után az oldal
  újratöltődik, ezért egy játékosnak egy estére több sora is lehet – a
  statisztikához ezeket név szerint össze kell adni.
- A játékidő néhány másodperc pontosságú (ötmásodperces mintavétel).
- Az egyjátékos idő addig számít, amíg a meccs oldala nyitva van.
- A fájlban csak név és idő van: IP-cím, jelszó nincs. A `STATS_FILE`
  környezeti változóval más fájl is megadható.

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
- **Különbségi pillanatkép:** a szerver minden kliensnek csak azt küldi el,
  ami az előző, neki küldött pillanatkép óta megváltozott. A kapcsolat
  megbízható és sorrendtartó (WebSocket), ezért a kliens a hiányzó mezőket az
  előző állapotából tudja (`mergeSnapshot`). Mindig megy: a lépésszám, a
  nyugta és a többi tank. Csak változáskor megy: a saját tank egyes mezői (a
  mozgás pontosan, a visszaszámlálók fél másodperces lépésekben, a szerver belső
  időzítői egyáltalán nem), és a ritkán változó listák (tárgyak, foltok, roncsok,
  aknák, palackok, lövegek, állás). A saját tank a tankok listájában nem
  ismétlődik; a képernyőn kívüli, csak a kis térképen látszó botok minden
  negyedik pillanatképben frissülnek.
- **Adatforgalom:** mérés szerint egy szokásos négyfős meccsen (botokkal,
  tárgyakkal, forgalommal) játékosonként **kb. 8 KB/s** megy ki a szerverről –
  a különbségi küldés előtt 27 KB/s volt. Nyolc játékossal és 100 bottal kb.
  22 KB/s játékosonként (előtte 61). Egy szimulációs lépés a pillanatképekkel
  együtt négy játékosnál kb. 0,2 ms, nyolc játékosnál 100 bottal és 60
  járművel 2–3 ms – a keret 16,7 ms.
- **Kisimított mozgás:** a kliens a többi tankot a két utolsó pillanatkép
  között mozgatja; ha a következő késik, a tank rövid ideig (a lépés 35%-áig) a
  korábbi irányában halad tovább, ahelyett hogy megállna és aztán ugrana.
- **Ha valakinél akad a játék:** a bal alsó sarokban a képkockaszám és a
  válaszidő megmutatja, hogy a gépe vagy a hálózata lassú-e. Fontos: a böngésző
  a **háttérben lévő** (nem látszó, vagy másik ablak mögötti) lap képkockáit
  visszafogja – ha egy gépen két ablakban próbálod ki a játékot, a háttérben
  lévő akadni fog, és a többiek is úgy látják, mintha az a játékos megállt volna.
- **A hang forgalma:** egy beszélő hangja hallgatónként kb. 17 KB/s feltöltés
  a szerverről (a base64 kódolással együtt). Nyolcfős szobában egy beszélőnél
  ez kb. 120 KB/s, a megengedett három egyidejű beszélőnél kb. 360 KB/s.
  Beszélőnként másodpercenként legfeljebb 30 darab megy át.
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
| szerver → kliens | `online` | a bejelentkezett játékosok és hogy hol vannak (előszoba, váró, meccs); a menükben lévők kapják, változáskor |
| szerver → kliens | `start` | a meccs beállításai, a saját tank azonosítója, a játékosok |
| szerver → kliens | `snap` | pillanatkép: lépésszám, nyugtázott bemenet, a saját tank megváltozott mezői, a közeli elemek (tankok, lövedékek, tárgyak, járművek, ágyúk, aknák, füst, gázpalackok), a játékosok állása, a hátralévő játékidő |
| szerver → kliens | `ev` | a szimuláció eseményei |
| szerver → kliens | `over` | a győztes és az eredménytábla |
| mindkét irány | `chat` | szöveges üzenet: szobán kívül az előszobának, szobában és meccsen a szobatársaknak; belépéskor `chatHistory` az előszoba utolsó üzeneteivel |
| mindkét irány | `voice` | hangdarab (50 ms, 12 kHz, 8 bites μ-law, base64-ben): a szerver a szobatársaknak adja tovább |

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
