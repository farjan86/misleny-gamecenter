// A lerakható és a pályán lévő robbanó, takaró eszközök adatai: akna, füst,
// tüzérségi csapás, gázpalack, szupertárgy. Tiszta adat – a működésük a
// world.ts-ben van, a megjelenítésük a GameScene-ben.

/** Akna: a tank mögé rakható, az ellenfél alatt robban. */
export const MINE = {
  /** az ellenséges tank ekkora távolságból (a saját sugarán felül) indítja be (m) */
  trigger: 0.9,
  /** lerakás után ennyi idő múlva élesedik (mp) */
  arm: 1.2,
  blastRadius: 6.5,
  damage: 70,
  /** ennyi idő után magától eltűnik (mp) */
  life: 180,
  /** egy tárgy ennyi aknát ad; ennyi lehet egyszerre a tanknál, illetve kirakva */
  perPickup: 2,
  max: 4,
  maxPlaced: 6,
} as const;

export interface MineState {
  id: number;
  owner: number;
  team: number;
  x: number;
  y: number;
  /** az élesedésig hátralévő idő (mp) */
  arm: number;
  life: number;
  /** ha egy közeli robbanás beindította: ennyi idő múlva robban (−1: nincs beindítva) */
  fuse: number;
}

/** Füst: néhány másodpercre eltakar egy területet; a botok és az ágyúk nem látnak be. */
export const SMOKE = {
  /** a szétterjedt felhő sugara (m) */
  radius: 30,
  /** a felhő ekkora résszel indul, és `spread` másodperc alatt terjed szét a teljes méretére */
  startRatio: 0.3,
  spread: 4.5,
  life: 16,
  /** a szél sodrása (m/s): a felhő lassan elvonul onnan, ahol kieresztették */
  windX: 0.6,
  windY: -0.25,
  perPickup: 2,
  max: 4,
} as const;

/** A füstfelhő kora másodpercben. */
export const smokeAge = (s: SmokeState): number => SMOKE.life - s.life;
/** A felhő sugara a kora szerint: gyorsan gomolyog ki, aztán egyre lassabban terjed. */
export function smokeRadius(age: number): number {
  const g = Math.min(1, Math.max(0, age / SMOKE.spread));
  return SMOKE.radius * (SMOKE.startRatio + (1 - SMOKE.startRatio) * (1 - (1 - g) * (1 - g)));
}
/** Benne van-e a pont a (széllel elsodródott, éppen ekkora) felhőben. */
export function insideSmoke(s: SmokeState, x: number, y: number): boolean {
  const age = SMOKE.life - s.life;
  const dx = x - (s.x + SMOKE.windX * age);
  const dy = y - (s.y + SMOKE.windY * age);
  const r = smokeRadius(age);
  return dx * dx + dy * dy < r * r;
}

export interface SmokeState {
  id: number;
  x: number;
  y: number;
  life: number;
}

/** Tüzérségi csapás: kilövéssorozatért jár; a kijelölt helyre lövedékek hullanak. */
export const STRIKE = {
  /** ennyi kilövésenként jár egy (halál nélkül) */
  every: 3,
  /** ennyi lehet egyszerre a tanknál */
  max: 2,
  /** a kérés után ennyivel érkezik az első lövedék (mp) – addig figyelmeztető jel látszik */
  delay: 2.2,
  shells: 8,
  /** a lövedékek ekkora körbe hullanak (m), ennyi időnként (mp) */
  spread: 13,
  interval: 0.26,
  blastRadius: 7,
  damage: 60,
  /** az épületeket ennyivel sebzi egy lövedék */
  structureDamage: 90,
} as const;

export interface StrikeState {
  id: number;
  owner: number;
  team: number;
  x: number;
  y: number;
  delay: number;
  shells: number;
  next: number;
}

/** Gázpalack, üzemanyaghordó a házak mellett: találattól vagy ráhajtástól felrobban, a közelieket is beindítja. */
export const BARREL = {
  radius: 0.8,
  blastRadius: 8.5,
  damage: 55,
  /** a láncreakció késése: a robbanás ennyi idő múlva indítja be a közelit (mp) */
  chainDelay: 0.16,
  /** darab négyzetkilométerenként, a két határ között */
  perKm2: 30,
  min: 4,
  max: 140,
} as const;

