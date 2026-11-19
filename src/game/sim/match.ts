// Egy többjátékos meccs szabályai a szimuláció fölött: a szoba beállításaiból
// kiszámolja a tényleges létszámokat, elhelyezi a játékosokat és a botokat,
// lépteti a világot, és figyeli, ki esett ki és ki nyert. Tiszta logika (nincs
// hálózat, nincs DOM) – a szerver futtatja, a tesztek Node alatt ellenőrzik.

import { BotManager } from './bots';
import { ANY_PLAYER, TEAM, World, type TankInput, type TankState, type Terrain, type Weather } from './world';

export interface Area {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A szoba létrehozójának beállításai. A szintek 0–5 közötti csúszkák. */
export interface MatchSettings {
  name: string;
  /** a játéktér a pályán, méterben (a rács celláihoz igazítva) */
  area: Area;
  maxPlayers: number;
  /** ennyi élete van egy játékosnak */
  lives: number;
  /** botok szintje: 0 = nincs, 5 = nagyon sok – a tényleges szám a pálya méretétől függ */
  bots: number;
  /** felvehető tárgyak szintje, ugyanígy */
  pickups: number;
  weather: Weather;
}

export const MATCH = {
  /** a pályakijelölő rács cellamérete méterben */
  cell: 250,
  /** a kijelölt terület legalább ekkora legyen mindkét irányban (cella) */
  minCells: 2,
  players: { min: 1, max: 8 },
  lives: [1, 3, 5],
  levels: { min: 0, max: 5 },
  /** botok száma szintenként és négyzetkilométerenként; legfeljebb ennyi lehet összesen */
  botsPerKm2: 3,
  maxBots: 100,
  /** tárgyak száma szintenként és négyzetkilométerenként */
  pickupsPerKm2: 17,
  maxPickups: 600,
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
  const min = MATCH.cell * MATCH.minCells * 0.9;
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
  const lives = int(r.lives, 3);
  const name = typeof r.name === 'string' ? r.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 28) : '';
  return {
    name: name || 'Névtelen játék',
    area: { minX, minY, maxX, maxY },
    maxPlayers: clamp(int(r.maxPlayers, 4), MATCH.players.min, MATCH.players.max),
    lives: (MATCH.lives as readonly number[]).includes(lives) ? lives : 3,
    bots: clamp(int(r.bots, 2), MATCH.levels.min, MATCH.levels.max),
    pickups: clamp(int(r.pickups, 3), MATCH.levels.min, MATCH.levels.max),
    weather: WEATHERS.includes(r.weather as Weather) ? (r.weather as Weather) : 'day',
  };
}

export interface MatchPlan {
  /** a játéktér területe km²-ben */
  km2: number;
  bots: number;
  pickups: number;
  /** a játékosok ennyire születnek egymástól (m) */
  spawnGap: number;
}

/** A csúszkák szintjeiből és a pálya méretéből a tényleges létszámok. */
export function matchPlan(settings: MatchSettings): MatchPlan {
  const w = settings.area.maxX - settings.area.minX;
  const h = settings.area.maxY - settings.area.minY;
  const km2 = (w * h) / 1e6;
  const bots = settings.bots === 0 ? 0 : clamp(Math.round(settings.bots * MATCH.botsPerKm2 * km2), settings.bots, MATCH.maxBots);
  const pickups = settings.pickups === 0 ? 0 : clamp(Math.round(settings.pickups * MATCH.pickupsPerKm2 * km2), settings.pickups * 2, MATCH.maxPickups);
  // minél kisebb a pálya és minél többen vannak, annál közelebb kell születniük
  const spawnGap = clamp(Math.sqrt((w * h) / Math.max(2, settings.maxPlayers)) * 0.6, 40, 220);
  return { km2, bots, pickups, spawnGap: Math.round(spawnGap) };
}

export interface MatchPlayer {
  /** a kapcsolat (játékos) azonosítója */
  id: string;
  name: string;
  tankId: number;
  /** helyezés: 0, amíg játékban van; a kiesés sorrendjében az utolsótól előre */
  place: number;
  /** kilépett vagy megszakadt a kapcsolata */
  gone: boolean;
}

/** A játékosok csapatszáma: mindenki külön csapat (mindenki mindenki ellen). */
const PLAYER_TEAM = 10;

