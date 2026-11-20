// Gép vezérelte tankok. A bot ugyanazt a TankInput-ot adja, mint egy játékos –
// a szimuláció számára nincs különbség, így a botok a szerveren is futtathatók.
//
// Viselkedés:
//   járőr   – az utakat követve halad, a jobb oldali sávban; az út végén megfordul;
//   támadás – ha meglát egy ellenséges (más csapatbeli) tankot, tornyát ráfordítja,
//             lő, és lőtávolságon belülre megy;
//   üldözés – ha szem elől téveszti, egy ideig az utolsó ismert helye felé tart,
//             az utcákat követve (így megkerüli a házakat).
// Akadályok: tapogatókkal kerüli a falakat és a roncsokat. Ha mégsem halad
// (rövid távon: áll; hosszabb távon: ugyanott köröz), kitolat, körbenéz, és a
// legszabadabb irányba indul; ha így sem szabadul, a szimuláció az ellenféltől
// távol új helyre teszi. A botok egymást nem sebzik, és egymásra nem is céloznak.
// A civil járműveket kikerülik; az ellenséges telepített ágyúkat megtámadják.

import { TURRET, VEHICLES, VSTATE } from './vehicles';
import { CLOAK } from './gadgets';
import { angleDiff, BOT_PERKS_SKILL, TANK, WRECK, type RoadGuide, type TankInput, type TankState, type World } from './world';

export const BOT = {
  /** ilyen messziről veszi észre az ellenfelet, ha rálát (m) */
  sight: 75,
  /**
   * Csak akkor lő, ha ő maga a célpont képernyőjén van: a játékos legalább 160 × 90 m-t lát
   * (quality.ts, VIEW_METERS), a bot közepe ennél néhány méterrel beljebb kell legyen, hogy a
   * tankja egészében látsszon. Messzebbről észreveheti és üldözheti, de lőni nem fog.
   */
  fireBox: { x: 74, y: 40 },
  /** az észleléstől az első lövésig eltelő idő (mp) */
  reaction: 0.7,
  /** két lövés között legalább ennyi idő telik el (mp) – a bot lassabban lő, mint a játékos */
  fireInterval: 1.2,
  /** a célzás pontatlansága (rad) */
  aimError: 0.07,
  /** ennél közelebb nem megy a célponthoz (m) */
  keepDistance: 22,
  /** járőrözés közben a gáz állása */
  patrolThrottle: 0.7,
  /** ennyi ideig keresi az ellenfelet az utolsó ismert helyén (mp) */
  chaseTime: 9,
  /** ennyi lépésenként ellenőrzi, rálát-e az ellenfélre */
  sightEvery: 8,
  /** ennyi lépésenként keresi újra a legközelebbi utat */
  guideEvery: 4,
  /** rövid távú figyelés: ennyi idő alatt (mp) legalább ennyit (m) kell haladnia */
  progressEvery: 1.5,
  progressMin: 2,
  /** hosszú távú figyelés: ennyi idő alatt (mp) legalább ennyire (m) el kell távolodnia */
  roamEvery: 10,
  roamMin: 8,
  /** ennyi elakadás után kér áthelyezést */
  rescueAfter: 6,
  /** áthelyezni csak akkor lehet, ha ennyin belül nincs ellenfél (m) – a játékos ne lássa */
  rescueClear: 110,
  /** kiszabaduláskor ilyen messzire néz körbe (m) */
  escapeLook: 28,
} as const;

/** A botok hangolható jellemzői: az ügyesség a célzást és a reakciót, az agresszivitás az észlelést és az üldözést szabja meg. */
export interface BotTuning {
  sight: number;
  reaction: number;
  fireInterval: number;
  aimError: number;
  keepDistance: number;
  patrolThrottle: number;
  chaseTime: number;
  /** ilyen messziről (m) indul el a legközelebbi ellenfél felé akkor is, ha nem látja; 0: nem vadászik */
  hunt: number;
  /** a nagyon és az ultra ügyes bot a közeli tárgyakért is elmegy (és fel is veszi őket) */
  perks: boolean;
}

