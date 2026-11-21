// A főgonosz (a Vasóriás) és a testőrei: a szabályok számai. Tiszta adat, importok nélkül –
// a szimuláció (world.ts, boss.ts) és a megjelenítés is innen veszi őket.

/** A tank szerepe: közönséges tank (játékos vagy bot), a főgonosz, vagy az egyik testőre. */
export const ROLE = { tank: 0, boss: 1, guard: 2 } as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];

/** A főgonosz csapatához tartozik-e (a boss vagy egy testőre). */
export const isPack = (tank: { role?: number }): boolean => (tank.role ?? ROLE.tank) !== ROLE.tank;

export const BOSS = {
  name: 'Vasóriás',
  guardName: 'Testőr',
  /** a boss a 20. szintű tank méretének ennyiszerese, és ennyiszer annyi az életereje */
  level: 20,
  sizeMult: 1.5,
  hpMult: 10,
  /** a boss két lövése között (mp): ritkán, de nagyon nagyot lő (nehéz lövedék, 20. szinten) */
  fireInterval: 2.6,
  /** a testőrök szintje (romboló) és a sebzésük szorzója (kicsit gyengébben lőnek, mint egy ilyen szintű játékos) */
  guardLevel: 12,
  guardDamage: 0.7,
  /** testőrök száma; riadókor ennyien üldözik a támadót, a többi a bossnál marad */
  guards: 4,
  chasers: 2,
  /** a testőrök ilyen messze (m) állnak körben a boss körül */
  ring: 18,
  /** a boss a tanyája közepétől legfeljebb ennyire (m) mozdul el; ennyi időnként (mp) választ új helyet */
  wander: 12,
  wanderEvery: 8,
  /** a boss lassan mozog (a gáz legfeljebb ennyi), a testőrök majdnem teljes sebességgel */
  bossSpeed: 0.25,
  guardSpeed: 0.85,
  /** a boss csak védekezik: magától csak azt lövi, aki ennyire (m) megközelíti */
  defend: 25,
  /** a bossnál maradó testőrök ennyin (m) belül támadnak */
  guardDefend: 45,
  /** az üldöző testőrök a tanyától legfeljebb ennyire (m) mennek el, aztán visszafordulnak */
  leash: 150,
  /** a riadó ennyi ideig (mp) tart az utolsó támadás után */
  alarm: 20,
  /** gyógyulás: ha ennyi ideig (mp) nem éri találat, a legnagyobb életereje ennyi részét kapja vissza másodpercenként */
  healDelay: 30,
  healRate: 0.005,
  /** jutalom: aki legyőzi, ennyi szintet lép; aki legalább `helperShare` részét lebontotta, `helperReward` szintet */
  reward: 10,
  helperShare: 0.1,
  helperReward: 2,
  /** csak ilyen hosszú (perc) vagy hosszabb meccsben, és legalább ekkora játéktéren (km²) jön */
  minMinutes: 10,
  minKm2: 0.2,
  /** az első megjelenés ideje a meccs kezdetétől (mp), az újabbaké a legyőzéstől */
  first: [180, 300] as const,
  again: [480, 600] as const,
  /** csak akkor jön, ha a megjelenésétől még legalább ennyi (mp) van hátra a meccsből */
  minLeft: 300,
  /** ennyivel (mp) előbb jelenti be a játék */
  warn: 20,
  /** a tanya a játékosoktól legalább ennyire (m) legyen; és ennyi szabad hely (m) legyen körülötte minden irányban */
  clearPlayers: 150,
  clearWalls: 9,
  /** a kilőtt boss és testőrök roncsa marad; a tankjuk ennyi idő (mp) múlva eltűnik */
  removeAfter: 6,
} as const;

/** Jöhet-e főgonosz ebben a meccsben: elég hosszú (vagy nyitott) játék, elég nagy játéktéren. */
export function bossAllowed(minutes: number, endless: boolean, areaKm2: number): boolean {
  return (endless || minutes >= BOSS.minMinutes) && areaKm2 >= BOSS.minKm2;
}
