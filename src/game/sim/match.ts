// Egy meccs szabályai a szimuláció fölött: a szoba beállításaiból kiszámolja a
// tényleges létszámokat, elhelyezi a játékosokat és a botokat, lépteti a
// világot, méri a játékidőt, és a végén megmondja, ki nyert. Tiszta logika
// (nincs hálózat, nincs DOM) – a szerver futtatja, a tesztek Node alatt ellenőrzik.
//
// Játékmód: jelenleg egy van, az időre menő „deathmatch” – mindenki mindenki
// ellen, a kilőtt tank újraéled, és az nyer, aki az idő lejártáig a legtöbb
// tankot lövi ki. A mód a beállítások része, hogy később több is lehessen.

import { BOT_LEVELS, BotManager, botTuning, SKILL_LEVELS } from './bots';
import { BARREL, SUPER, WORKSHOP } from './gadgets';
import { Traffic } from './traffic';
import { ANY_PLAYER, BOT_TOUGHNESS_LEVELS, botRules, cleanLook, SPAWN_ANGLE, TEAM, tankMaxHp, World, type TankInput, type TankState, type Terrain, type Weather } from './world';

export interface Area {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const GAME_MODES = ['deathmatch'] as const;
/** deathmatch: időre megy, mindenki mindenki ellen, a legtöbb kilövés nyer */
export type GameMode = (typeof GAME_MODES)[number];

/** A játékmódok neve és egysoros leírása (a létrehozó képernyőn ebből lehet választani). */
export const GAME_MODE_NAME: Record<GameMode, string> = {
  deathmatch: 'Death Match',
};
export const GAME_MODE_HINT: Record<GameMode, string> = {
  deathmatch: 'Mindenki mindenki ellen: az nyer, aki az idő lejártáig a legtöbb tankot lövi ki. A kilőtt tank újraéled.',
};

/** A szoba létrehozójának beállításai. A szintek 0–5 közötti csúszkák. */
export interface MatchSettings {
  name: string;
  mode: GameMode;
  /** a játéktér a pályán, méterben (a rács celláihoz igazítva) */
  area: Area;
  maxPlayers: number;
  /** a játékidő percben */
  minutes: number;
  /** botok szintje: 0 = nincs, 5 = nagyon sok – a tényleges szám a pálya méretétől függ */
  bots: number;
  /** a botok ügyessége (1–5): célzás pontossága, reakcióidő, tűzgyorsaság */
  botSkill: number;
  /** a botok agresszivitása (1–5): milyen messziről vesznek észre, meddig üldöznek, vadásznak-e a játékosokra */
  botAggression: number;
  /** a botok szívóssága (1–5): minél szívósabb, annál erősebb a páncélja és annál nagyobbat lő */
  botToughness: number;
  /** felvehető tárgyak szintje, ugyanígy */
  pickups: number;
  /** a civil forgalom szintje (autók, buszok, ellátó teherautók); 0 = nincs */
  traffic: number;
  weather: Weather;
}

export const MATCH = {
  /** a pályakijelölő rács cellamérete méterben (kb.) */
  cell: 83,
  /** a kijelölt terület legalább ekkora legyen mindkét irányban (cella) – kb. 165 m, kétfős párbajhoz */
  minCells: 2,
  /** ekkora terület (km²) alatt a botok és a járművek legkisebb száma is csökken */
  fullArea: 0.25,
  players: { min: 1, max: 8 },
  /** a játékidő határai és a csúszka lépésköze (perc) */
  minutes: { min: 5, max: 30, step: 5, normal: 10 },
  levels: { min: 0, max: 5 },
  /** botok száma szintenként és négyzetkilométerenként; legfeljebb ennyi lehet összesen */
  botsPerKm2: 3,
  maxBots: 100,
  /** tárgyak száma szintenként és négyzetkilométerenként */
  pickupsPerKm2: 17,
  maxPickups: 600,
  /** járművek száma szintenként és négyzetkilométerenként (a forgalom gyér) */
  trafficPerKm2: 4,
  maxTraffic: 60,
  /** a meccs indulása előtti visszaszámlálás (mp) */
  countdown: 3,
} as const;

export const WEATHERS: readonly Weather[] = ['day', 'rain', 'night'];

/**
 * Amit a játékos a nyitott játékban megtart, ha kilép és rövidesen visszalép, vagy ha a
 * játékot módosítják (új pálya): a szintje, az eredményei és a felszerelése.
 */
export const CARRY_KEYS = ['level', 'kills', 'deaths', 'streak', 'bestStreak', 'botKills', 'weapon', 'tripleShots', 'ricochet', 'shield', 'oil', 'mines', 'smokes', 'strikes', 'turrets', 'fuel', 'shots', 'hits', 'dealt', 'taken', 'wrecked'] as const;
export type Carry = Pick<TankState, (typeof CARRY_KEYS)[number]>;

/** A nyitott játék: korlátlan ideig fut, bárki bármikor beléphet; a gazdája adja meg, legfeljebb hányan (2–100). */
export const DEMO = { minPlayers: 2, maxPlayers: 100 } as const;

/** A nyitott játék létszáma a (nem megbízható) kérésből: egész szám a két határ között; ha hiányzik, a legnagyobb. */
export function demoPlayers(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? clamp(Math.round(raw), DEMO.minPlayers, DEMO.maxPlayers) : DEMO.maxPlayers;
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
const int = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback);

/** A pályakijelölő rács mérete (cellákban) adott pályamérethez. */
export function gridSize(mapWidth: number, mapHeight: number): { cols: number; rows: number } {
  return { cols: Math.max(1, Math.round(mapWidth / MATCH.cell)), rows: Math.max(1, Math.round(mapHeight / MATCH.cell)) };
}

/** A rács cellatartományából (a végpontokat is beleértve) a játéktér méterben. */
export function areaOfCells(mapWidth: number, mapHeight: number, c0: number, r0: number, c1: number, r1: number): Area {
  const { cols, rows } = gridSize(mapWidth, mapHeight);
  const cw = mapWidth / cols;
  const ch = mapHeight / rows;
  const [ca, cb] = [clamp(Math.min(c0, c1), 0, cols - 1), clamp(Math.max(c0, c1), 0, cols - 1)];
  const [ra, rb] = [clamp(Math.min(r0, r1), 0, rows - 1), clamp(Math.max(r0, r1), 0, rows - 1)];
  return { minX: Math.round(ca * cw), minY: Math.round(ra * ch), maxX: Math.round((cb + 1) * cw), maxY: Math.round((rb + 1) * ch) };
}

/**
 * A (nem megbízható forrásból érkező) beállítások ellenőrzése: minden érték a
 * megengedett határok közé kerül, a terület a pályán belülre és legalább a
 * legkisebb méretre.
 */
export function sanitizeSettings(raw: Partial<MatchSettings> | null | undefined, mapWidth: number, mapHeight: number): MatchSettings {
  const r = raw ?? {};
  const a = (r.area ?? {}) as Partial<Area>;
  const min = Math.round(MATCH.cell * MATCH.minCells * 0.9);
  let minX = clamp(int(a.minX, 0), 0, mapWidth);
  let minY = clamp(int(a.minY, 0), 0, mapHeight);
  let maxX = clamp(int(a.maxX, mapWidth), 0, mapWidth);
  let maxY = clamp(int(a.maxY, mapHeight), 0, mapHeight);
  if (maxX - minX < min) {
    minX = clamp(minX, 0, Math.max(0, mapWidth - min));
    maxX = Math.min(mapWidth, minX + min);
  }
  if (maxY - minY < min) {
    minY = clamp(minY, 0, Math.max(0, mapHeight - min));
    maxY = Math.min(mapHeight, minY + min);
  }
  const name = typeof r.name === 'string' ? r.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 28) : '';
  return {
    name: name || 'Névtelen játék',
    mode: GAME_MODES.includes(r.mode as GameMode) ? (r.mode as GameMode) : 'deathmatch',
    area: { minX, minY, maxX, maxY },
    maxPlayers: clamp(int(r.maxPlayers, 4), MATCH.players.min, MATCH.players.max),
    minutes: clamp(int(r.minutes, MATCH.minutes.normal), MATCH.minutes.min, MATCH.minutes.max),
    bots: clamp(int(r.bots, 2), MATCH.levels.min, MATCH.levels.max),
    botSkill: clamp(int(r.botSkill, SKILL_LEVELS.normal), SKILL_LEVELS.min, SKILL_LEVELS.max),
    botAggression: clamp(int(r.botAggression, BOT_LEVELS.normal), BOT_LEVELS.min, BOT_LEVELS.max),
    botToughness: clamp(int(r.botToughness, BOT_TOUGHNESS_LEVELS.normal), BOT_TOUGHNESS_LEVELS.min, BOT_TOUGHNESS_LEVELS.max),
    pickups: clamp(int(r.pickups, 3), MATCH.levels.min, MATCH.levels.max),
    traffic: clamp(int(r.traffic, 2), MATCH.levels.min, MATCH.levels.max),
    weather: WEATHERS.includes(r.weather as Weather) ? (r.weather as Weather) : 'day',
  };
}