/** az agresszivitás szintjei; az ügyességé (SKILL_LEVELS) eggyel több: a tetején az ultra ügyes */
export const BOT_LEVELS = { min: 1, max: 5, normal: 3 } as const;
export const SKILL_LEVELS = { min: 1, max: 6, normal: 3 } as const;
/** a nagyon és az ultra ügyes bot ilyen messziről (m) elmegy egy tárgyért, ha éppen nincs ellenfél a látóterében */
const PICKUP_SEEK = 70;

// ügyesség 1..6: célzási hiba (rad), reakcióidő (mp), két lövés közötti idő (mp)
const SKILL = [
  [0.17, 1.4, 1.9],
  [0.11, 1.0, 1.5],
  [BOT.aimError, BOT.reaction, BOT.fireInterval],
  [0.04, 0.45, 0.95],
  [0.02, 0.25, 0.75],
  [0.008, 0.15, 0.6],
];
// agresszivitás 1..5: látótáv (m), üldözés ideje (mp), tartott távolság (m), vadászat távolsága (m), járőrsebesség
const AGGRESSION = [
  [45, 4, 30, 0, 0.6],
  [60, 6, 26, 0, 0.65],
  [BOT.sight, BOT.chaseTime, BOT.keepDistance, 0, BOT.patrolThrottle],
  [90, 13, 18, 260, 0.8],
  [110, 20, 14, 4000, 0.9],
];

/** A botok beállítása a csúszkák állásából (ügyesség 1..6, agresszivitás 1..5); a 3-as az alapérték. */
export function botTuning(skill: number = SKILL_LEVELS.normal, aggression: number = BOT_LEVELS.normal): BotTuning {
  const level = (v: number, max: number): number => Math.max(1, Math.min(max, Math.round(v))) - 1;
  const s = level(skill, SKILL_LEVELS.max);
  const [aimError, reaction, fireInterval] = SKILL[s];
  const [sight, chaseTime, keepDistance, hunt, patrolThrottle] = AGGRESSION[level(aggression, BOT_LEVELS.max)];
  return { sight, reaction, fireInterval, aimError, keepDistance, patrolThrottle, chaseTime, hunt, perks: s + 1 >= BOT_PERKS_SKILL };
}

type Mode = 'patrol' | 'attack' | 'chase';

const clamp = (v: number): number => Math.max(-1, Math.min(1, v));

export class BotBrain {
  private mode: Mode = 'patrol';
  private readonly input: TankInput = { throttle: 0, turn: 0, aim: null, fire: false, drop: false, boost: false };
  /** a kiszemelt ellenfél, illetve az utolsó ismert helye */
  private targetId = -1;
  /** a célpont egy telepített ágyú (nem tank) */
  private targetTurret = false;
  private lastSeenX = 0;
  private lastSeenY = 0;
  private sees = false;
  private reaction = 0;
  private fireWait = 0;
  private chase = 0;
  private aimOffset = 0;
  /** az út melyik irányába halad (az útirány vagy annak ellentettje) */
  private travel: number;
  private guide: RoadGuide | null | undefined;
  /** ebben a lépésben haladni szeretne-e (nem csak áll és lő) */
  private wants = false;
  // rövid távú figyelés
  private sampleTime = 0;
  private sampleX: number;
  private sampleY: number;
  private wantedTime = 0;
  // hosszú távú figyelés
  private roamTime = 0;
  private roamX: number;
  private roamY: number;
  private roamWanted = 0;
  private stuckCount = 0;
  /** a kiszabaduló manőver: előbb röviden tolat, aztán a kiválasztott irányba megy */
  private backUp = 0;
  private freeRun = 0;
  /** az út végén megfordulás után ennyi ideig nem fordul meg újra */
  private turnedBack = 0;
  private readonly phase: number;

  /** a vadászott ellenfél iránya (null: nincs kit vadászni) */
  private huntBearing: number | null = null;

  constructor(
    private readonly world: World,
    readonly tankId: number,
    private readonly tune: BotTuning = botTuning(),
  ) {
    const tank = world.tank(tankId);
    this.travel = tank?.hullAngle ?? 0;
    this.sampleX = this.roamX = tank?.x ?? 0;
    this.sampleY = this.roamY = tank?.y ?? 0;
    this.phase = Math.floor(world.rnd() * BOT.sightEvery);
  }

  /** Hányszor akadt el egymás után (diagnosztikához). */
  get stuck(): number {
    return this.stuckCount;
  }

