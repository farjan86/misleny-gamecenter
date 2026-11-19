// TANK MISLENY – a pálya nyers OSM-adatainak lekérdezése.
//
// Középpont: Kozármisleny, Városháza (Polgármesteri Hivatal)
//   OSM node 2608053959  –  46.0475288, 18.2849888
// Kivágás: Kozármisleny beépített területe. A pálya a hivataltól nyugatra
//   720 m-ig, keletre 1280 m-ig, északra 880 m-ig, délre 2580 m-ig tart
//   (2000 × 3460 m); a lekérdezés ennél kb. 60 m-rel nagyobb téglalapot kér,
//   a ráhagyás a szélen átnyúló objektumok miatt kell.
//   A határokat a scripts/process-map.mjs BOUNDS állandója rögzíti – ha az
//   változik, ezt a téglalapot is igazítani kell.
//
// Futtatás: `npm run map:fetch` (scripts/fetch-osm.mjs), vagy bemásolva az
// https://overpass-turbo.eu/ felületre.

[out:json][timeout:180][bbox:46.02379,18.27488,46.05598,18.30235];
(
  // a hivatal objektuma
  node(2608053959);

  // utak, gyalogos átjárók, vasút
  way["highway"];
  way["railway"];
  node["highway"="crossing"];

  // épületkontúrok
  way["building"];
  relation["building"];

  // zöldterületek, területhasználat, vizek, közterek
  way["landuse"];
  relation["landuse"];
  way["leisure"];
  relation["leisure"];
  way["natural"];
  relation["natural"];
  node["natural"="tree"];
  way["waterway"];
  way["place"="square"];
  way["man_made"="bridge"];

  // közintézmények, parkolók, egyéb tájékozódási pontok
  way["amenity"];
  relation["amenity"];
  node["amenity"];
  node["shop"];
  node["tourism"];
  node["historic"];
  way["historic"];

  // kerítések, falak, sövények
  way["barrier"];
);
out geom;