export interface MatchPlan {
  /** a játéktér területe km²-ben */
  km2: number;
  bots: number;
  pickups: number;
  /** a civil járművek száma */
  traffic: number;
  /** a házak mellé kerülő gázpalackok száma */
  barrels: number;
  /** a javítóműhelyek száma */
  workshops: number;
  /** a játékosok ennyire születnek egymástól (m) */
  spawnGap: number;
}

/** A csúszkák szintjeiből és a pálya méretéből a tényleges létszámok. */
export function matchPlan(settings: MatchSettings): MatchPlan {
  const w = settings.area.maxX - settings.area.minX;
  const h = settings.area.maxY - settings.area.minY;
  const km2 = (w * h) / 1e6;
  // kis pályán a legkisebb létszám is kisebb, hogy egy képernyőnyi arénában ne legyen tömeg
  const share = km2 / MATCH.fullArea;
  const minBots = Math.max(1, Math.round(settings.bots * clamp(0.5 + share / 2, 0.5, 1)));
  const minTraffic = Math.max(1, Math.round((settings.traffic + 1) * clamp(share, 0.2, 1)));
  const bots = settings.bots === 0 ? 0 : clamp(Math.round(settings.bots * MATCH.botsPerKm2 * km2), minBots, MATCH.maxBots);
  const pickups = settings.pickups === 0 ? 0 : clamp(Math.round(settings.pickups * MATCH.pickupsPerKm2 * km2), settings.pickups * 2, MATCH.maxPickups);
  // minél kisebb a pálya és minél többen vannak, annál közelebb kell születniük
  const spawnGap = clamp(Math.sqrt((w * h) / Math.max(2, settings.maxPlayers)) * 0.6, 40, 220);
  const traffic = settings.traffic === 0 ? 0 : clamp(Math.round(settings.traffic * MATCH.trafficPerKm2 * km2), minTraffic, MATCH.maxTraffic);
  const barrels = clamp(Math.round(km2 * BARREL.perKm2), BARREL.min, BARREL.max);
  const workshops = clamp(Math.round(km2 * WORKSHOP.perKm2), WORKSHOP.min, WORKSHOP.max);
  return { km2, bots, pickups, traffic, barrels, workshops, spawnGap: Math.round(spawnGap) };
}

