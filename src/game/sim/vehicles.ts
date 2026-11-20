// A civil forgalom járműveinek és a telepíthető ágyúnak az adatai és állapota.
// A mozgatásuk a traffic.ts-ben (járművek), a sebzésük és az ütközésük a
// world.ts-ben van. Mértékegységek: méter, másodperc, radián.

export const VEHICLE_KINDS = ['car', 'bus', 'truck'] as const;
/** car: személyautó (többféle forma és szín); bus: autóbusz; truck: ellátó teherautó (rakománnyal) */
export type VehicleKind = (typeof VEHICLE_KINDS)[number];

/** A jármű állapota. */
export const VSTATE = {
  /** közlekedik */
  driving: 0,
  /** kigyulladt: megáll, és a gyújtózsinór végén felrobban */
  burning: 1,
  /** kiégett roncs: akadály, egy idő után eltűnik */
  wreck: 2,
  /** egy magas szintű tank összelapította: át lehet hajtani rajta */
  flat: 3,
} as const;

export interface VehicleSpec {
  length: number;
  width: number;
  /** az ütközési alak: `half` fél hosszúságú szakasz körüli `r` sugarú kapszula */
  r: number;
  half: number;
  /** a lövedékek találatához: a kapszulát lefedő körök közepe a jármű tengelye mentén */
  circles: number[];
  hp: number;
  /** utazósebesség (m/s) */
  cruise: number;
  /** a legkisebb fordulási sugár (m) */
  turnRadius: number;
  /** a kigyulladástól a robbanásig eltelő idő (mp) */
  fuse: number;
  /** a robbanás sugara (m) és a sebzése közvetlen közelben (a szélén ennek 40%-a) */
  blastRadius: number;
  blastDamage: number;
  /** ennyiféle megjelenése van (a `look` értéke 0..looks−1) */
  looks: number;
  /** megsemmisülés után ennyi idővel érkezik helyette új (mp) */
  respawn: number;
}

/** A személyautók formái és színei: a megjelenés sorszáma = forma × CAR_COLORS + szín. */
export const CAR_SHAPES = ['sedan', 'hatchback', 'estate', 'suv', 'van', 'pickup'] as const;
export const CAR_COLORS = 10;
/** A buszok festései. */
export const BUS_LIVERIES = 3;

function spec(length: number, width: number, rest: Omit<VehicleSpec, 'length' | 'width' | 'r' | 'half' | 'circles'>): VehicleSpec {
  const r = width / 2 + 0.05;
  const half = Math.max(0, length / 2 - r);
  const count = Math.max(1, Math.ceil((half * 2) / (r * 1.2)));
  const circles: number[] = [];
  for (let i = 0; i <= count; i++) circles.push(-half + (i / count) * half * 2);
  return { length, width, r, half, circles, ...rest };
}

export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  car: spec(4.4, 1.9, { hp: 20, cruise: 11, turnRadius: 4, fuse: 2.2, blastRadius: 7, blastDamage: 35, looks: CAR_SHAPES.length * CAR_COLORS, respawn: 6 }),
  bus: spec(11, 2.5, { hp: 70, cruise: 8.5, turnRadius: 6.5, fuse: 3, blastRadius: 10, blastDamage: 55, looks: BUS_LIVERIES, respawn: 12 }),
  truck: spec(6.8, 2.4, { hp: 45, cruise: 9.5, turnRadius: 5.5, fuse: 2.6, blastRadius: 8, blastDamage: 40, looks: 1, respawn: 25 }),
};

export const VEHICLE = {
  /** a kiégett roncs ennyi ideig zárja el az utat (mp), az összelapított ennyi ideig látszik */
  wreckLife: 40,
  flatLife: 30,
  /** az égő járművet érő újabb találat után ennyi idő múlva robban (mp) */
  hurry: 0.15,
  /** az ellátó teherautóból ennyi tárgy esik ki */
  cargo: 2,
} as const;

export interface VehicleState {
  id: number;
  kind: VehicleKind;
  /** a megjelenés sorszáma (forma, szín) */
  look: number;
  x: number;
  y: number;
  angle: number;
  speed: number;
  hp: number;
  /** VSTATE */
  state: number;
  /** égő járműnél a robbanásig hátralévő idő, roncsnál a kora (mp) */
  timer: number;
  /** a tank, amelyik felgyújtotta (0: senki) – a robbanás sebzése neki számít */
  by: number;
}

/**
 * Telepíthető löveg (tüzérség): a lerakója csapatában van, és magától lő a közeli
 * ellenséges tankokra. Minden tank kap néhányat alapból, tárggyal több szerezhető.
 * A löveg a gazdája szintjét követi: magasabb szinten szívósabb, messzebbre lát,
 * gyorsabban tüzel, és nagyobbat sebez (a lövedéke a gazda szintje szerint sebez).
 */
export const TURRET = {
  radius: 1.3,
  /** minden (ember vezérelte) tank ennyi löveggel indul, és újraéledve is ennyit kap */
  base: 5,
  /** az 1. szintű löveg életereje, és ennyivel több szintenként */
  hp: 160,
  hpPerLevel: 32,
  /** ilyen messzire lát és lő (m), ha nincs fal az útban; szintenként ennyivel messzebbre */
  range: 55,
  rangePerLevel: 1.5,
  /** két lövés között eltelő idő (mp) az 1. szinten; szintenként ennyi százalékkal gyorsabb a tüzelés */
  fireInterval: 1.0,
  ratePerLevel: 0.06,
  /** a cső forgási sebessége (rad/s) */
  turnRate: 3.2,
  barrelLength: 3.1,
  /** egy játékosnak egyszerre ennyi lövege állhat; az újabb lerakásakor a legrégebbi eltűnik */
  maxPerOwner: 8,
  /** ennyi lépésenként keres új célpontot */
  scanEvery: 6,
} as const;

/** A löveg legnagyobb életereje, lőtávja és tüzelési szünete a gazdája szintje szerint. */
export const turretMaxHp = (level: number): number => TURRET.hp + TURRET.hpPerLevel * (level - 1);
export const turretRange = (level: number): number => TURRET.range + TURRET.rangePerLevel * (level - 1);
export const turretInterval = (level: number): number => TURRET.fireInterval / (1 + TURRET.ratePerLevel * (level - 1));

export interface TurretState {
  id: number;
  /** a lerakó tank azonosítója: a találatai neki számítanak */
  owner: number;
  team: number;
  x: number;
  y: number;
  angle: number;
  hp: number;
  /** a gazda szintje, amelyhez a löveg éppen igazodik */
  level: number;
  cooldown: number;
  /** a kiszemelt tank azonosítója (−1: nincs) */
  target: number;
}
