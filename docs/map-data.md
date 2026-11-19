# Térképi adatok – Kozármisleny

## Források és licenc

| Forrás | Mire való | Licenc |
|---|---|---|
| **OpenStreetMap** (Overpass API) | utak, épületek, területhasználat, vizek, tájékozódási pontok – ez az elsődleges forrás | ODbL 1.0 |
| **Microsoft Global ML Building Footprints** | épületalaprajzok ott, ahol az OSM-ben nincs épület | ODbL 1.0 |
| Fotók a `pictures/` mappában | néhány középület és környezetük megjelenése (kézzel felvéve) | lásd lent |

- Forrásmegjelölés: **© OpenStreetMap közreműködők** – <https://www.openstreetmap.org/copyright>;
  a kiegészítő alaprajzoknál: Microsoft Building Footprints –
  <https://github.com/microsoft/GlobalMLBuildingFootprints>.
- A játékban a megjelölés a jobb alsó sarokban állandóan látszik.
- A projekt nem használ Google Maps-térképadatot vagy -csempét.

A nyers kivonatok (`assets/maps/osm/`) és a belőlük származtatott pályafájl
az ODbL hatálya alá tartozó adat. Nyilvános terjesztés előtt érdemes újra
átnézni a kötelezettségeket (forrásmegjelölés, a származtatott adatbázis
megosztása azonos feltételekkel).

### A fotókról

A `pictures/` mappa képei csak szemrevételezésre szolgálnak (tetőszín,
toronyforma, az utcakép jellege); a játékba sem kép, sem róluk leolvasott
térképi adat nem kerül. Több kép Google Utcakép-képernyőfotó, illetve más
forrásból származó felvétel, ezért a mappa **nincs verziókezelés alatt**
(`.gitignore`), és a projekttel együtt nem terjeszthető.

## Mi valós adat, és mi nem

| Elem | Forrás |
|---|---|
| Utak nyomvonala, típusa, neve | OSM |
| Épületek alaprajza és helye | OSM (1571 db); ahol ott nincs: Microsoft (1198 db) |
| Területhasználat (lakóterület, park, szántó, erdő, kiskert…), vizek, patakok | OSM |
| Tájékozódási pontok (hivatal, templomok, posta, rendőrség…) | OSM |
| Zebrák helye | OSM-ből levezetve (lásd lent) |
| Fasorok (61 fa) | OSM (`natural=tree_row`), kb. 8 méterenként egy fa |
| **Útszélesség, padka, füves sáv, járda** | **stilizált**, típusonként rögzített érték |
| **Tetők formája, színe, kémények** | **stilizált**, az alaprajzból számolva |
| **Fák, bokrok, villanyoszlopok, vezetékek** | **generált**, nem OSM-adat |
| **A hivatal, a református templom és a rendőrség megjelenése, környezete** | **fotók alapján kézzel felvéve**, becsült helyekkel |

A generált elemek a pályafájlban külön, `decor` nevű rétegben vannak
(`generated: true`), a fotók alapján felvett részletek a `landmarks`
rétegben, a nem OSM-ből származó épületek pedig `src: "ms"` jelölést kapnak,
így bármelyik elhagyható vagy pontosabb adatra cserélhető.

## A pálya kiterjedése

A pálya Kozármisleny beépített területét fedi le: **2000 × 3460 méter**.
A hivatal pontjától nyugatra 720 m-ig, keletre 1280 m-ig, északra 880 m-ig,
délre 2580 m-ig tart (a `process-map.mjs` `BOUNDS` állandója). Benne van az
északi városrész, a központ, a Kiskozári utca és a Csikósvölgy környéke,
valamint a déli óváros (Kossuth Lajos, Petőfi, Rákóczi Ferenc, Hunyadi utca).

Szándékosan kimaradtak a távoli külterületi utak (pl. az Alsóhegy dűlő
keleti vége, a Sirály utca) és a város határán túl futó főutak nagy része;
ami a téglalapba belelóg belőlük, az szerepel.

## A Polgármesteri Hivatal azonosítása