export interface MatchPlayer {
  /** a kapcsolat (játékos) azonosítója */
  id: string;
  name: string;
  tankId: number;
  /** a választott alaptank (csak megjelenés) */
  look: number;
  /** kilépett vagy megszakadt a kapcsolata */
  gone: boolean;
}

export interface MatchStanding {
  id: string;
  name: string;
  /** helyezés (holtversenyben azonos) */
  place: number;
  kills: number;
  deaths: number;
  level: number;
  gone: boolean;
  /** a leghosszabb kilövéssorozat halál nélkül */
  streak: number;
  /** ennyi épületet döntött össze */
  wrecked: number;
  /** a lövések pontossága százalékban (−1: nem lőtt) */
  accuracy: number;
  /** leadott lövések és találatok */
  shots: number;
  hits: number;
  /** az ellenséges tankoknak okozott, illetve az elszenvedett sebzés */
  damage: number;
  taken: number;
  /** teljesítménypont a statisztikákból (lásd matchScore) */
  score: number;
  /** a meccs legjobbja: a legtöbb teljesítménypontot gyűjtő, bent maradt játékos (több játékosnál) */
  mvp: boolean;
}

type Final = Pick<MatchStanding, 'kills' | 'deaths' | 'level' | 'streak' | 'wrecked' | 'accuracy' | 'shots' | 'hits' | 'damage' | 'taken'>;

