// Egy meccs szabályai a szimuláció fölött: a szoba beállításaiból kiszámolja a
// tényleges létszámokat, elhelyezi a játékosokat és a botokat, lépteti a
// világot, méri a játékidőt, és a végén megmondja, ki nyert. Tiszta logika
// (nincs hálózat, nincs DOM) – a szerver futtatja, a tesztek Node alatt ellenőrzik.
//
// Játékmód: jelenleg egy van, az időre menő „deathmatch” – mindenki mindenki
// ellen, a kilőtt tank újraéled, és az nyer, aki az idő lejártáig a legtöbb
// tankot lövi ki. A mód a beállítások része, hogy később több is lehessen.

import { BOT_LEVELS, BotManager, botTuning } from './bots';
import { Traffic } from './traffic';
import { ANY_PLAYER, TEAM, World, type TankInput, type TankState, type Terrain, type Weather } from './world';

export interface Area {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const GAME_MODES = ['deathmatch'] as const;
/** deathmatch: időre megy, mindenki mindenki ellen, a legtöbb kilövés nyer */
export type GameMode = (typeof GAME_MODES)[number];

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
    botSkill: clamp(int(r.botSkill, BOT_LEVELS.normal), BOT_LEVELS.min, BOT_LEVELS.max),
    botAggression: clamp(int(r.botAggression, BOT_LEVELS.normal), BOT_LEVELS.min, BOT_LEVELS.max),
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
  return { km2, bots, pickups, traffic, spawnGap: Math.round(spawnGap) };
}

export interface MatchPlayer {
  /** a kapcsolat (játékos) azonosítója */
  id: string;
  name: string;
  tankId: number;
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
}

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
  private readonly finals = new Map<string, { kills: number; deaths: number; level: number }>();

  /**
   * `terrain`: a pálya, amelyen a játéktér (bounds) és az időjárás már be van
   * állítva. `entrants`: a szobában lévő játékosok.
   */
  constructor(
    terrain: Terrain,
    readonly settings: MatchSettings,
    entrants: readonly { id: string; name: string }[],
    seed: number,
  ) {
    this.plan = matchPlan(settings);
    this.timeLeft = settings.minutes * 60;
    // az életek száma korlátlan: a kilőtt tank néhány másodperc múlva újraéled
    this.world = new World(terrain, seed, { weather: settings.weather, lives: 0, spawnGap: this.plan.spawnGap });
    const { area } = settings;
    entrants.forEach((entrant, i) => {
      // a játékosok egymástól távol, véletlen helyen születnek
      const spot = this.world.spawnSpot() ?? { x: (area.minX + area.maxX) / 2, y: (area.minY + area.maxY) / 2 };
      const tank = this.world.addTank(spot.x, spot.y, this.world.rnd() * Math.PI * 2, { team: PLAYER_TEAM + i });
      this.players.push({ id: entrant.id, name: entrant.name, tankId: tank.id, gone: false });
    });
    this.bots = new BotManager(this.world, botTuning(settings.botSkill, settings.botAggression));
    this.bots.setCount(this.plan.bots, TEAM.bots, ANY_PLAYER);
    this.world.scatterPickups(this.plan.pickups);
    this.traffic = new Traffic(this.world, this.plan.traffic);
    this.world.traffic = this.traffic;
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
    this.timeLeft -= 1 / 60;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.finish();
    }
  }

  /** A játékos kilépett: a tankja eltűnik, az addigi eredménye megmarad. */
  leave(id: string): void {
    const p = this.player(id);
    if (!p || p.gone) return;
    p.gone = true;
    const tank = this.world.tank(p.tankId);
    if (tank) this.finals.set(p.id, { kills: tank.kills, deaths: tank.deaths, level: tank.level });
    this.world.removeTank(p.tankId);
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
        const tank = this.world.tank(p.tankId) ?? this.finals.get(p.id);
        return { id: p.id, name: p.name, place: 0, kills: tank?.kills ?? 0, deaths: tank?.deaths ?? 0, level: tank?.level ?? 1, gone: p.gone };
      })
      // a kilépettek a bent lévők mögé kerülnek
      .sort((a, b) => Number(a.gone) - Number(b.gone) || b.kills - a.kills || a.deaths - b.deaths);
    list.forEach((s, i) => {
      const prev = list[i - 1];
      s.place = prev && prev.gone === s.gone && prev.kills === s.kills && prev.deaths === s.deaths ? prev.place : i + 1;
    });
    return list;
  }
}