| | |
|---|---|
| OSM-objektum (pont) | [node 2608053959](https://www.openstreetmap.org/node/2608053959) |
| Címkék | `amenity=townhall`, `name=Városháza`, `addr:street=Pécsi utca`, `addr:city=Kozármisleny`, `addr:postcode=7761` |
| Koordináta | 46.0475288, 18.2849888 |
| Épületkontúr | [way 827697105](https://www.openstreetmap.org/way/827697105) – `building=yes`, `addr:street=Pécsi utca`, `addr:housenumber=124` |

Kozármisleny területén ez az egyetlen `amenity=townhall` objektum; a
feldolgozó ellenőrzi, hogy a pont a megadott épületkontúron belül van
(`buildingMatch: contains`). A vetítés középpontja ez a pont, a pályán a
(720, 880) koordinátán található.

## Letöltés

| Parancs | Script | Mit tölt le |
|---|---|---|
| `npm run map:fetch` | `scripts/fetch-osm.mjs` | OSM-adat a [`misleny-kozpont.overpassql`](../assets/maps/osm/misleny-kozpont.overpassql) lekérdezéssel |
| `npm run map:buildings` | `scripts/fetch-buildings.mjs` | Microsoft-alaprajzok ugyanarra a téglalapra szűrve |

Lekérdezett téglalap: `46.02379,18.27488,46.05598,18.30235` (a pályánál kb.
60 m-rel nagyobb). A nyilvános Overpass-szerverek gyakran túlterheltek, ezért
a letöltő sokszor újrapróbálkozik; ez percekig is eltarthat.

A jelenlegi adatok:

| | OSM | Microsoft |
|---|---|---|
| Letöltve | 2026-11-19 | 2026-11-19 |
| Az adat állapota | 2026-11-19T14:30:20Z | a csempék feltöltési dátuma: 2026-02-23 |
| Mennyiség | 102 pont, 2121 vonal, 26 reláció | 3229 alaprajz a területen (csempék: 120231221, 120231230) |

A részletek a `assets/maps/osm/*.meta.json` fájlokban vannak.

## Feldolgozás

Script: `scripts/process-map.mjs` (`npm run map:process`)
Kimenet: `assets/maps/processed/misleny-kozpont.json`

1. **Vetítés** – helyi equirectangular közelítés a hivatal pontja körül,
   méterben. Origó a pálya ÉNy-i sarka, x kelet, y dél felé nő.
2. **Vágás** – a sokszögeket (Sutherland–Hodgman) és a vonalakat
   (Liang–Barsky) a pálya téglalapjára vágjuk.
3. **Multipoligonok** – a relációk way-darabjait zárt gyűrűkké fűzzük; ami
   nem zárható, kimarad, és figyelmeztetés készül róla.
4. **Osztályozás** – utak, épületek, területek, patakok, kerítések, fasorok,
   tájékozódási pontok.
5. **Kiegészítő épületek** – lásd lent.
6. **A hivatal épületének megjelölése**, a fotók alapján felvett részletek
   elhelyezése (a forrásfájl a hivatal pontjához viszonyított koordinátákat
   tartalmaz).
7. **Útszélességek, zebrák, generált díszítőelemek** – lásd lent.
8. **Adatminőségi jelzések** – a kimenet `meta.warnings` és `meta.stats`
   mezőjébe kerülnek, és a script a konzolra is kiírja őket.

### Kiegészítő épületek (Microsoft)

Az OpenStreetMapben a város déli és keleti részén alig van épületkontúr: a
250 m-es rácson a 67 utcás cellából 26-ban szinte egy sem volt. Ezért a
feldolgozó a Microsoft műholdképekről, gépi felismeréssel készült
alaprajzaiból pótolja a hiányt.

- Csak az az alaprajz kerül be, amely nem ér hozzá OSM-épülethez, nem esik
  úttestre, és 25–6000 m² közötti. A 3229 alaprajzból így 1198 került a
  pályára; a többi helyén már volt OSM-épület.
- Ezek **valós épületek**, de az OSM-nél pontatlanabbak (a körvonal
  egyszerűsített, előfordulhat téves felismerés vagy összevont épület), és
  nincs típusuk, címük.
- A pótlás után a 67 cellából 10 maradt szinte épület nélkül – ezek többnyire
  mezők között futó utak.

### Útszélességek és utcakeresztmetszet

Az OSM-ben ezen a területen nincs szélességadat, ezért az utak típusonként
rögzített, a játékhoz igazított szélességet kapnak. A közutak kétsávosak: a
3,5 m széles tankból kettő kényelmesen elfér egymás mellett.

| Típus | Szélesség | Legkisebb | Mellette |
|---|---|---|---|
| főút (`primary`, `secondary`) | 13 / 12 m | 9 m | 0,6 m zúzottköves padka, füves sáv fasorral – járda nincs |
| lakóutca (`residential`) | 9,5 m | 7 m | 1,8 m füves sáv, majd 1,2 m járda |
| lakó-pihenő övezet (`living_street`) | 8,5 m | 6,5 m | mint a lakóutcánál |
| összekötő út (`unclassified`) | 9,5 m | 7 m | füves sáv, járda nélkül |
| szervizút (`service`) | 5,5 m | 4 m | – |
| földút (`track`) | 4,5 m | – | – |
| kerékpárút | 3 m | – | szürke aszfalt |
| gyalogút | 2,5 m | – | – |

A főút keresztmetszete a Pécsi utcáról készült fotót követi (kétsávos út
felezővonallal, járda helyett füves sáv és fasor, mellette külön aszfaltos
kerékpárút, betonoszlopok). Ha egy útdarab mentén épület áll közelebb, mint
amennyi helyet az út kér, az útdarab a „legkisebb" értékig szűkül – ez a 427
útdarabból 85-öt érint.

### Zebrák

33 zebra van a pályán: az OSM `highway=crossing` pontjaiból, valamint ott,
ahol az OSM szerint egy gyalogút vagy kerékpárút ténylegesen átmegy egy
közúton (az út tengelyén van pontja, és mindkét oldalon folytatódik). Ez
levezetett adat: ahol az OSM-ben nincs berajzolva az átvezető gyalogút, ott
a játékban sincs zebra, és nem minden így megtalált átkelő biztosan
felfestett zebra a valóságban.

### Generált díszítőelemek

Az OSM-ben alig vannak egyedi fák, bokrok vagy villanyoszlopok, ezért ezeket
a feldolgozó helyezi el, rögzített magú véletlennel (minden futáskor ugyanoda
kerülnek):

- **35 934 fa** – kertekben szórtan, az erdőfoltokban és a központi parkban
  sűrűn, a gyümölcsösökben szabályos sorokban, a főutak mentén mindkét
  oldalon sűrű fasorként, a lakóutcák füves sávjában ritkábban;
- **12 441 bokor** – kertekben, parkokban, a fotókon látható sövényekben;
- **1012 villanyoszlop** – a közutak egyik oldalán kb. 36 méterenként,
  vezetékkel összekötve.

A hivatal mögötti nagy zöldterület az OSM-ben park (`leisure=park`); a
fotókon zárt lombú parkerdő látszik, ezért a 2 hektárnál nagyobb parkokat a
játék sűrűn ülteti be fával, néhány véletlenszerű helyű tisztással.

Szabályok: nem kerül semmi épületbe vagy annak közvetlen közelébe, úttestre,
járdára, vízbe, parkolóba, játszótérre, szántóra. A sűrűség a
területhasználattól függ. A helyük tehát hihető, de nem a valóságot mutatja.

## A feldolgozott fájl tartalma

| Réteg | Darab |
|---|---|
| Épület | 2769 (1571 OSM – ebből 432 típus nélküli –, 1198 Microsoft) |
| Útdarab | 427 (25 főút-darab `primary`, 18 `secondary`, 119 lakóutca, 15 lakó-pihenő övezet, 9 összekötő út, 64 szervizút, 82 földút, 74 gyalogút, 9 kerékpárút, 10 ösvény) |
| Utcanév | 62 |
| Terület | 90 |
| Patak / kerítés | 13 / 11 |
| Fa az OSM-ből (fasor) | 61 |
| Tájékozódási pont | 20 |
| Zebra | 33 |
| Generált fa / bokor / oszlop | 35 934 / 12 441 / 1012 |

## Fotók alapján felvett épületek

Forrásfájl: [`assets/maps/landmarks/misleny-kozpont.landmarks.json`](../assets/maps/landmarks/misleny-kozpont.landmarks.json)
(koordináták a hivatal pontjához képest, méterben). Az épületek alaprajza és
helye mindig az OSM-ből származik; a fotókról a megjelenés került át.

**Polgármesteri Hivatal** (`polghiv.jpg`, `polghiv2.png`)

- narancsvörös cserép, szárnyanként nyeregtető szürke fémszegéllyel; az
  északi, széles oromfalas tömb gerince aszimmetrikus, mellette
  tetőablak-sáv;
- lapos tetejű téglatorony a déli szárny keleti végén;
- térkővel burkolt tér virágágyással, kőpadokkal, lámpákkal és három
  zászlórúddal; gyep a Pécsi utca felé; sövény és aszfaltos udvar parkoló
  autókkal; mögötte erdő.

**Református templom** (`reformtemplom.png`, `reformtemplom2.png`)

- vörös cseréptető fehér falszegéllyel: észak–déli gerincű hajó, kelet felé
  alacsonyabb szárny, toldalék és előtető;
- a délnyugati sarkon négyzetes torony fehér falkoronával és vörös
  gúlasisakkal, hosszú árnyékkal;
- előtte nyírt sövény és oszlopos tuják.

**Rendőrség** (`rendorseg.png`)

- vörösesbarna, kontyolt cseréptető a H alakú alaprajzon;
- előtte gyep, a Pécsi utca mentén fiatal fasor, lámpaoszlopok, a templom
  felé egy nagy lombos fa.

Korlátok: a fotók tájolását az OSM-alaprajzhoz igazítva azonosítottuk (a
hivatalnál a torony a déli szárny keleti végén, a templomnál a torony az
alaprajz délnyugati kiugrásán). A tárgyak helye és mérete szemmértékkel
becsült, nem felmérés; a tetők gerincvonalai az alaprajzból és a fotókból
következtetett közelítések.

## Az épületek megjelenítése

Tetőadat sem az OSM-ben, sem a Microsoft-adatban nincs. A játék a tetőt az
alaprajzból számolja:

- az egyszerű, négyszög alaprajzú házak nagyobb része **nyeregtetőt** kap
  (gerinc a hosszabb oldallal párhuzamosan), a többi **kontyolt tetőt**;
- az összetett (L, T, U alakú) alaprajzoknál a tetősíkok az alaprajz
  egyenes váza szerint alakulnak, gerinccel, élgerinccel és vápával;
- a tetőn az eresszel párhuzamos cserépsorok látszanak, a tetősíkok az
  északnyugati megvilágítás szerint világosabbak vagy sötétebbek;
- a garázsok, melléképületek és a nagy alapterületű épületek lapostetőt
  kapnak;
- a tetőszín a hazai cseréptetők jellemző árnyalataiból (vörös, barna,
  kevés antracit és szürke) kerül ki, épületenként állandó;
- a vetett árnyék hossza az épület típusából becsült magasságot követi.

A tető formája és színe tehát **becslés** – kivéve a fenti három,
fotó alapján felvett épületet.

## Ismert korlátok és hiányosságok

- **Nem méretarányos, nem geodéziai pontosságú.** Az épületek és utak
  egymáshoz viszonyított helyzete az adatforrásokat követi, de a vetítés
  egyszerű közelítés, az útszélességek pedig stilizáltak.
- **Az épületadat két forrásból áll össze**, eltérő pontossággal; a
  Microsoft-alaprajzok között lehet téves vagy hiányzó épület. Ami egyik
  forrásban sem szerepel, az a pályán sincs – kitalált épület nincs.
- **84 közút-darabnak nincs neve** az OSM-ben (részben csomóponti ágak,
  rövid összekötők), ezekre nem kerül utcanév.
- **Kerítés alig van az adatban** (11 db), ezért a kertek a játékban
  átjárhatók.
- A területhasználati foltok egy része (lakóterület, erdő, szántó) régi,
  durva felbontású CLC-adatból származik, ezért a határaik pontatlanok.
- Személyes adat nem kerül a pályafájlba: a tájékozódási pontoknál csak a
  közintézmény típusa és neve marad meg (elérhetőségek, nyitvatartás nem).

## Frissítés

```bash
npm run map          # OSM + kiegészítő épületek letöltése, majd feldolgozás
npm run map:process  # csak feldolgozás a meglévő nyers adatokból
npm test             # a pályafájl ellenőrzése is lefut
```