/** A teljesítménypont összetevői. */
export const SCORE = {
  kill: 100,
  death: -50,
  /** az okozott sebzés minden pontja */
  damage: 0.3,
  /** a leghosszabb, halál nélküli kilövéssorozat minden tagja */
  streak: 20,
  /** a pontosság minden százaléka – csak ha legalább ennyi lövést leadott */
  accuracy: 1,
  accuracyShots: 10,
  /** ledöntött házanként, de legfeljebb ennyi */
  wrecked: 10,
  wreckedMax: 100,
  /** a meccs végi szint minden foka az első fölött */
  level: 15,
} as const;

/**
 * Teljesítménypont: nem csak a kilövések száma számít, hanem az is, mennyit sebzett,
 * milyen pontosan lőtt, milyen sorozatot ért el, és hányszor lőtték ki. Nullánál kevesebb nem lehet.
 */
export function matchScore(s: Final): number {
  const points =
    s.kills * SCORE.kill +
    s.deaths * SCORE.death +
    s.damage * SCORE.damage +
    s.streak * SCORE.streak +
    (s.shots >= SCORE.accuracyShots && s.accuracy > 0 ? s.accuracy * SCORE.accuracy : 0) +
    Math.min(SCORE.wreckedMax, s.wrecked * SCORE.wrecked) +
    (s.level - 1) * SCORE.level;
  return Math.max(0, Math.round(points));
}

const finalOf = (tank: TankState): Final => ({
  kills: tank.kills,
  deaths: tank.deaths,
  level: tank.level,
  streak: tank.bestStreak,
  wrecked: tank.wrecked,
  accuracy: tank.shots > 0 ? Math.min(100, Math.round((tank.hits / tank.shots) * 100)) : -1,
  shots: tank.shots,
  hits: tank.hits,
  damage: Math.round(tank.dealt),
  taken: Math.round(tank.taken),
});

/** A játékosok csapatszáma: mindenki külön csapat (mindenki mindenki ellen). */
const PLAYER_TEAM = 10;

export class Match {
  readonly world: World;
  readonly bots: BotManager;
  readonly traffic: Traffic;
  readonly plan: MatchPlan;
  readonly players: MatchPlayer[] = [];
  /** a hátralévő játékidő másodpercben */
  timeLeft: number;
  over = false;
  /** a győztes játékos azonosítója (null: nincs – döntetlen, egyedül játszott, vagy mindenki kilépett) */
  winner: string | null = null;
  private readonly inputs = new Map<number, TankInput>();
  private readonly finals = new Map<string, Final>();
  /** a következő szupertárgyig hátralévő idő (mp), és a helye, ha már be van jelentve */
  private superIn: number = SUPER.every;
  private superSpot: { x: number; y: number } | null = null;
  /** a következő belépő csapatszáma (mindenki külön csapat) */
  private nextTeam = 0;