export interface BarrelState {
  id: number;
  x: number;
  y: number;
  /** a robbanásig hátralévő idő (−1: nincs beindítva) */
  fuse: number;
  /** aki beindította (a kilövés neki számít) */
  by: number;
}

/** Szupertárgy: időnként megjelenik a pálya közepén, előre bejelentve. */
export const SUPER = {
  /** ennyi időnként jelenik meg (mp), és ennyivel előtte jön a bejelentés */
  every: 60,
  warn: 10,
  /** a sebzés szorzója, amíg tart */
  power: 3,
} as const;

/**
 * Álcázás: minden tank alapképessége, tárgy nem kell hozzá. Nem láthatatlanság:
 * a tank halvány, vibráló sziluett lesz – aki figyel, észreveszi (a lánctalpa
 * nyoma is megmarad) –, de nincs fölötte életerősáv és név, és a térképen sem
 * látszik. A botok és a telepített ágyúk csak közelről veszik észre.
 */
export const CLOAK = {
  /** ennyi ideig tart (mp); a lövés azonnal megszünteti */
  duration: 10,
  /** a bekapcsolástól ennyi idő múlva használható újra (mp) */
  cooldown: 60,
  /** a botok és a telepített ágyúk csak ennyire közelről veszik észre az álcázott tankot (m) */
  botSight: 20,
} as const;

/**
 * Javítóműhely: néhány áll a pályán, véletlen helyen. Nyitott csarnok – be lehet
 * hajtani, fala nincs –, és amelyik tank benne áll, annak az életereje
 * folyamatosan töltődik, akár teljesen.
 */
export const WORKSHOP = {
  /** a csarnok alapja (m): a legnagyobb tank (kb. 8 m átmérő) is kényelmesen elfér */
  width: 17,
  height: 14,
  /** a tank közepe ezen a körön belül számít bent lévőnek (m) */
  radius: 6.5,
  /** másodpercenként a legnagyobb életerő ekkora részét adja vissza (kb. 12 mp alatt tölt fel teljesen) */
  rate: 0.08,
  /** darab négyzetkilométerenként, a két határ között; két műhely legalább ennyire van egymástól (m) */
  perKm2: 4,
  min: 1,
  max: 12,
  gap: 90,
} as const;

export interface WorkshopState {
  id: number;
  x: number;
  y: number;
}

/** Kiegészítő géppuska (tárgy): a tank oldalán ül, és magától lő a legközelebbi ellenségre. */
export const MG = {
  /** lőtáv (m) és két lövés közötti idő (mp) */
  range: 40,
  interval: 0.13,
  /** sebzés lövésenként (a tank szintje növeli) */
  damage: 2.5,
  /** a géppuska ennyivel ül a tank közepétől jobbra (a tank méretének arányában, m), és ilyen hosszú a csöve */
  side: 1.65,
  barrel: 2.1,
} as const;

/**
 * Lángszóró: fegyver, de nem lövedéket lő – amíg a tűzgomb le van nyomva és van üzemanyag,
 * a cső előtt kúp alakú lángcsóva ég. Messzire visz, és amit elér, azt nagyon sebzi – de az
 * üzemanyaga használat közben fogy, és ha kifogyott, a tank visszakapja az alapágyút. Éget:
 * az ellenséges tankot, löveget, járművet; a fákat felgyújtja és kidönti, a házakat leégeti,
 * a gázpalackot berobbantja. Falon nem megy át.
 */
export const FLAME = {
  /** a láng hossza a cső végétől (m) – messzire visz – és a kúp fél nyílásszöge (rad) */
  range: 42,
  halfAngle: 0.16,
  /** sebzés másodpercenként a tankokon, lövegeken, járműveken; és az épületeken */
  dps: 110,
  structureDps: 150,
  /** a sebzés ilyen időközönként hat (mp) – egy pajzstöltet egy ilyen lökést fog fel */
  pulse: 0.2,
  /** egy tárgy ennyi másodpercnyi üzemanyagot ad; ennyi lehet a tanknál */
  fuel: 10,
  maxFuel: 20,
} as const;

/** A robbanás fajtája (a hangjához és a látványához). */
export type BoomKind = 'mine' | 'barrel' | 'shell';