  /** A bot bemenete a következő szimulációs lépéshez. */
  update(dt: number): TankInput {
    const input = this.input;
    const tank = this.world.tank(this.tankId);
    input.throttle = 0;
    input.turn = 0;
    input.fire = false;
    input.aim = null;
    this.wants = false;
    if (!tank || !tank.alive) {
      this.mode = 'patrol';
      this.sees = false;
      this.backUp = 0;
      this.freeRun = 0;
      this.stuckCount = 0;
      this.guide = undefined;
      if (tank) this.restartWatch(tank);
      return input;
    }

    this.look(tank);
    this.fireWait = Math.max(0, this.fireWait - dt);
    this.freeRun = Math.max(0, this.freeRun - dt);
    this.turnedBack = Math.max(0, this.turnedBack - dt);

    if (this.sees) {
      this.attack(tank, dt);
    } else {
      this.wants = true;
      let bearing: number | null = null;
      if (this.mode === 'chase' && this.chase > 0) {
        this.chase -= dt;
        const dist = Math.hypot(this.lastSeenX - tank.x, this.lastSeenY - tank.y);
        bearing = Math.atan2(this.lastSeenY - tank.y, this.lastSeenX - tank.x);
        // a torony arra néz, amerre az ellenfelet utoljára látta
        input.aim = bearing;
        if (dist < 8) this.chase = 0;
        else if (this.freeRun > 0) this.roam(tank, 0.85);
        else if (dist < 25) this.steerToward(tank, bearing, 0.85);
        else this.followRoad(tank, bearing, 0.9); // az utcákon kerül, a célpont iránya felé
      } else {
        this.mode = 'patrol';
        // kiszabadulás után egy ideig a kiválasztott irányba megy, csak utána keresi újra az utat
        if (this.freeRun > 0) this.roam(tank, 0.8);
        else {
          // a nagyon és az ultra ügyes bot a közeli tárgyakért is elmegy
          const item = this.tune.perks ? this.seekPickup(tank) : null;
          if (item && item.dist < 22) this.steerToward(tank, item.bearing, 0.85);
          else if (item) this.followRoad(tank, item.bearing, 0.9);
          else {
            // az agresszív bot nem csak járőrözik: az utcákon a legközelebbi ellenfél felé tart
            const toward = this.tune.hunt > 0 ? this.seek(tank) : null;
            this.followRoad(tank, toward ?? this.travel, this.tune.patrolThrottle);
          }
        }
      }
    }

    this.avoidObstacles(tank);
    this.watchProgress(tank, dt);
    return input;
  }

  /** a kiszemelt tárgy (azonosító), és hogy mikor kerestük utoljára */
  private itemId = -1;

  /** A legközelebbi tárgy iránya és távolsága PICKUP_SEEK méteren belül (fél másodpercenként újraválasztva), vagy null. */
  private seekPickup(tank: TankState): { bearing: number; dist: number } | null {
    const pickups = this.world.pickups;
    if ((this.world.tick + this.phase) % 30 === 0 || !pickups.some((p) => p.id === this.itemId)) {
      this.itemId = -1;
      let best: number = PICKUP_SEEK;
      for (const p of pickups) {
        const dist = Math.hypot(p.x - tank.x, p.y - tank.y);
        if (dist < best) {
          best = dist;
          this.itemId = p.id;
        }
      }
    }
    const item = pickups.find((p) => p.id === this.itemId);
    if (!item) return null;
    return { bearing: Math.atan2(item.y - tank.y, item.x - tank.x), dist: Math.hypot(item.x - tank.x, item.y - tank.y) };
  }

  /** A legközelebbi ellenfél iránya a vadászat távolságán belül (időnként újraszámolva), vagy null. */
  private seek(tank: TankState): number | null {
    if ((this.world.tick + this.phase) % 30 !== 0) return this.huntBearing;
    let best = this.tune.hunt;
    this.huntBearing = null;
    for (const other of this.world.tanks) {
      if (!other.alive || other.team === tank.team) continue;
      const dist = Math.hypot(other.x - tank.x, other.y - tank.y);
      if (dist >= best) continue;
      best = dist;
      this.huntBearing = Math.atan2(other.y - tank.y, other.x - tank.x);
    }
    return this.huntBearing;
  }