  /**
   * `terrain`: a pálya, amelyen a játéktér (bounds) és az időjárás már be van
   * állítva. `entrants`: a szobában lévő játékosok.
   */
  constructor(
    terrain: Terrain,
    readonly settings: MatchSettings,
    entrants: readonly { id: string; name: string; look?: number }[],
    seed: number,
    /** nyitott játék: nincs időkorlát, bárki beléphet és kiléphet, és a meccs nem ér véget magától */
    readonly endless = false,
  ) {
    this.plan = matchPlan(settings);
    this.timeLeft = endless ? Infinity : settings.minutes * 60;
    // az életek száma korlátlan: a kilőtt tank néhány másodperc múlva újraéled
    this.world = new World(terrain, seed, { weather: settings.weather, lives: 0, spawnGap: this.plan.spawnGap });
    this.world.scatterWorkshops(this.plan.workshops);
    // a játékosok egymástól távol, véletlen helyen születnek
    for (const entrant of entrants) this.addPlayer(entrant.id, entrant.name, entrant.look);
    this.world.botRules = botRules(settings.botToughness, settings.botSkill);
    this.bots = new BotManager(this.world, botTuning(settings.botSkill, settings.botAggression));
    this.bots.setCount(this.plan.bots, TEAM.bots, ANY_PLAYER);
    this.world.scatterPickups(this.plan.pickups);
    // a műhelyek előbb kerülnek ki, hogy a tárgyak és a palackok ne essenek beléjük
    this.world.scatterBarrels(this.plan.barrels);
    this.traffic = new Traffic(this.world, this.plan.traffic);
    this.world.traffic = this.traffic;
  }

  /** Új játékos a meccsben (induláskor, illetve a nyitott játékba menet közben): egymástól távol, véletlen helyen születik. */
  addPlayer(id: string, name: string, look?: number, carry?: Carry | null): MatchPlayer {
    const { area } = this.settings;
    const spot = this.world.spawnSpot() ?? { x: (area.minX + area.maxX) / 2, y: (area.minY + area.maxY) / 2 };
    // a játékos tankja a térkép teteje felé néz
    const tank = this.world.addTank(spot.x, spot.y, SPAWN_ANGLE, { team: PLAYER_TEAM + this.nextTeam++, look: cleanLook(look) });
    // a megőrzött szint és felszerelés (nyitott játékba visszalépve), teljes életerővel
    if (carry) {
      Object.assign(tank, carry);
      tank.hp = tankMaxHp(tank);
    }
    const player: MatchPlayer = { id, name, tankId: tank.id, look: tank.look, gone: false };
    this.players.push(player);
    return player;
  }

  /** A játékos megőrizendő állapota (szint, eredmények, felszerelés), vagy null, ha nincs tankja. */
  carry(id: string): Carry | null {
    const tank = this.tankOf(id);
    if (!tank) return null;
    const out: Record<string, unknown> = {};
    for (const key of CARRY_KEYS) out[key] = tank[key];
    return out as unknown as Carry;
  }

  player(id: string): MatchPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  tankOf(id: string): TankState | undefined {
    const player = this.player(id);
    return player ? this.world.tank(player.tankId) : undefined;
  }

