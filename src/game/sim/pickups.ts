// Felvehető tárgyak (bónuszok) típusai és szabályai. Tiszta adat és logika,
// a szimuláció része – a megjelenítésük (ikon, név) az entities/pickupStyle.ts-ben van.

export const PICKUP_KINDS = [
  'heavy',
  'triple',
  'rapid',
  'ricochet',
  'rocket',
  'laser',
  'oil',
  'repair',
  'speed',
  'allTerrain',
  'shield',
  'invulnerable',
  'radar',
  'turret',
] as const;
export type PickupKind = (typeof PICKUP_KINDS)[number];
/**
 * Fegyverek: a tanknál egyszerre egy lehet. A felvett fegyver addig marad meg,
 * amíg a tank másikat nem vesz fel, vagy ki nem lövik (utána újra az
 * alaplövedék van).
 */
export const WEAPON_KINDS = ['heavy', 'rocket', 'laser'] as const;
export type WeaponKind = (typeof WEAPON_KINDS)[number];
export const isWeapon = (kind: PickupKind): kind is WeaponKind => (WEAPON_KINDS as readonly string[]).includes(kind);
/** Lövésszámra szóló tárgy: a hármas lövés PICKUP.tripleShots lövésig tart, bármelyik fegyverrel. */
export type AmmoKind = 'triple';
/**
 * Megmaradó képesség: a pattanó lövedék a fegyvertől függetlenül megmarad, amíg
 * a tankot ki nem lövik (az alap- és a nehéz lövedék pattan, a rakéta és a lézer nem).
 */
export type AbilityKind = 'ricochet';
/** Töltetekben számolódnak (pajzs, olaj) vagy azonnal hatnak (javítás). */
export type ChargeKind = 'shield' | 'oil' | 'repair' | 'turret';
/** Az időzített hatások. */
export type TimedKind = Exclude<PickupKind, ChargeKind | WeaponKind | AmmoKind | AbilityKind>;
export const TIMED_KINDS = PICKUP_KINDS.filter((k): k is TimedKind => !isWeapon(k) && k !== 'triple' && k !== 'ricochet' && k !== 'shield' && k !== 'oil' && k !== 'repair' && k !== 'turret');

/**
 * duration: a hatás ideje másodpercben (csak az időzített tárgyaknál; a
 * fegyvereknél, a lövésszámra szóló és a töltetes tárgyaknál 0);
 * weight: milyen gyakran kerül ilyen tárgy a pályára a többihez képest.
 */
export const PICKUPS: Record<PickupKind, { duration: number; weight: number }> = {
  /** nehéz lövedék: nagyobb robbanás, nagyobb lőtáv, dupla sebzés */
  heavy: { duration: 0, weight: 12 },
  /** hármas lövés: egyszerre három lövedék (rakéta, lézersugár) legyezőben, PICKUP.tripleShots lövésig */
  triple: { duration: 0, weight: 12 },
  /** gyorstöltő: jóval rövidebb idő két lövés között */
  rapid: { duration: 15, weight: 10 },
  /** pattanó lövedék: a falról kétszer visszapattan, mielőtt robban; megmaradó képesség */
  ricochet: { duration: 0, weight: 9 },
  /** rakéta: lassan indul, felgyorsul, messzire repül, nagyot robban */
  rocket: { duration: 0, weight: 10 },
  /** lézer: azonnal célba érő sugár, nagy lőtávval */
  laser: { duration: 0, weight: 9 },
  /** olajfolt: lerakható töltetek; aki ráhajt, megcsúszik */
  oil: { duration: 0, weight: 10 },
  /** javítókészlet: azonnal visszaad PICKUP.repairAmount életerőt */
  repair: { duration: 0, weight: 14 },
  /** turbó: nagyobb végsebesség és gyorsulás */
  speed: { duration: 12, weight: 12 },
  /** terepjáró lánctalp: terepen sem lassul a tank, és olajon sem csúszik meg */
  allTerrain: { duration: 25, weight: 7 },
  /** pajzs: egy töltet egy találatot nyel el */
  shield: { duration: 0, weight: 10 },
  /** sebezhetetlenség (olajon sem csúszik meg) */
  invulnerable: { duration: 10, weight: 5 },
  /** radar: a térképeken látszanak a felvehető tárgyak */
  radar: { duration: 30, weight: 8 },
  /** telepíthető ágyú: lerakható töltet; az ágyú magától lő a közeli ellenséges tankokra */
  turret: { duration: 0, weight: 6 },
};

/** Az ellátó teherautó rakománya: fegyverek és képességek. */
export const CARGO_KINDS: readonly PickupKind[] = ['heavy', 'rocket', 'laser', 'ricochet', 'triple', 'shield', 'invulnerable', 'turret'];

export const PICKUP = {
  /** a tárgy sugara méterben (a tank érintésre veszi fel) */
  radius: 1.5,
  /** felvétel után ennyi idővel jelenik meg helyette egy új, máshol (mp) */
  respawnDelay: 12,
  maxShield: 3,
  /** egy hármas lövés tárgy ennyi lövésre elég; több felvéve összeadódik eddig a határig */
  tripleShots: 25,
  maxTripleShots: 75,
  /** egy olajos tárgy ennyi lerakható foltot ad */
  oilPerPickup: 3,
  maxOil: 6,
  /** ennyi telepíthető ágyú lehet egyszerre a tanknál */
  maxTurrets: 2,
  /** a javítókészlet ennyi életerőt ad vissza */
  repairAmount: 50,
  /** két tárgy legkisebb távolsága egymástól (m) */
  minGap: 12,
} as const;

/** A hatások mértéke. */
export const BOOST = {
  speed: 1.45,
  accel: 1.3,
  rapidCooldown: 0.4,
  tripleSpread: 0.14,
  heavySpeed: 1.15,
  heavyLife: 1.4,
  ricochetBounces: 2,
} as const;

export const ROCKET = {
  /** induló sebesség, gyorsulás és végsebesség (m/s, m/s²) */
  startSpeed: 35,
  accel: 150,
  maxSpeed: 120,
  life: 2.0,
  /** a tűzgyorsaság szorzója: a rakéta lassabban tölt */
  cooldown: 1.5,
} as const;

export const LASER = {
  /** lőtáv méterben */
  range: 130,
  cooldown: 0.75,
} as const;

export const OIL = {
  /** a folt sugara méterben */
  radius: 3.4,
  /** ennyi ideig marad az úton (mp) */
  life: 45,
  /** két lerakás között eltelő legkisebb idő (mp) */
  dropCooldown: 0.7,
  /** a megcsúszás ideje (mp) */
  slipTime: 1.7,
  /** ennél lassabban haladva a tank nem csúszik meg (m/s) */
  minSpeed: 4,
  /** csúszás közben ennyivel lassul a tank (m/s²) */
  friction: 5,
} as const;

/** Rögzített magú véletlenszám-generátor: ugyanabból a magból mindig ugyanaz a sorozat. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOTAL_WEIGHT = PICKUP_KINDS.reduce((sum, kind) => sum + PICKUPS[kind].weight, 0);

/** Véletlen tárgytípus a súlyok szerint. */
export function pickKind(rnd: () => number): PickupKind {
  let roll = rnd() * TOTAL_WEIGHT;
  for (const kind of PICKUP_KINDS) {
    roll -= PICKUPS[kind].weight;
    if (roll < 0) return kind;
  }
  return PICKUP_KINDS[0];
}