  /** Ellenfél keresése: a legközelebbi, látótávolságon belüli, takarásban nem lévő más csapatbeli tank. */
  private look(tank: TankState): void {
    if ((this.world.tick + this.phase) % BOT.sightEvery !== 0) return;
    let best: { id: number; x: number; y: number } | null = null;
    let turret = false;
    let bestDist: number = this.tune.sight;
    for (const other of this.world.tanks) {
      if (!other.alive || other.team === tank.team) continue;
      const dist = Math.hypot(other.x - tank.x, other.y - tank.y);
      if (dist >= bestDist) continue;
      if (this.world.terrain.walls.raycast(tank.x, tank.y, other.x, other.y)) continue; // fal takarja
      if (dist > 9 && this.world.inSmoke(other.x, other.y)) continue; // füst takarja
      if (other.cloak > 0 && dist > CLOAK.botSight) continue; // álcázva van: csak közelről veszi észre
      best = other;
      bestDist = dist;
    }
    // az ellenséges telepített ágyú is célpont (ha az közelebb van, mint a legközelebbi tank)
    for (const other of this.world.turrets) {
      if (other.team === tank.team) continue;
      const dist = Math.hypot(other.x - tank.x, other.y - tank.y);
      if (dist >= bestDist) continue;
      if (this.world.terrain.walls.raycast(tank.x, tank.y, other.x, other.y)) continue;
      best = other;
      bestDist = dist;
      turret = true;
    }
    if (best) {
      if (!this.sees) this.reaction = this.tune.reaction;
      this.sees = true;
      this.mode = 'attack';
      this.targetId = best.id;
      this.targetTurret = turret;
      this.lastSeenX = best.x;
      this.lastSeenY = best.y;
    } else if (this.sees) {
      // szem elől tévesztette: az utolsó ismert hely felé indul
      this.sees = false;
      this.mode = 'chase';
      this.chase = this.tune.chaseTime;
    }
  }

  private attack(tank: TankState, dt: number): void {
    const input = this.input;
    let target: { x: number; y: number } | undefined;
    if (this.targetTurret) target = this.world.turrets.find((t) => t.id === this.targetId);
    else {
      const other = this.world.tank(this.targetId);
      if (other?.alive) target = other;
    }
    if (!target) {
      this.sees = false;
      this.mode = 'patrol';
      return;
    }
    const dx = target.x - tank.x;
    const dy = target.y - tank.y;
    const dist = Math.hypot(dx, dy);
    const bearing = Math.atan2(dy, dx);

    // a célzás hibája lassan vándorol, így a bot nem talál minden lövéssel
    this.aimOffset += (this.world.rnd() - 0.5) * 0.02;
    this.aimOffset = Math.max(-this.tune.aimError, Math.min(this.tune.aimError, this.aimOffset));
    input.aim = bearing + this.aimOffset;

    this.reaction = Math.max(0, this.reaction - dt);
    const aligned = Math.abs(angleDiff(input.aim, tank.turretAngle) ) < 0.07;
    // a képernyőn kívülről nem lő (a játékos nem látná, honnan jön a lövés)
    const onScreen = Math.abs(dx) <= BOT.fireBox.x && Math.abs(dy) <= BOT.fireBox.y;
    if (this.reaction === 0 && this.fireWait === 0 && aligned && onScreen) {
      input.fire = true;
      this.fireWait = this.tune.fireInterval;
    }

    // lőtávolságon belülre megy, de nem megy neki a célpontnak; ha az útja el van
    // zárva (elakadt), inkább megáll és onnan lő – hiszen rálát a célra
    if (dist > this.tune.keepDistance + 8 && this.stuckCount === 0) {
      this.wants = true;
      this.steerToward(tank, bearing, 0.8);
    } else if (dist < this.tune.keepDistance - 8) this.steerToward(tank, bearing, -0.5);
    else input.turn = clamp(angleDiff(bearing, tank.hullAngle) * 1.5);
  }

