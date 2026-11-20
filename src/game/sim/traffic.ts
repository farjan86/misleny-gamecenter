// Civil forgalom: személyautók, buszok és ellátó teherautók az utakon. A
// járművek az úthálózat élein, a jobb oldali sávban haladnak („sínen”: falnak
// nem tudnak menni), ezért jóval olcsóbbak egy botnál.
//
// Viselkedés:
//   - a játéktér szélén (a kapukon) érkeznek és távoznak, kereszteződésben
//     véletlenszerűen választanak irányt (a busz a főutakat részesíti előnyben);
//   - megállnak a stopvonalnál, és bevárják a keresztező forgalmat;
//   - lassítanak, megállnak, ha tank, roncs vagy másik jármű van előttük; ha
//     sokáig nem jutnak tovább, dudálnak, aztán megfordulnak;
//   - közeli lövésre, robbanásra megijednek: fékeznek, megfordulnak vagy elhajtanak.
// A sebzésük, a robbanásuk és a roncsaik a World dolga; itt csak a vezetés van.

import { RoadNet, type NetEdge, type NetPoint } from './roadnet';
import { TURRET, VEHICLES, VSTATE, type VehicleKind, type VehicleState } from './vehicles';
import { angleDiff, tankRadius, WRECK, type Stepper, type World } from './world';

export const TRAFFIC = {
  accel: 5,
  brake: 8,
  hardBrake: 16,
  /** kanyarban, kereszteződésben legfeljebb ennyivel mennek (m/s) */
  curveSpeed: 5.5,
  /** esőben ennyiszer lassabbak */
  rain: 0.8,
  /** a stopvonalnál legalább ennyit állnak, és legfeljebb ennyit várnak a keresztező forgalomra (mp) */
  stopWait: 1,
  stopMaxWait: 6,
  /** ennyi álldogálás után dudál, illetve fordul meg a jármű, ha tank vagy roncs állja el az útját (mp) */
  honkAfter: 1.5,
  turnAfter: 6,
  /** ha egy másik jármű tartja fel ennyi ideig, kikerüli (egy rövid időre nem veszi figyelembe a járműveket) */
  passAfter: 4,
  passTime: 2.5,
  /** a megfordulás ideje (mp) */
  turnTime: 2.6,
  /** ekkora körben ijednek meg a lövéstől, robbanástól (m); ennyi ideig menekülnek, és utána ennyi ideig nyugodtak (mp) */
  scareRange: 45,
  panicTime: 7,
  panicSpeed: 1.5,
  calm: 10,
  /** induláskor a tankoktól, a kapunál a tankoktól, illetve egymástól legalább ennyire jelennek meg (m) */
  startClear: 40,
  gateClear: 12,
  spacing: 16,
  /** elakadt jármű csak akkor tűnhet el, ha ennyin belül nincs játékos (m) */
  unseen: 110,
} as const;

/** A sáv, amelyet követnek, ennyivel a jármű előtt van (m). */
const LOOK: Record<VehicleKind, number> = { car: 5, truck: 6.5, bus: 8 };

interface Driver {
  v: VehicleState;
  edge: NetEdge;
  next: NetEdge | null;
  /** a jármű helye az élen (m) */
  s: number;
  /** az utazósebesség egyéni szorzója: nem mindenki megy egyformán */
  pace: number;
  blocked: number;
  honked: boolean;
  pass: number;
  stopWait: number;
  stopDone: boolean;
  panic: number;
  halt: number;
  calm: number;
  /** a megfordulás hátralévő és teljes ideje, kezdő- és végállapota */
  turn: number;
  turnTotal: number;
  fromX: number;
  fromY: number;
  fromAngle: number;
  toX: number;
  toY: number;
  toAngle: number;
  sinceTurn: number;
}

/** A járművek összetétele: többnyire személyautó, néhány busz, ritkán egy ellátó teherautó. */
export function trafficMix(count: number, buses: boolean): VehicleKind[] {
  const trucks = count >= 3 ? Math.max(1, Math.round(count / 12)) : 0;
  const bus = buses && count >= 4 ? Math.max(1, Math.round(count / 8)) : 0;
  const mix: VehicleKind[] = [];
  for (let i = 0; i < count; i++) mix.push(i < trucks ? 'truck' : i < trucks + bus ? 'bus' : 'car');
  return mix;
}

const OB_NONE = 0;
const OB_VEHICLE = 1;
const OB_SOLID = 2;
const OB_TANK = 3;

