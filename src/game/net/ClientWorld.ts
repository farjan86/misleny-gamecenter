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
import type { BarrelState, MineState, SmokeState, WorkshopState } from '../sim/gadgets';
import type { TurretState, VehicleState } from '../sim/vehicles';
import { SIM_DT, TANK_LOOKS, World, type BulletState, type OilState, type PickupState, type SimEvent, type TankInput, type TankState, type WreckState } from '../sim/world';
import type { GameLink } from './LocalGame';
import { blankTank, packInput, unpackBarrel, unpackBullet, unpackMine, unpackOil, unpackPickup, unpackSmoke, unpackTank, unpackTurret, unpackVehicle, unpackWreck, mergeSnapshot, type FullSnapshot, type PlayerInfo, type RoomInfo, type Snapshot } from './protocol';

export interface PlayerStanding {
  tank: number;
  name: string;
  kills: number;
  deaths: number;
  /** kilépett a meccsből */
  gone: boolean;
}

/** Ennél nagyobb eltérésnél (m) a tank a helyére ugrik, nem csúszik oda (pl. újraéledés). */
const SNAP_DISTANCE = 8;
const MAX_PENDING = 180;
/** Ennyi lépésig marad meg egy tank, amelyről nem jött újabb hír (a távoli botok ritkábban frissülnek). */
const GONE_AFTER = 45;

export class ClientWorld {
  readonly tanks: TankState[] = [];
  bullets: BulletState[] = [];
  pickups: PickupState[] = [];
  oils: OilState[] = [];
  wrecks: WreckState[] = [];
  vehicles: VehicleState[] = [];
  turrets: TurretState[] = [];
  mines: MineState[] = [];
  smokes: SmokeState[] = [];
  barrels: BarrelState[] = [];
  readonly workshops: readonly WorkshopState[];
  /** a legutóbbi kiolvasás óta érkezett események */
  events: SimEvent[] = [];
  tick = 0;
  /** a saját tank a szerver szerint (null, ha már nincs) */
  me: TankState | null = null;
  /** a tank, amelyet a kamera követ (kiesés után egy másik játékosé) */
  viewId: number;
  standings: PlayerStanding[] = [];
  /** a hátralévő játékidő másodpercben */
  timeLeft: number;
  /** az utolsó pillanatkép érkezésének ideje és a pillanatképek közötti (simított) idő, ms */
  snapAt = 0;
  snapInterval = 50;
  /** érkezett-e pillanatkép az utolsó képkocka óta */
  fresh = false;
  /** a lövedékek, tárgyak, foltok, roncsok listája megváltozott (a megjelenítőket egyeztetni kell) */
  listsChanged = true;

  private readonly byId = new Map<number, TankState>();
  /** az összefésült teljes állapot, és hogy melyik tankról mikor jött utoljára hír (lépésszám) */
  private full: FullSnapshot | null = null;
  private readonly seenAt = new Map<number, number>();
  private readonly predict: World;
  private readonly ptank: TankState;
  private readonly pending: { s: number; input: TankInput }[] = [];
  private seq = 0;
  private offX = 0;
  private offY = 0;
  private readonly names = new Map<number, string>();
  /** a játékosok választott alaptankja; a botoké az azonosítójukból adódik (mint a szerveren) */
  private readonly looks = new Map<number, number>();
  private predicting = false;

