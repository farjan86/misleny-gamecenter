// A szerveren futó meccs tükre a kliensen. A szerver pillanatképeiből tartja
// karban a tankok, lövedékek, tárgyak állapotát (a megjelenítés ezt olvassa),
// és a saját tank mozgását előre számolja, hogy az irányítás ne késsen:
//
//   - minden bemenet sorszámot kap, elmegy a szervernek, és helyben is azonnal
//     lejátszódik egy saját, egytankos szimuláción (ugyanaz a kód, mint a szerveren);
//   - a pillanatkép megmondja, melyik bemenetig jutott a szerver, és ott mi volt a
//     tank állapota: innen a még nem nyugtázott bemenetek újra lejátszódnak;
//   - ha az eredmény eltér attól, amit addig mutattunk, a különbség néhány
//     képkocka alatt, simán tűnik el.

import type { GameMap } from '../maps/GameMap';
import { SIM_DT, World, type BulletState, type OilState, type PickupState, type SimEvent, type TankInput, type TankState, type WreckState } from '../sim/world';
import type { NetClient } from './NetClient';
import { blankTank, packInput, unpackBullet, unpackOil, unpackPickup, unpackTank, unpackWreck, type PlayerInfo, type RoomInfo, type Snapshot } from './protocol';

export interface PlayerStanding {
  tank: number;
  name: string;
  lives: number;
  kills: number;
  out: boolean;
}

/** Ennél nagyobb eltérésnél (m) a tank a helyére ugrik, nem csúszik oda (pl. újraéledés). */
const SNAP_DISTANCE = 8;
const MAX_PENDING = 180;

export class ClientWorld {
  readonly tanks: TankState[] = [];
  bullets: BulletState[] = [];
  pickups: PickupState[] = [];
  oils: OilState[] = [];
  wrecks: WreckState[] = [];
  /** a legutóbbi kiolvasás óta érkezett események */
  events: SimEvent[] = [];
  tick = 0;
  /** a saját tank a szerver szerint (null, ha már nincs) */
  me: TankState | null = null;
  /** a tank, amelyet a kamera követ (kiesés után egy másik játékosé) */
  viewId: number;
  standings: PlayerStanding[] = [];
  /** az utolsó pillanatkép érkezésének ideje és a pillanatképek közötti (simított) idő, ms */
  snapAt = 0;
  snapInterval = 50;
  /** érkezett-e pillanatkép az utolsó képkocka óta */
  fresh = false;
  /** a lövedékek, tárgyak, foltok, roncsok listája megváltozott (a megjelenítőket egyeztetni kell) */
  listsChanged = true;

  private readonly byId = new Map<number, TankState>();
  private readonly predict: World;
  private readonly ptank: TankState;
  private readonly pending: { s: number; input: TankInput }[] = [];
  private seq = 0;
  private offX = 0;
  private offY = 0;
  private readonly names = new Map<number, string>();
  private predicting = false;

  constructor(
    map: GameMap,
    private readonly net: NetClient,
    readonly room: RoomInfo,
    readonly myId: number,
    players: readonly PlayerInfo[],
  ) {
    this.viewId = myId;
    for (const p of players) this.names.set(p.tank, p.name);
    // Az előrejelzés világa: ugyanaz a pálya, de a fák és az épületek állapotát nem
    // változtatja (azt csak a szerver eseményei módosítják).
    this.predict = new World(
      { width: map.width, height: map.height, walls: map.walls, bounds: map.bounds, speedFactor: (x, y) => map.speedFactor(x, y) },
      1,
      { weather: room.settings.weather },
    );
    this.ptank = this.predict.addTank(0, 0, 0);
  }

  tank(id: number): TankState | undefined {
    return this.byId.get(id);
  }

  /** a szerver válaszideje ezredmásodpercben */
  get pingMs(): number {
    return this.net.ping;
  }

  nameOf(tankId: number): string {
    return this.names.get(tankId) ?? 'Bot';
  }

  /** A saját tank, ahogy a képernyőn látszik (előre számolt mozgással); null, ha nincs. */
  get own(): TankState | undefined {
    return this.byId.get(this.myId);
  }

  /** A tank, amelyet a kamera követ. */
  get focus(): TankState | undefined {
    return this.byId.get(this.viewId) ?? this.own;
  }

  /** Egy szimulációs lépésnyi bemenet: elküldi a szervernek, és helyben is lejátssza. */
  input(input: TankInput): void {
    const copy: TankInput = { throttle: input.throttle, turn: input.turn, aim: input.aim, fire: input.fire, drop: input.drop, boost: input.boost };
    const s = ++this.seq;
    this.net.send({ t: 'input', s, i: packInput(copy) });
    if (!this.predicting) return;
    this.pending.push({ s, input: copy });
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    this.stepPrediction(copy);
    // a korábbi eltérés fokozatosan eltűnik
    this.offX *= 0.82;
    this.offY *= 0.82;
    this.showPrediction();
  }

