// A feldolgozott pályafájl (assets/maps/processed/*.json) szerkezete.
// Minden koordináta méterben értendő; origó a pálya ÉNy-i sarka, x kelet, y dél felé nő.
// A pontlisták lapított tömbök: [x0, y0, x1, y1, ...].

export interface MapMeta {
  name: string;
  attribution: string;
  /** a kiegészítő adatforrás megjelölése, ha van */
  extraAttribution: string | null;
  /** kézzel (vázlatrajz alapján) felvett házak száma, és hány kiegészítő alaprajzot váltottak ki */
  handBuildings?: { buildings: number; replacedFootprints: number } | null;
  /** generált (kitalált) házak: mely utcákban, hány ház és melléképület */
  generatedHouses?: { streets: string[]; houses: number; outbuildings: number } | null;
  license: string;
  licenseUrl: string;
  osmBaseTimestamp: string | null;
  fetchedAt: string | null;
  processedAt: string;
  center: { lat: number; lon: number; osm: string };
  /** a pálya mérete méterben */
  width: number;
  height: number;
  units: string;
  projection: string;
  note: string;
  /** az utcakeresztmetszet stilizált méretei méterben */
  streetscape: {
    /** padka a főutak mellett */
    shoulder: number;
    /** füves sáv a lakóutca úttestje és a járda között */
    verge: number;
    /** a járda szélessége */
    sidewalk: number;
  };
  warnings: string[];
}

export interface TownhallInfo {
  osm: string;
  name: string | null;
  street: string | null;
  x: number;
  y: number;
  building: string | null;
  buildingId: number | null;
  buildingMatch: 'contains' | 'nearest' | 'none';
  buildingDistance: number;
}

export interface AreaFeature {
  id: number;
  kind: string;
  rings: number[][];
}

export interface LineFeature {
  id: number;
  kind: string;
  pts: number[];
}

export interface StreamFeature extends LineFeature {
  name: string | null;
  width: number;
}

export interface RoadFeature extends LineFeature {
  name: string | null;
  width: number;
  bridge?: boolean;
}

export interface BuildingFeature {
  id: number;
  kind: string;
  area: number;
  pts: number[];
  holes?: number[][];
  townhall?: boolean;
  /**
   * 'ms': nem az OSM-ből, hanem a Microsoft gépi felismerésű alaprajzaiból származik;
   * 'gen': kitalált, a program által generált ház (nem valós alaprajz) – lásd a pálya metaadatát;
   * 'hand': kézzel, vázlatrajz alapján felvett ház (assets/maps/landmarks/*.houses.json)
   */
  src?: 'ms' | 'gen' | 'hand';
}

export interface Poi {
  osm: string;
  kind: string;
  name: string | null;
  x: number;
  y: number;
}

/** Gyalogátkelő (zebra) egy közúton; `angle` az út iránya, `width` az úttest szélessége. */
export interface Crossing {
  x: number;
  y: number;
  angle: number;
  width: number;
  source: 'osm-node' | 'footway-crossing';
}

/** Generált díszítőelemek – NEM OSM-adat. */
export interface Decor {
  generated: true;
  note: string;
  /** lapított: x, y, lombsugár, típus (0 lombos, 1 fenyő, 2 gyümölcsfa, 3 utcai sorfa) */
  trees: number[];
  /** lapított: x, y, sugár */
  bushes: number[];
  /** lapított: x, y */
  poles: number[];
  /** oszlopsoronként egy töröttvonal (vezeték) */
  wires: number[][];
}

/** Nyeregtetős épületrész: a két eresz vonala közt fut a gerinc. */
export interface RoofPart {
  name: string;
  polygon: number[];
  /** az ereszek vonala: [x1, y1, x2, y2] */
  eaveA: number[];
  eaveB: number[];
  /** a gerinc helye az A eresztől mérve (0..1); 0.5 = szimmetrikus tető */
  ridgeAt: number;
  /** tetőablak-sáv a B eresszel párhuzamosan (méterben) */
  skylightBand?: { fromEaveB: number; width: number };
}

/** Torony egy épületen: lapos tetejű tömb vagy gúlasisak. */
export interface LandmarkTower {
  kind: 'flat' | 'spire';
  polygon: number[];
  /** a fal színe (a tömb pereme, illetve a sisak alatti falkorona) */
  wall: string;
  /** a tető, illetve a sisak színe */
  top: string;
  /** a vetett árnyék hossza méterben */
  shadow: number;
}

/** Egy épület fotók alapján felvett megjelenése; az alaprajz az OSM-ből jön. */
export interface LandmarkBuilding {
  /** az épület OSM-azonosítója */
  id: number;
  name: string;
  roofColor: string;
  /** a tető szegélyének színe (fémszegély, fehér fal); elhagyható */
  trimColor?: string;
  /** részek nélkül: az általános tetőrajzoló ezzel a formával dolgozik */
  roofType?: 'hip' | 'gable';
  /** a vetett árnyék hossza méterben */
  shadow?: number;
  parts?: RoofPart[];
  towers?: LandmarkTower[];
  vents?: [number, number][];
}

/**
 * Fotók alapján, kézzel felvett részletek néhány középületről és környezetükről.
 * NEM OSM-adat; a helyek és méretek becsültek.
 */
export interface Landmarks {
  source: string;
  buildings: LandmarkBuilding[];
  areas: { kind: 'lawn' | 'woodland' | 'asphalt' | 'plaza' | 'flowerbed'; ring: number[] }[];
  hedges: number[][];
  benches: { x: number; y: number; angle: number; length: number }[];
  flagpoles: { x: number; y: number; flag: 'city' | 'eu' | 'hungary' }[];
  lamps: [number, number][];
  cars: { x: number; y: number; angle: number; color: string }[];
  /** kézzel felvett fák (a decor.trees listában is szerepelnek) */
  trees: { x: number; y: number; r: number; kind: number }[];
}

export interface MapData {
  meta: MapMeta;
  townhall: TownhallInfo;
  areas: AreaFeature[];
  streams: StreamFeature[];
  roads: RoadFeature[];
  barriers: LineFeature[];
  buildings: BuildingFeature[];
  /** az OSM-ben szereplő fák (fasorok) */
  trees: { x: number; y: number }[];
  pois: Poi[];
  crossings: Crossing[];
  landmarks: Landmarks | null;
  decor: Decor;
}