  /** Egy szimulációs lépés; `inputs`: játékosazonosító → bemenet. */
  step(inputs: ReadonlyMap<string, TankInput>): void {
    if (this.over) return;
    this.inputs.clear();
    for (const p of this.players) {
      const input = inputs.get(p.id);
      if (input && !p.gone) this.inputs.set(p.tankId, input);
    }
    this.bots.update(this.inputs, 1 / 60);
    this.world.step(this.inputs);
    this.stepSuper(1 / 60);
    if (this.endless) return;
    this.timeLeft -= 1 / 60;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.finish();
    }
  }

  /** A szupertárgy: időnként megjelenik a játéktér közepén; előtte bejelentés megy mindenkinek. */
  private stepSuper(dt: number): void {
    const { world } = this;
    this.superIn -= dt;
    if (!this.superSpot && this.superIn <= SUPER.warn) {
      const { area } = this.settings;
      this.superSpot = world.nearestSpot((area.minX + area.maxX) / 2, (area.minY + area.maxY) / 2);
      world.events.push({ type: 'superSoon', x: this.superSpot.x, y: this.superSpot.y, seconds: SUPER.warn });
    }
    if (this.superIn > 0 || !this.superSpot) return;
    // egyszerre csak egy van a pályán: a fel nem vett előző eltűnik
    for (let i = world.pickups.length - 1; i >= 0; i--) if (world.pickups[i].kind === 'super') world.pickups.splice(i, 1);
    world.addPickup('super', this.superSpot.x, this.superSpot.y).extra = true;
    world.events.push({ type: 'superHere', x: this.superSpot.x, y: this.superSpot.y });
    this.superSpot = null;
    this.superIn = SUPER.every;
  }

  /** A játékos kilépett: a tankja eltűnik, az addigi eredménye megmarad. */
  leave(id: string): void {
    const p = this.player(id);
    if (!p || p.gone) return;
    p.gone = true;
    const tank = this.world.tank(p.tankId);
    if (tank) this.finals.set(p.id, finalOf(tank));
    this.world.removeTank(p.tankId);
    // nyitott játék: a kilépett játékos egyszerűen eltűnik (az állásból is), a játék megy tovább
    if (this.endless) {
      this.players.splice(this.players.indexOf(p), 1);
      this.finals.delete(p.id);
      return;
    }
    // ha egy többjátékos meccsben már csak egy játékos maradt (vagy senki), nincs kivel játszani: vége
    const present = this.players.filter((q) => !q.gone);
    if (this.over || present.length > (this.players.length > 1 ? 1 : 0)) return;
    this.over = true;
    this.winner = present.length === 1 && this.players.length > 1 ? present[0].id : null;
  }

  /** Lejárt az idő: az nyer, aki a legtöbb tankot lőtte ki (holtversenyben nincs győztes). */
  private finish(): void {
    if (this.over) return;
    this.over = true;
    const present = this.standings().filter((s) => !s.gone);
    // egyedül játszva nincs kit legyőzni: az eredmény a kilövések száma
    if (this.players.length < 2 || present.length === 0) return;
    const [first, second] = present;
    if (!second || first.kills > second.kills || first.deaths < second.deaths) this.winner = first.id;
  }

  /** Az állás: a kilövések száma szerint; egyenlőségnél az áll előrébb, akit kevesebbszer lőttek ki. A kilépettek a végén. */
  standings(): MatchStanding[] {
    const list = this.players
      .map((p) => {
        // a kilépett játékos tankja már nincs a világban: az utolsó állása számít
        const live = this.world.tank(p.tankId);
        const final: Final = (live ? finalOf(live) : this.finals.get(p.id)) ?? { kills: 0, deaths: 0, level: 1, streak: 0, wrecked: 0, accuracy: -1, shots: 0, hits: 0, damage: 0, taken: 0 };
        return { id: p.id, name: p.name, place: 0, gone: p.gone, ...final, score: matchScore(final), mvp: false };
      })
      // a kilépettek a bent lévők mögé kerülnek
      .sort((a, b) => Number(a.gone) - Number(b.gone) || b.kills - a.kills || a.deaths - b.deaths);
    list.forEach((s, i) => {
      const prev = list[i - 1];
      s.place = prev && prev.gone === s.gone && prev.kills === s.kills && prev.deaths === s.deaths ? prev.place : i + 1;
    });
    // a meccs legjobbja: a legtöbb pontot gyűjtő, bent maradt játékos (egyenlőségnél az előrébb álló)
    if (list.length > 1) {
      const best = list.filter((s) => !s.gone).sort((a, b) => b.score - a.score)[0];
      if (best && best.score > 0) best.mvp = true;
    }
    return list;
  }
}