export class Traffic implements Stepper {
  readonly net: RoadNet | null = null;
  private readonly drivers = new Map<number, Driver>();
  private readonly pending: { kind: VehicleKind; wait: number }[] = [];
  private readonly edges: NetEdge[] = [];
  private readonly mainEdges: NetEdge[] = [];
  private readonly p1: NetPoint = { x: 0, y: 0, angle: 0 };
  private readonly p2: NetPoint = { x: 0, y: 0, angle: 0 };
  private obstacle = OB_NONE;

  /** `count`: ennyi jármű közlekedik egyszerre (0: nincs forgalom). */
  constructor(
    private readonly world: World,
    count: number,
  ) {
    const { terrain } = world;
    const roads = count > 0 ? terrain.driveRoads?.() : undefined;
    if (!roads || roads.length === 0) return;
    const bounds = terrain.bounds ?? { minX: 0, minY: 0, maxX: terrain.width, maxY: terrain.height };
    const net = new RoadNet(roads, bounds, terrain.stopLines ?? []);
    if (!net.usable) return;
    this.net = net;
    this.edges = net.drivable();
    this.mainEdges = this.edges.filter((e) => e.main);
    for (const kind of trafficMix(count, this.mainEdges.length > 0)) {
      if (!this.start(kind)) this.pending.push({ kind, wait: 2 + world.rnd() * 6 });
    }
  }

  /** A közlekedő járművek száma. */
  get count(): number {
    return this.drivers.size;
  }

  /** Az él `s` méternél lévő pontja a jármű sávjában; az él vége után a következő élen (vagy egyenesen tovább) folytatódik. */
  private pathPoint(d: { edge: NetEdge; next: NetEdge | null }, s: number, out: NetPoint): NetPoint {
    const net = this.net!;
    const { edge } = d;
    if (s < 0) {
      net.pointAt(edge, 0, edge.width / 4, out);
      out.x += Math.cos(edge.startAngle) * s;
      out.y += Math.sin(edge.startAngle) * s;
      return out;
    }
    if (s <= edge.length) return net.pointAt(edge, s, edge.width / 4, out);
    if (d.next) return net.pointAt(d.next, s - edge.length, d.next.width / 4, out);
    net.pointAt(edge, edge.length, edge.width / 4, out);
    out.x += Math.cos(edge.endAngle) * (s - edge.length);
    out.y += Math.sin(edge.endAngle) * (s - edge.length);
    return out;
  }

  /** A következő él a kereszteződésben: nem fordul vissza; az egyenes és a főút valószínűbb. */
  private choose(edge: NetEdge, kind: VehicleKind): NetEdge | null {
    const net = this.net!;
    let options = net.nodes[edge.to].out.filter((id) => id !== edge.reverse).map((id) => net.edges[id]);
    if (options.length === 0) return null;
    if (kind === 'bus') {
      const main = options.filter((e) => e.main);
      if (main.length) options = main;
    }
    let total = 0;
    const weights = options.map((e) => {
      const straight = Math.abs(angleDiff(e.startAngle, edge.endAngle)) < 0.6;
      const w = (straight ? 2 : 1) * (e.main ? 1.5 : 1);
      total += w;
      return w;
    });
    let roll = this.world.rnd() * total;
    for (let i = 0; i < options.length; i++) {
      roll -= weights[i];
      if (roll < 0) return options[i];
    }
    return options[options.length - 1];
  }

  private clearOf(x: number, y: number, tankGap: number, humansOnly: boolean): boolean {
    const { world } = this;
    for (const t of world.tanks) {
      if (!t.alive || (humansOnly && t.bot)) continue;
      if (Math.abs(t.x - x) < tankGap && Math.abs(t.y - y) < tankGap) return false;
    }
    for (const v of world.vehicles) if (Math.abs(v.x - x) < TRAFFIC.spacing && Math.abs(v.y - y) < TRAFFIC.spacing) return false;
    return true;
  }

  private add(kind: VehicleKind, edge: NetEdge, s: number): void {
    const { world } = this;
    const spec = VEHICLES[kind];
    const d: Driver = {
      v: null as unknown as VehicleState,
      edge,
      next: this.choose(edge, kind),
      s,
      pace: 0.85 + world.rnd() * 0.3,
      blocked: 0,
      honked: false,
      pass: 0,
      stopWait: 0,
      stopDone: false,
      panic: 0,
      halt: 0,
      calm: 0,
      turn: 0,
      turnTotal: 1,
      fromX: 0,
      fromY: 0,
      fromAngle: 0,
      toX: 0,
      toY: 0,
      toAngle: 0,
      sinceTurn: 99,
    };
    const p = this.pathPoint(d, s, this.p1);
    d.v = world.addVehicle(kind, Math.floor(world.rnd() * spec.looks), p.x, p.y, p.angle);
    d.v.speed = spec.cruise * 0.8;
    this.drivers.set(d.v.id, d);
  }