  /**
   * Útkövetés a jobb oldali sávban. `prefer`: az út két iránya közül azt
   * választja, amelyik ehhez az irányhoz közelebb esik (járőrnél az eddigi
   * haladási irány, üldözésnél a célpont iránya).
   */
  private followRoad(tank: TankState, prefer: number, throttle: number): void {
    const { terrain } = this.world;
    // a legközelebbi utat csak néhány lépésenként keresi újra (a botok eltolva, nem egyszerre)
    if ((this.world.tick + this.phase) % BOT.guideEvery === 0 || this.guide === undefined) {
      this.guide = terrain.roadGuide?.(tank.x, tank.y) ?? null;
    }
    const guide = this.guide;
    if (!guide) {
      // nincs út a közelben: toronyiránt megy a kívánt irányba (járőrnél az eddigi irányba)
      this.travel = prefer;
      this.roam(tank, throttle);
      return;
    }
    let along = Math.abs(angleDiff(guide.angle, prefer)) <= Math.PI / 2 ? guide.angle : guide.angle + Math.PI;
    const ahead = 9;
    const lane = guide.width / 4;
    let cos = Math.cos(along);
    let sin = Math.sin(along);

    // Az út vége: a bot már túlhaladt az út utolsó pontján (zsákutca), vagy az út
    // kivezet a pályáról. Ilyenkor megfordul, és visszafelé megy ugyanazon az úton.
    if (this.turnedBack === 0) {
      const past = (tank.x - guide.x) * cos + (tank.y - guide.y) * sin;
      const ex = guide.x + cos * (ahead + 6);
      const ey = guide.y + sin * (ahead + 6);
      const area = terrain.bounds ?? { minX: 0, minY: 0, maxX: terrain.width, maxY: terrain.height };
      const leaves = ex < area.minX || ey < area.minY || ex > area.maxX || ey > area.maxY;
      if (past > 5 || leaves) {
        along += Math.PI;
        cos = -cos;
        sin = -sin;
        this.turnedBack = 6;
      }
    }
    this.travel = along;
    // célpont: az úttengely előrébb lévő pontja, a jobb oldali sáv közepére tolva
    const tx = guide.x + cos * ahead - sin * lane;
    const ty = guide.y + sin * ahead + cos * lane;
    this.steerToward(tank, Math.atan2(ty - tank.y, tx - tank.x), throttle);
  }

  /**
   * Haladás út nélkül, a `travel` irányba. Ha arra fal zárja el az utat, nem
   * megy neki újra és újra: körbenéz, és a legszabadabb irányt választja.
   */
  private roam(tank: TankState, throttle: number): void {
    if ((this.world.tick + this.phase) % 20 === 0 && this.ray(tank.x, tank.y, this.travel, 9) < 1) {
      this.travel = this.clearestDirection(tank);
    }
    this.steerToward(tank, this.travel, throttle);
  }

  /** Kormányzás a megadott irányba; éles fordulónál lassít. */
  private steerToward(tank: TankState, angle: number, throttle: number): void {
    const diff = angleDiff(angle, tank.hullAngle);
    this.input.turn = clamp(diff * 2.2);
    const sharp = Math.abs(diff) > 0.9;
    this.input.throttle = sharp ? throttle * 0.35 : throttle;
  }

  /** A fal távolsága a megadott (abszolút) irányban, a tapogató hosszának arányában (1 = szabad). */
  private ray(x: number, y: number, angle: number, reach: number): number {
    const hit = this.world.terrain.walls.raycast(x, y, x + Math.cos(angle) * reach, y + Math.sin(angle) * reach);
    return hit ? hit.t : 1;
  }