  constructor(
    map: GameMap,
    private readonly net: GameLink,
    readonly room: RoomInfo,
    readonly myId: number,
    players: readonly PlayerInfo[],
    /** a javítóműhelyek helye (a meccs alatt nem változnak) */
    workshops: readonly number[][] = [],
    /** menet közbeni belépéskor: ami már le van döntve (a játékjelenet induláskor alkalmazza) */
    readonly destroyed: { b: number[]; p: number[]; a: number[] } | null = null,
  ) {
    this.workshops = workshops.map(([x, y], i) => ({ id: i + 1, x, y }));
    this.viewId = myId;
    // a nyitott játéknak nincs időkorlátja
    this.timeLeft = room.demo ? Infinity : room.settings.minutes * 60;
    for (const p of players) this.addPlayer(p);
    // Az előrejelzés világa: ugyanaz a pálya, de a fák és az épületek állapotát nem
    // változtatja (azt csak a szerver eseményei módosítják).
    this.predict = new World(
      { width: map.width, height: map.height, walls: map.walls, bounds: map.bounds, speedFactor: (x, y) => map.speedFactor(x, y) },
      1,
      { weather: room.settings.weather, mirror: true },
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

  /** Új játékos a meccsben (a nyitott játékba menet közben is beléphetnek): a neve és a választott tankja. */
  addPlayer(p: PlayerInfo): void {
    this.names.set(p.tank, p.name);
    this.looks.set(p.tank, p.look ?? 0);
  }

  /** A tank fajtája (megjelenése). */
  lookOf(tankId: number): number {
    return this.looks.get(tankId) ?? tankId % TANK_LOOKS;
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
    const copy: TankInput = { throttle: input.throttle, turn: input.turn, aim: input.aim, fire: input.fire, drop: input.drop, boost: input.boost, deploy: input.deploy };
    const s = ++this.seq;
    // az aknát, a füstöt, a tüzérségi csapást és az álcázást csak a szerver hajtja végre: az előrejelzésbe nem kerülnek be
    this.net.send({ t: 'input', s, i: packInput({ ...copy, mine: input.mine, smoke: input.smoke, strike: input.strike, cloak: input.cloak }) });
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
    // a lövést, az olajat és az ágyú telepítését csak a szerver hajtja végre
    this.predictInputs.set(this.ptank.id, { throttle: input.throttle, turn: input.turn, aim: input.aim, fire: false, drop: false, boost: input.boost, deploy: false });
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
    // a pillanatkép különbségi: az előző teljes állapottal összefésülve áll elő a mostani
    this.full = mergeSnapshot(this.full, snap, this.myId);

    // tankok: a meglévő objektumok frissülnek (a megjelenítők ezekre hivatkoznak), az eltűntek törlődnek
    const seen = new Set<number>();
    for (const packed of snap.T) {
      const id = packed[0];
      seen.add(id);
      let tank = this.byId.get(id);
      if (!tank) {
        tank = blankTank(id);
        tank.look = this.lookOf(id);
        this.byId.set(id, tank);
        this.tanks.push(tank);
      }
      if (id !== this.myId) unpackTank(packed, tank);
    }
    if (this.full.me) seen.add(this.myId);
    // a távoli botok ritkábban frissülnek: egy tank csak akkor tűnik el, ha egy ideje nem jött róla hír
    for (const id of seen) this.seenAt.set(id, snap.k);
    for (let i = this.tanks.length - 1; i >= 0; i--) {
      const id = this.tanks[i].id;
      if (snap.k - (this.seenAt.get(id) ?? -Infinity) <= GONE_AFTER) continue;
      this.byId.delete(id);
      this.seenAt.delete(id);
      this.tanks.splice(i, 1);
    }

    // a listák közül csak az frissül, amelyik a pillanatképben benne van (vagyis megváltozott)
    if (snap.B) this.bullets = snap.B.map(unpackBullet);
    if (snap.P) this.pickups = snap.P.map(unpackPickup);
    if (snap.O) this.oils = snap.O.map(unpackOil);
    if (snap.W) this.wrecks = snap.W.map(unpackWreck);
    if (snap.V) this.vehicles = snap.V.map(unpackVehicle);
    if (snap.U) this.turrets = snap.U.map(unpackTurret);
    if (snap.M) this.mines = snap.M.map(unpackMine);
    if (snap.K) this.smokes = snap.K.map(unpackSmoke);
    if (snap.G) this.barrels = snap.G.map(unpackBarrel);
    if (snap.B || snap.P || snap.O || snap.W || snap.V || snap.U || snap.M || snap.K || snap.G) this.listsChanged = true;
    if (snap.S) this.standings = snap.S.map(([tank, kills, deaths, gone]) => ({ tank, name: this.nameOf(tank), kills, deaths, gone: gone === 1 }));
    this.timeLeft = snap.r < 0 ? Infinity : snap.r;

    this.reconcile(this.full);
  }

  /** A saját tank igazítása a szerver állapotához, majd a még nem nyugtázott bemenetek újrajátszása. */
  private reconcile(snap: FullSnapshot): void {
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

    // a roncsok az előrejelzésben is akadályok – másolatként: a tank félretolja őket, de a
    // megjelenített helyük a szerveré marad
    this.predict.wrecks.length = 0;
    for (const w of this.wrecks) this.predict.wrecks.push({ ...w });
    // … és a járművek meg az ágyúk is (a tükörvilág nem sebzi őket; a roncsukat tolhatja)
    this.predict.vehicles.length = 0;
    for (const v of this.vehicles) this.predict.vehicles.push({ ...v });
    this.predict.turrets.length = 0;
    this.predict.turrets.push(...this.turrets);

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