  /** Jármű elhelyezése valahol az úthálózaton (induláskor, vagy ha nincs kapu). */
  private start(kind: VehicleKind, tankGap: number = TRAFFIC.startClear, humansOnly = false): boolean {
    const pool = kind === 'bus' && this.mainEdges.length ? this.mainEdges : this.edges;
    const rnd = this.world.rnd;
    let total = 0;
    for (const e of pool) total += e.length;
    for (let attempt = 0; attempt < 30; attempt++) {
      let roll = rnd() * total;
      let edge = pool[0];
      for (const e of pool) {
        edge = e;
        roll -= e.length;
        if (roll < 0) break;
      }
      if (edge.length < 24) continue;
      const s = 10 + rnd() * (edge.length - 20);
      const p = this.net!.pointAt(edge, s, edge.width / 4, this.p1);
      if (!this.clearOf(p.x, p.y, tankGap, humansOnly)) continue;
      this.add(kind, edge, s);
      return true;
    }
    return false;
  }

  /** Új jármű érkezése a játéktér szélén, egy kapun át. */
  private enter(kind: VehicleKind): boolean {
    const net = this.net!;
    if (net.entries.length === 0) return this.start(kind, TRAFFIC.unseen, true);
    let pool = net.entries;
    if (kind === 'bus') {
      const main = pool.filter((id) => net.edges[id].main);
      if (main.length) pool = main;
    }
    const edge = net.edges[pool[Math.floor(this.world.rnd() * pool.length)]];
    const s = -(VEHICLES[kind].length / 2 + 1);
    const p = this.pathPoint({ edge, next: null }, s, this.p1);
    if (!this.clearOf(p.x, p.y, TRAFFIC.gateClear, false)) return false;
    this.add(kind, edge, s);
    return true;
  }

  /** A jármű eltűnik (kihajtott a pályáról, vagy végleg elakadt); helyette később új érkezik. */
  private retire(d: Driver): void {
    this.drivers.delete(d.v.id);
    this.world.removeVehicle(d.v.id);
    this.pending.push({ kind: d.v.kind, wait: 1.5 + this.world.rnd() * 4 });
  }

  step(dt: number): void {
    if (!this.net) return;
    this.react();
    for (const d of [...this.drivers.values()]) {
      if (d.v.state !== VSTATE.driving) {
        // kilőtték vagy összelapították: a roncs a világé, helyette később új jármű érkezik
        this.drivers.delete(d.v.id);
        this.pending.push({ kind: d.v.kind, wait: VEHICLES[d.v.kind].respawn });
        continue;
      }
      this.drive(d, dt);
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      p.wait -= dt;
      if (p.wait > 0) continue;
      if (this.enter(p.kind)) this.pending.splice(i, 1);
      else p.wait = 1.5;
    }
  }

  /** Ijedtség: a közeli lövés, becsapódás, robbanás hatása. */
  private react(): void {
    const { world } = this;
    for (const ev of world.events) {
      if (ev.type !== 'shot' && ev.type !== 'impact' && ev.type !== 'blast' && ev.type !== 'destroyed') continue;
      for (const d of this.drivers.values()) {
        if (d.calm > 0 || d.turn > 0 || d.v.state !== VSTATE.driving) continue;
        if (Math.abs(d.v.x - ev.x) > TRAFFIC.scareRange || Math.abs(d.v.y - ev.y) > TRAFFIC.scareRange) continue;
        d.calm = TRAFFIC.calm;
        d.panic = TRAFFIC.panicTime;
        const roll = world.rnd();
        if (roll < 0.2) d.halt = 2.5; // lefékez, aztán elhajt
        else if (roll < 0.45 && d.v.kind !== 'bus' && d.s > 6 && d.s < d.edge.length - 6) this.startTurn(d); // megfordul, és arra menekül
      }
    }
  }

  private humanNear(x: number, y: number, range: number): boolean {
    for (const t of this.world.tanks) if (!t.bot && Math.abs(t.x - x) < range && Math.abs(t.y - y) < range) return true;
    return false;
  }