  /** Tapogatók: a falakat és a roncsokat arra kerüli, amerre több a hely; szűk helyen lassít. */
  private avoidObstacles(tank: TankState): void {
    const input = this.input;
    if (input.throttle <= 0 || this.backUp > 0) return;
    const reach = 5 + Math.abs(tank.speed) * 0.4;
    const h = tank.hullAngle;
    const front = this.ray(tank.x, tank.y, h, reach);
    const left = Math.min(this.ray(tank.x, tank.y, h - 0.45, reach), this.ray(tank.x, tank.y, h - 0.95, reach * 0.7));
    const right = Math.min(this.ray(tank.x, tank.y, h + 0.45, reach), this.ray(tank.x, tank.y, h + 0.95, reach * 0.7));
    let nearest = Math.min(front, left, right);
    let away = right >= left ? 1 : -1;

    // roncs az úton: ha előttünk van, arra az oldalra térünk ki, amerre távolabb esik
    const cos = Math.cos(h);
    const sin = Math.sin(h);
    for (const w of this.world.wrecks) {
      const dx = w.x - tank.x;
      const dy = w.y - tank.y;
      const forward = dx * cos + dy * sin;
      if (forward < 0 || forward > reach + WRECK.radius) continue;
      const side = dy * cos - dx * sin;
      if (Math.abs(side) > TANK.radius + WRECK.radius + 0.8) continue;
      const t = Math.max(0, forward - WRECK.radius) / reach;
      if (t < nearest) {
        nearest = t;
        away = side > 0 ? -1 : 1;
      }
    }

    // jármű vagy telepített ágyú az úton: ugyanígy kikerüli
    const dodge = (ox: number, oy: number, r: number): void => {
      const dx = ox - tank.x;
      const dy = oy - tank.y;
      const forward = dx * cos + dy * sin;
      if (forward < 0 || forward > reach + r) return;
      const side = dy * cos - dx * sin;
      if (Math.abs(side) > TANK.radius + r + 0.8) return;
      const t = Math.max(0, forward - r) / reach;
      if (t < nearest) {
        nearest = t;
        away = side > 0 ? -1 : 1;
      }
    };
    for (const v of this.world.vehicles) {
      if (v.state === VSTATE.flat) continue;
      if (Math.abs(v.x - tank.x) > reach + 8 || Math.abs(v.y - tank.y) > reach + 8) continue;
      const spec = VEHICLES[v.kind];
      const vc = Math.cos(v.angle);
      const vs = Math.sin(v.angle);
      for (const off of spec.circles) dodge(v.x + vc * off, v.y + vs * off, spec.r);
    }
    for (const t of this.world.turrets) dodge(t.x, t.y, TURRET.radius);

    if (nearest >= 1) return;
    // minél közelebb az akadály, annál határozottabban tér ki és annál jobban lassít
    if (front < 1 || nearest < 0.6) input.turn = away * Math.max(0.5, 1 - nearest);
    input.throttle *= Math.max(0.3, Math.min(1, nearest + 0.25));
    // zsákutca: minden irányban fal van közvetlenül előtte – azonnal kitolat
    if (front < 0.3 && left < 0.35 && right < 0.35) this.startEscape(tank);
  }