  private readonly predictInputs = new Map<number, TankInput>();

  private stepPrediction(input: TankInput): void {
    // a lövést és az olajat csak a szerver hajtja végre
    this.predictInputs.set(this.ptank.id, { throttle: input.throttle, turn: input.turn, aim: input.aim, fire: false, drop: false, boost: input.boost });
    this.predict.step(this.predictInputs, SIM_DT);
    this.predict.bullets.length = 0;
  }

  /** Az előre számolt mozgás átírása a megjelenített saját tankba. */
  private showPrediction(): void {
    const shown = this.byId.get(this.myId);
    if (!shown) return;
    const p = this.ptank;
    shown.x = p.x + this.offX;
    shown.y = p.y + this.offY;
    shown.hullAngle = p.hullAngle;
    shown.turretAngle = p.turretAngle;
    shown.speed = p.speed;
    shown.turnSpeed = p.turnSpeed;
    shown.odometer = p.odometer;
    shown.heat = p.heat;
    shown.overheated = p.overheated;
    shown.boosting = p.boosting;
    shown.slip = p.slip;
  }

  receiveEvents(events: SimEvent[]): void {
    this.events.push(...events);
  }

  receive(snap: Snapshot, now: number): void {
    if (this.snapAt > 0) this.snapInterval += (Math.min(250, now - this.snapAt) - this.snapInterval) * 0.1;
    this.snapAt = now;
    this.fresh = true;
    this.tick = snap.k;
    this.viewId = snap.v;

    // tankok: a meglévő objektumok frissülnek (a megjelenítők ezekre hivatkoznak), az eltűntek törlődnek
    const seen = new Set<number>();
    for (const packed of snap.T) {
      const id = packed[0];
      seen.add(id);
      let tank = this.byId.get(id);
      if (!tank) {
        tank = blankTank(id);
        this.byId.set(id, tank);
        this.tanks.push(tank);
      }
      if (id !== this.myId) unpackTank(packed, tank);
    }
    if (snap.me) seen.add(this.myId);
    for (let i = this.tanks.length - 1; i >= 0; i--) {
      if (seen.has(this.tanks[i].id)) continue;
      this.byId.delete(this.tanks[i].id);
      this.tanks.splice(i, 1);
    }

    this.bullets = snap.B.map(unpackBullet);
    this.pickups = snap.P.map(unpackPickup);
    this.oils = snap.O.map(unpackOil);
    this.wrecks = snap.W.map(unpackWreck);
    this.listsChanged = true;
    this.standings = snap.S.map(([tank, lives, kills, out]) => ({ tank, name: this.nameOf(tank), lives, kills, out: out === 1 }));

    this.reconcile(snap);
  }

  /** A saját tank igazítása a szerver állapotához, majd a még nem nyugtázott bemenetek újrajátszása. */
  private reconcile(snap: Snapshot): void {
    const me = snap.me;
    this.me = me;
    if (!me) {
      this.predicting = false;
      return;
    }
    let shown = this.byId.get(this.myId);
    if (!shown) {
      shown = blankTank(this.myId);
      this.byId.set(this.myId, shown);
      this.tanks.push(shown);
    }
    const beforeX = this.ptank.x + this.offX;
    const beforeY = this.ptank.y + this.offY;
    const wasPredicting = this.predicting;

    // a megjelenített tank minden nem mozgási adata (életerő, fegyver, életek…) a szerveré
    Object.assign(shown, me, { effects: { ...me.effects } });
    Object.assign(this.ptank, me, { id: this.ptank.id, effects: { ...me.effects } });
    this.predicting = me.alive && !me.out;
    if (!this.predicting) {
      this.pending.length = 0;
      this.offX = 0;
      this.offY = 0;
      return;
    }

    // a roncsok az előrejelzésben is akadályok
    this.predict.wrecks.length = 0;
    this.predict.wrecks.push(...this.wrecks);

    while (this.pending.length && this.pending[0].s <= snap.a) this.pending.shift();
    for (const p of this.pending) this.stepPrediction(p.input);

    const errX = beforeX - this.ptank.x;
    const errY = beforeY - this.ptank.y;
    if (!wasPredicting || Math.hypot(errX, errY) > SNAP_DISTANCE) {
      this.offX = 0;
      this.offY = 0;
    } else {
      this.offX = errX;
      this.offY = errY;
    }
    this.showPrediction();
  }
}