  /** Szabad-e a kereszteződés a stopvonal után: nem közeledik-e másik jármű. */
  private junctionClear(d: Driver): boolean {
    const node = this.net!.nodes[d.edge.to];
    for (const o of this.drivers.values()) {
      if (o === d || o.edge === d.edge || o.v.speed < 2) continue;
      if (Math.abs(o.v.x - node.x) < 16 && Math.abs(o.v.y - node.y) < 16) return false;
    }
    return true;
  }

  /**
   * A jármű előtti első akadály távolsága (m; Infinity, ha szabad az út). Az
   * akadály fajtája az `obstacle` mezőbe kerül.
   */
  private ahead(d: Driver): number {
    const { world } = this;
    const v = d.v;
    const spec = VEHICLES[v.kind];
    const cos = Math.cos(v.angle);
    const sin = Math.sin(v.angle);
    const front = spec.length / 2;
    const halfWidth = spec.width / 2 + 0.35;
    const reach = 7 + v.speed * 1.3;
    let best = Infinity;
    this.obstacle = OB_NONE;
    const probe = (ox: number, oy: number, r: number, type: number, limit: number): void => {
      const dx = ox - v.x;
      const dy = oy - v.y;
      const forward = dx * cos + dy * sin;
      if (forward <= 0) return;
      const gap = forward - front - r;
      if (gap > limit || gap >= best) return;
      if (Math.abs(dy * cos - dx * sin) > halfWidth + r) return;
      best = gap;
      this.obstacle = type;
    };
    // csak a közelben lévőket érdemes megnézni
    const near = reach + front + 4;
    const { x, y } = v;
    for (const t of world.tanks) if (t.alive && Math.abs(t.x - x) < near && Math.abs(t.y - y) < near) probe(t.x, t.y, tankRadius(t), OB_TANK, reach);
    for (const w of world.wrecks) if (Math.abs(w.x - x) < near && Math.abs(w.y - y) < near) probe(w.x, w.y, WRECK.radius, OB_SOLID, reach);
    for (const t of world.turrets) if (Math.abs(t.x - x) < near && Math.abs(t.y - y) < near) probe(t.x, t.y, TURRET.radius, OB_SOLID, reach);
    const far = reach + 14;
    for (const o of world.vehicles) {
      if (o === v || o.state === VSTATE.flat) continue;
      if (Math.abs(o.x - v.x) > far || Math.abs(o.y - v.y) > far) continue;
      let limit = reach;
      let type = OB_SOLID;
      if (o.state === VSTATE.driving) {
        if (d.pass > 0) continue;
        // a szembejövő nem akadály; a keresztező csak közvetlen közelről
        const facing = Math.cos(o.angle - v.angle);
        if (facing < -0.2) continue;
        if (facing < 0.5) limit = 4;
        type = OB_VEHICLE;
      }
      const os = VEHICLES[o.kind];
      const oc = Math.cos(o.angle);
      const osin = Math.sin(o.angle);
      for (const off of os.circles) probe(o.x + oc * off, o.y + osin * off, os.r, type, limit);
    }
    return best;
  }

  /** Megfordulás: a jármű az ellenkező irányú sávba áll át, és arra megy tovább. */
  private startTurn(d: Driver): void {
    const net = this.net!;
    const v = d.v;
    const back = net.edges[d.edge.reverse];
    d.fromX = v.x;
    d.fromY = v.y;
    d.fromAngle = v.angle;
    d.s = Math.max(0, Math.min(back.length, back.length - d.s));
    d.edge = back;
    d.next = this.choose(back, v.kind);
    const p = this.pathPoint(d, d.s, this.p1);
    d.toX = p.x;
    d.toY = p.y;
    d.toAngle = p.angle;
    d.turnTotal = TRAFFIC.turnTime * (v.kind === 'car' ? 1 : 1.5);
    d.turn = d.turnTotal;
    d.blocked = 0;
    d.honked = false;
    d.sinceTurn = 0;
    d.stopDone = false;
    d.stopWait = 0;
    v.speed = 0;
  }