  /**
   * Körbenéz, és a legszabadabb irányt adja vissza (olyat, ahol a tank teljes
   * szélességében elfér). Ismételt elakadásnál egyre véletlenszerűbben választ.
   */
  private clearestDirection(tank: TankState): number {
    const rnd = this.world.rnd;
    const reach = BOT.escapeLook;
    const half = TANK.radius + 0.3;
    const start = rnd() * Math.PI * 2;
    let best = tank.hullAngle + Math.PI;
    let bestScore = -Infinity;
    for (let k = 0; k < 12; k++) {
      const a = start + (k * Math.PI) / 6;
      const ox = -Math.sin(a) * half;
      const oy = Math.cos(a) * half;
      const free = Math.min(this.ray(tank.x, tank.y, a, reach), this.ray(tank.x + ox, tank.y + oy, a, reach), this.ray(tank.x - ox, tank.y - oy, a, reach));
      // egy kicsit előnyben van az eddigi menetirány; a véletlen szerepe az elakadások számával nő
      const score = free + 0.1 * Math.cos(angleDiff(a, this.travel)) + rnd() * 0.12 * this.stuckCount;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return best;
  }

  /**
   * Kiszabadulás: röviden kitolat, majd a legszabadabb irányba indul; ismételt
   * elakadásnál egyre tovább megy arra, hogy ne ugyanoda térjen vissza.
   */
  private startEscape(tank: TankState): void {
    if (this.backUp > 0) return;
    this.travel = this.clearestDirection(tank);
    this.backUp = 0.7;
    this.freeRun = this.backUp + 3 + Math.min(4, this.stuckCount);
    this.guide = undefined;
  }

  private restartWatch(tank: TankState): void {
    this.sampleTime = 0;
    this.wantedTime = 0;
    this.sampleX = tank.x;
    this.sampleY = tank.y;
    this.roamTime = 0;
    this.roamWanted = 0;
    this.roamX = tank.x;
    this.roamY = tank.y;
  }

  /**
   * Figyeli, halad-e a bot, amikor haladni szeretne. Rövid távon: ha áll,
   * kiszabaduló manőverbe kezd. Hosszú távon: ha ugyanazon a helyen köröz,
   * az is elakadásnak számít. Sok elakadás után áthelyezést kér.
   */
  private watchProgress(tank: TankState, dt: number): void {
    const input = this.input;

    if (this.backUp > 0) {
      // tolatás, közben az orr a kiválasztott irány felé fordul
      this.backUp -= dt;
      input.throttle = -0.9;
      input.turn = clamp(angleDiff(this.travel, tank.hullAngle) * 2);
      if (this.backUp <= 0) {
        this.sampleTime = 0;
        this.wantedTime = 0;
        this.sampleX = tank.x;
        this.sampleY = tank.y;
      }
      this.roamTime += dt;
      this.roamWanted += dt;
      return;
    }

    const wants = this.wants && tank.slip === 0;
    let stuck = false;

    // rövid távú figyelés
    if (wants) this.wantedTime += dt;
    this.sampleTime += dt;
    if (this.sampleTime >= BOT.progressEvery) {
      const moved = Math.hypot(tank.x - this.sampleX, tank.y - this.sampleY);
      if (this.wantedTime >= BOT.progressEvery * 0.8 && moved < BOT.progressMin) stuck = true;
      this.sampleTime = 0;
      this.wantedTime = 0;
      this.sampleX = tank.x;
      this.sampleY = tank.y;
    }

    // hosszú távú figyelés
    if (wants) this.roamWanted += dt;
    this.roamTime += dt;
    if (this.roamTime >= BOT.roamEvery) {
      const moved = Math.hypot(tank.x - this.roamX, tank.y - this.roamY);
      if (this.roamWanted >= BOT.roamEvery * 0.7 && moved < BOT.roamMin) {
        stuck = true;
        this.stuckCount++; // ez súlyosabb: a rövid manőverek nem segítettek
      } else if (moved > 25) this.stuckCount = 0;
      this.roamTime = 0;
      this.roamWanted = 0;
      this.roamX = tank.x;
      this.roamY = tank.y;
    }

    if (!stuck) return;
    this.stuckCount++;
    if (this.stuckCount >= BOT.rescueAfter && this.world.relocate(tank.id, BOT.rescueClear)) {
      this.stuckCount = 0;
      this.guide = undefined;
      this.freeRun = 0;
      this.travel = tank.hullAngle;
      this.restartWatch(tank);
      return;
    }
    this.startEscape(tank);
  }
}

/** Botok kezelése: létrehozás, eltávolítás és a bemenetük előállítása lépésenként. */
export class BotManager {
  private readonly brains = new Map<number, BotBrain>();

  constructor(
    private readonly world: World,
    private readonly tune: BotTuning = botTuning(),
  ) {}

  get count(): number {
    return this.brains.size;
  }

  /** A botok számának beállítása: a hiányzókat létrehozza, a fölöslegeseket eltávolítja. */
  setCount(count: number, team: number, avoidTeam: number): void {
    while (this.brains.size > count) {
      const id = [...this.brains.keys()].pop()!;
      this.brains.delete(id);
      this.world.removeTank(id);
    }
    while (this.brains.size < count) {
      // a játékosoktól távol; kis pályán, ahol ekkora hely nincs, közelebb is beéri
      let spot: { x: number; y: number } | null = null;
      for (const far of [140, 90, 60, 35, 20]) {
        spot = this.world.freeSpot(far, avoidTeam);
        if (spot) break;
      }
      if (!spot) break;
      const tank = this.world.addTank(spot.x, spot.y, this.world.rnd() * Math.PI * 2, { team, bot: true });
      this.brains.set(tank.id, new BotBrain(this.world, tank.id, this.tune));
    }
  }

  /** Hány bot van éppen elakadva (diagnosztikához). */
  get stuckCount(): number {
    let n = 0;
    for (const brain of this.brains.values()) if (brain.stuck > 0) n++;
    return n;
  }

  /** A botok bemenetének beírása a közös bemenet-táblába. */
  update(inputs: Map<number, TankInput>, dt: number): void {
    for (const [id, brain] of this.brains) inputs.set(id, brain.update(dt));
  }
}