export class Match {
  readonly world: World;
  readonly bots: BotManager;
  readonly plan: MatchPlan;
  readonly players: MatchPlayer[] = [];
  over = false;
  /** a győztes játékos azonosítója (null: nincs, pl. mindenki kilépett) */
  winner: string | null = null;
  private readonly inputs = new Map<number, TankInput>();
  private nextPlace: number;
  private readonly finals = new Map<string, { kills: number; deaths: number; level: number }>();

  /**
   * \`terrain\`: a pálya, amelyen a játéktér (bounds) és az időjárás már be van
   * állítva. \`entrants\`: a szobában lévő játékosok.
   */
  constructor(
    terrain: Terrain,
    readonly settings: MatchSettings,
    entrants: readonly { id: string; name: string }[],
    seed: number,
  ) {
    this.plan = matchPlan(settings);
    this.world = new World(terrain, seed, { weather: settings.weather, lives: settings.lives, spawnGap: this.plan.spawnGap });
    const { area } = settings;
    entrants.forEach((entrant, i) => {
      // a játékosok egymástól távol, véletlen helyen születnek
      const spot = this.world.spawnSpot() ?? { x: (area.minX + area.maxX) / 2, y: (area.minY + area.maxY) / 2 };
      const tank = this.world.addTank(spot.x, spot.y, this.world.rnd() * Math.PI * 2, { team: PLAYER_TEAM + i });
      this.players.push({ id: entrant.id, name: entrant.name, tankId: tank.id, place: 0, gone: false });
    });
    this.nextPlace = this.players.length;
    this.bots = new BotManager(this.world);
    this.bots.setCount(this.plan.bots, TEAM.bots, ANY_PLAYER);
    this.world.scatterPickups(this.plan.pickups);
  }

  player(id: string): MatchPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  tankOf(id: string): TankState | undefined {
    const player = this.player(id);
    return player ? this.world.tank(player.tankId) : undefined;
  }

  /** Egy szimulációs lépés; \`inputs\`: játékosazonosító → bemenet. */
  step(inputs: ReadonlyMap<string, TankInput>): void {
    if (this.over) return;
    this.inputs.clear();
    for (const p of this.players) {
      const input = inputs.get(p.id);
      if (input && !p.gone) this.inputs.set(p.tankId, input);
    }
    this.bots.update(this.inputs, 1 / 60);
    this.world.step(this.inputs);
    for (const ev of this.world.events) {
      if (ev.type !== 'eliminated') continue;
      const p = this.players.find((q) => q.tankId === ev.tank);
      if (p && p.place === 0) p.place = this.nextPlace--;
    }
    this.checkOver();
  }

  /** A játékos kilépett: a tankja eltűnik, ő maga kiesettnek számít. */
  leave(id: string): void {
    const p = this.player(id);
    if (!p || p.gone) return;
    p.gone = true;
    if (p.place === 0) p.place = this.nextPlace--;
    const tank = this.world.tank(p.tankId);
    if (tank) this.finals.set(p.id, { kills: tank.kills, deaths: tank.deaths, level: tank.level });
    this.world.removeTank(p.tankId);
    this.checkOver();
  }

  private checkOver(): void {
    if (this.over) return;
    const inPlay = this.players.filter((p) => p.place === 0);
    // egyedül játszva addig tart, amíg van élete; többen addig, amíg egynél többen vannak játékban
    const needed = this.players.length > 1 ? 1 : 0;
    if (inPlay.length > needed) return;
    this.over = true;
    if (inPlay.length === 1) {
      inPlay[0].place = 1;
      this.winner = inPlay[0].id;
    }
  }

  /** Az eredménytábla: helyezés szerint, a kilövésekkel. */
  standings(): { id: string; name: string; place: number; kills: number; deaths: number; level: number }[] {
    return this.players
      .map((p) => {
        // a kilépett játékos tankja már nincs a világban: az utolsó állása számít
        const tank = this.world.tank(p.tankId) ?? this.finals.get(p.id);
        return { id: p.id, name: p.name, place: p.place, kills: tank?.kills ?? 0, deaths: tank?.deaths ?? 0, level: tank?.level ?? 1 };
      })
      .sort((a, b) => (a.place || 99) - (b.place || 99));
  }
}