  private drive(d: Driver, dt: number): void {
    const { world } = this;
    const v = d.v;
    const spec = VEHICLES[v.kind];
    d.calm = Math.max(0, d.calm - dt);
    d.pass = Math.max(0, d.pass - dt);
    d.halt = Math.max(0, d.halt - dt);
    d.panic = Math.max(0, d.panic - dt);
    d.sinceTurn += dt;

    if (d.turn > 0) {
      // megfordulás: balra (az út közepe felé) fordulva áll át a túloldali sávba
      d.turn = Math.max(0, d.turn - dt);
      const k = 1 - d.turn / d.turnTotal;
      const e = k * k * (3 - 2 * k);
      let delta = angleDiff(d.toAngle, d.fromAngle);
      if (delta > 0) delta -= Math.PI * 2;
      v.x = d.fromX + (d.toX - d.fromX) * e;
      v.y = d.fromY + (d.toY - d.fromY) * e;
      v.angle = d.fromAngle + delta * e;
      if (d.turn === 0) v.angle = d.toAngle;
      return;
    }

    const look = LOOK[v.kind];
    let want = spec.cruise * d.pace * (world.rules.weather === 'rain' ? TRAFFIC.rain : 1);
    if (d.panic > 0) want *= TRAFFIC.panicSpeed;
    if (d.halt > 0) want = 0;
    // kanyar vagy kereszteződés előtt lassít
    const far = this.pathPoint(d, d.s + look + 7, this.p2);
    const bend = Math.abs(angleDiff(far.angle, v.angle));
    // éles kanyarban még lassabban: a hosszú jármű így is befér
    if (bend > 0.5) want = Math.min(want, TRAFFIC.curveSpeed * (v.kind === 'car' ? 1 : 0.8) * (bend > 1.1 ? 0.65 : 1));

    // stopvonal: megáll, és megvárja, amíg szabad a kereszteződés (menekülés közben nem törődik vele)
    const { edge } = d;
    if (edge.stop > 0 && !d.stopDone && d.panic === 0) {
      const gap = edge.length - edge.stop - spec.length / 2 - 0.4 - d.s;
      if (gap < 0.5) {
        want = 0;
        if (v.speed < 0.3) {
          d.stopWait += dt;
          if (d.stopWait > TRAFFIC.stopWait && (d.stopWait > TRAFFIC.stopMaxWait || this.junctionClear(d))) d.stopDone = true;
        }
      } else want = Math.min(want, Math.sqrt(7 * gap) + 0.6);
    }

    // akadály a jármű előtt
    const gap = this.ahead(d);
    if (gap < Infinity) want = Math.min(want, gap <= 1.2 ? 0 : Math.sqrt(10 * (gap - 1.2)));
    if (gap <= 1.6 && v.speed < 0.4) {
      d.blocked += dt;
      if (this.obstacle === OB_VEHICLE) {
        if (d.blocked > TRAFFIC.passAfter) {
          d.pass = TRAFFIC.passTime;
          d.blocked = 0;
        }
      } else {
        if (this.obstacle === OB_TANK && d.blocked > TRAFFIC.honkAfter && !d.honked) {
          d.honked = true;
          world.events.push({ type: 'honk', x: v.x, y: v.y });
        }
        if (d.blocked > TRAFFIC.turnAfter) {
          // nemrég már megfordult, és megint elakadt: ha senki nem látja, eltűnik, és máshol érkezik helyette új
          if (d.sinceTurn < 14 && !this.humanNear(v.x, v.y, TRAFFIC.unseen)) {
            this.retire(d);
            return;
          }
          this.startTurn(d);
          return;
        }
      }
    } else {
      d.blocked = Math.max(0, d.blocked - dt * 3);
      if (d.blocked === 0) d.honked = false;
    }

    if (v.speed < want) v.speed = Math.min(want, v.speed + TRAFFIC.accel * dt);
    else v.speed = Math.max(want, v.speed - (want === 0 || gap < 4 ? TRAFFIC.hardBrake : TRAFFIC.brake) * dt);

    // kormányzás a sáv előrébb lévő pontja felé; a kormány csak mozgás közben fordít
    const carrot = this.pathPoint(d, d.s + look, this.p1);
    const dx = carrot.x - v.x;
    const dy = carrot.y - v.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.5) {
      const diff = angleDiff(Math.atan2(dy, dx), v.angle);
      const maxTurn = (v.speed / spec.turnRadius) * dt;
      v.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));
    }
    const step = v.speed * dt;
    v.x += Math.cos(v.angle) * step;
    v.y += Math.sin(v.angle) * step;
    // a követett pont a jármű előtt marad: ha a jármű levágta a kanyart, kicsit előreszalad
    d.s += step * Math.max(0.4, Math.min(2.2, 1 + (1.5 * (look - dist)) / look));

    while (d.s >= d.edge.length) {
      if (!d.next) {
        // kihajtott a játéktérről
        if (d.s >= d.edge.length + spec.length / 2 + 1) this.retire(d);
        return;
      }
      d.s -= d.edge.length;
      d.edge = d.next;
      d.next = this.choose(d.edge, v.kind);
      d.stopDone = false;
      d.stopWait = 0;
    }
  }
}
