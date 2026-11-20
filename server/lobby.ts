// A játékszerver magja: szobalista, váró, a meccsek futtatása és a
// pillanatképek kiküldése. Nincs benne hálózati kód – a kapcsolatokat egy
// egyszerű `Link` felületen keresztül látja, így a tesztek hálózat nélkül,
// a main.ts pedig WebSocketen keresztül használja.

import { GameMap } from '../src/game/maps/GameMap';
import type { MapData } from '../src/game/maps/types';
import {
  cleanCode,
  encode,
  packBullet,
  packOil,
  packPickup,
  packTank,
  packTurret,
  packVehicle,
  packWreck,
  PROTOCOL_VERSION,
  ROOM_CODE,
  SNAPSHOT_EVERY,
  unpackInput,
  type ClientMessage,
  type RoomInfo,
  type RoomStatus,
  type ServerMessage,
  type Snapshot,
} from '../src/game/net/protocol';
import { MATCH, Match, matchPlan, sanitizeSettings, type MatchPlan, type MatchSettings } from '../src/game/sim/match';
import { NO_INPUT, SIM_DT, type SimEvent, type TankInput, type TankState } from '../src/game/sim/world';

export interface Link {
  send(text: string): void;
  close(): void;
}

export const LIMITS = {
  clients: 400,
  rooms: 60,
  /** ennyi bemenet várakozhat egy játékostól; fölötte a régiek elvesznek (felzárkózás) */
  inputQueue: 8,
  /** a pillanatképbe ekkora körzetből kerülnek be a tankok, illetve a többi elem (m) */
  tankRange: 380,
  nearRange: 185,
  /** a csak látványt adó események ennél messzebbről nem mennek ki (m) */
  eventRange: 240,
  /** ennyi hibás belépőkód után a kapcsolatnak várnia kell (ms) */
  codeTries: 5,
  codeWait: 30000,
} as const;

const STEP_MS = SIM_DT * 1000;

class Client {
  name = '';
  ready = false;
  room: Room | null = null;
  readonly queue: { s: number; input: TankInput }[] = [];
  last: TankInput = NO_INPUT;
  ack = 0;
  /** a hibás belépőkódok száma és az utolsó időpontja (a találgatás lassítására) */
  badCodes = 0;
  badCodeAt = 0;

  constructor(
    readonly id: string,
    readonly link: Link,
  ) {}

  send(message: ServerMessage): void {
    this.link.send(encode(message));
  }
}

class Room {
  status: RoomStatus = 'waiting';
  readonly clients: Client[] = [];
  readonly plan: MatchPlan;
  match: Match | null = null;
  /** a visszaszámlálás vége (ms) */
  startAt = 0;
  /** a szimuláció fel nem használt ideje (ms) és az utolsó léptetés időpontja */
  acc = 0;
  last = 0;
  /** a legutóbbi pillanatkép óta történt események */
  events: SimEvent[] = [];
  lastCountdown = -1;

  constructor(
    readonly id: string,
    readonly host: Client,
    readonly settings: MatchSettings,
    /** a privát játék belépőkódja (üres: bárki beléphet); a szobán kívülre soha nem megy ki */
    readonly code: string = '',
  ) {
    this.plan = matchPlan(settings);
  }

  info(): RoomInfo {
    return { id: this.id, host: this.host.name, players: this.clients.map((c) => c.name), status: this.status, locked: this.code !== '', settings: this.settings, plan: this.plan };
  }
}

/** A csak látványt adó események: ezek csak a közelben lévőknek mennek ki. */
const LOCAL_EVENTS = new Set<SimEvent['type']>(['shot', 'impact', 'laser', 'ricochet', 'oil', 'bump', 'hit', 'slip', 'pickup', 'respawn', 'blast', 'crushed', 'honk', 'deploy', 'turretDown']);

function eventPosition(ev: SimEvent): { x: number; y: number } | null {
  if (ev.type === 'laser') return { x: ev.x1, y: ev.y1 };
  return 'x' in ev ? { x: ev.x, y: ev.y } : null;
}

export class Lobby {
  private readonly clients = new Map<string, Client>();
  private readonly rooms = new Map<string, Room>();
  private nextClient = 1;
  private nextRoom = 1;
  private readonly width: number;
  private readonly height: number;

  /** `countdown`: a meccs indulása előtti visszaszámlálás másodpercben (helyi, egyjátékos játéknál 0). */
  constructor(
    private readonly mapData: MapData,
    private readonly countdown: number = MATCH.countdown,
  ) {
    this.width = mapData.meta.width;
    this.height = mapData.meta.height;
  }

  get stats(): { clients: number; rooms: number; playing: number } {
    let playing = 0;
    for (const room of this.rooms.values()) if (room.status === 'playing') playing++;
    return { clients: this.clients.size, rooms: this.rooms.size, playing };
  }

  /** Új kapcsolat; a visszaadott függvényekkel kell jelezni a beérkező üzenetet és a bontást. */
  connect(link: Link): { message(text: string): void; close(): void } {
    if (this.clients.size >= LIMITS.clients) {
      link.send(encode({ t: 'error', message: 'A szerver megtelt, próbáld később.' }));
      link.close();
      return { message: () => undefined, close: () => undefined };
    }
    const client = new Client(`c${this.nextClient++}`, link);
    this.clients.set(client.id, client);
    return {
      message: (text) => this.onMessage(client, text),
      close: () => this.disconnect(client),
    };
  }

  private onMessage(client: Client, text: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL_VERSION) {
        client.send({ t: 'error', message: 'A játék frissült – töltsd újra az oldalt (Ctrl+F5).' });
        return;
      }
      client.name = cleanName(msg.name) || `Tank ${client.id.slice(1)}`;
      client.ready = true;
      client.send({ t: 'welcome', id: client.id, map: { width: this.width, height: this.height } });
      client.send({ t: 'rooms', rooms: this.roomList() });
      return;
    }
    if (!client.ready) return;
    switch (msg.t) {
      case 'ping':
        client.send({ t: 'pong', c: Number(msg.c) || 0 });
        break;
      case 'create':
        this.create(client, msg.settings, msg.code);
        break;
      case 'join':
        this.join(client, String(msg.room), msg.code);
        break;
      case 'leave':
        this.leave(client, 'Kiléptél a játékból.');
        break;
      case 'input': {
        const input = unpackInput(msg.i);
        if (!input || !client.room || client.room.status !== 'playing') break;
        client.queue.push({ s: Number(msg.s) || 0, input });
        // lemaradt (pl. akadozó hálózat): a régi bemeneteket eldobjuk, hogy a késés ne halmozódjon
        if (client.queue.length > LIMITS.inputQueue) client.queue.splice(0, client.queue.length - 2);
        break;
      }
    }
  }

  private roomList(): RoomInfo[] {
    return [...this.rooms.values()].map((room) => room.info());
  }

  /** A szobalista kiküldése mindenkinek, aki éppen a listát nézi. */
  private broadcastRooms(): void {
    const text = encode({ t: 'rooms', rooms: this.roomList() });
    for (const client of this.clients.values()) if (client.ready && !client.room) client.link.send(text);
  }

  private sendRoom(room: Room, now: number): void {
    const countdown = room.status === 'starting' ? Math.max(0, Math.ceil((room.startAt - now) / 1000)) : 0;
    const info = room.info();
    // a belépőkódot a bent lévők látják (ők már tudják), hogy tovább tudják adni
    for (const client of room.clients) client.send({ t: 'room', room: info, you: client.id, countdown, ...(room.code ? { code: room.code } : {}) });
  }

  private create(client: Client, raw: Partial<MatchSettings>, rawCode?: unknown): void {
    if (client.room) return;
    if (this.rooms.size >= LIMITS.rooms) {
      client.send({ t: 'error', message: 'Most nem hozható létre több játék, próbáld később.' });
      return;
    }
    const settings = sanitizeSettings(raw, this.width, this.height);
    if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) settings.name = `${client.name} játéka`;
    const code = cleanCode(rawCode);
    if (code && code.length < ROOM_CODE.min) {
      client.send({ t: 'error', message: `A belépőkód legalább ${ROOM_CODE.min} karakter legyen.` });
      return;
    }
    const room = new Room(`r${this.nextRoom++}`, client, settings, code);
    this.rooms.set(room.id, room);
    this.enter(client, room);
  }

  private join(client: Client, id: string, rawCode?: unknown): void {
    if (client.room) return;
    const room = this.rooms.get(id);
    if (!room) {
      client.send({ t: 'error', message: 'Ez a játék már nem létezik.' });
      return;
    }
    if (room.status === 'playing' || room.clients.length >= room.settings.maxPlayers) {
      client.send({ t: 'error', message: 'Ez a játék már betelt.' });
      return;
    }
    if (room.code) {
      // privát játék: csak a helyes kóddal; a sorozatos találgatást várakozás lassítja
      if (client.badCodes >= LIMITS.codeTries && this.now - client.badCodeAt < LIMITS.codeWait) {
        client.send({ t: 'error', message: 'Túl sok hibás kód – várj fél percet, mielőtt újra próbálod.' });
        return;
      }
      if (cleanCode(rawCode) !== room.code) {
        if (this.now - client.badCodeAt >= LIMITS.codeWait) client.badCodes = 0;
        client.badCodes++;
        client.badCodeAt = this.now;
        client.send({ t: 'error', message: 'Hibás belépőkód.' });
        return;
      }
      client.badCodes = 0;
    }
    this.enter(client, room);
  }

  private enter(client: Client, room: Room): void {
    client.room = room;
    client.queue.length = 0;
    client.last = NO_INPUT;
    client.ack = 0;
    room.clients.push(client);
    // ha minden hely elkelt, rövid visszaszámlálás után indul a meccs
    if (room.clients.length >= room.settings.maxPlayers) {
      room.status = 'starting';
      room.startAt = this.now + this.countdown * 1000;
      room.lastCountdown = -1;
    }
    this.sendRoom(room, this.now);
    this.broadcastRooms();
  }

  private now = 0;

  private leave(client: Client, reason: string): void {
    const room = client.room;
    if (!room) return;
    client.room = null;
    const at = room.clients.indexOf(client);
    if (at >= 0) room.clients.splice(at, 1);
    if (this.clients.has(client.id)) client.send({ t: 'left', reason });

    if (room.status === 'playing') {
      room.match?.leave(client.id);
      if (room.clients.length === 0) this.rooms.delete(room.id);
    } else if (client === room.host || room.clients.length === 0) {
      // a váróból a host lépett ki: a szoba megszűnik, a többiek visszakerülnek a listához
      for (const other of room.clients) {
        other.room = null;
        other.send({ t: 'left', reason: 'A játék létrehozója kilépett, a szoba megszűnt.' });
      }
      this.rooms.delete(room.id);
    } else {
      // valaki kilépett a visszaszámlálás alatt: újra várni kell
      room.status = 'waiting';
      this.sendRoom(room, this.now);
    }
    if (this.clients.has(client.id)) client.send({ t: 'rooms', rooms: this.roomList() });
    this.broadcastRooms();
  }

  private disconnect(client: Client): void {
    this.clients.delete(client.id);
    this.leave(client, '');
  }

  private start(room: Room, now: number): void {
    // minden meccs saját pályapéldányt kap: a sérülései (kidőlt fák, összedőlt házak) a sajátjai
    const map = new GameMap(this.mapData);
    map.setArea(room.settings.area);
    map.weather = room.settings.weather;
    const seed = (Math.floor(now) % 2147483000) + room.clients.length * 7919 + 1;
    room.match = new Match(
      map,
      room.settings,
      room.clients.map((c) => ({ id: c.id, name: c.name })),
      seed,
    );
    room.status = 'playing';
    room.acc = 0;
    room.last = now;
    room.events = [];
    const info = room.info();
    const players = room.match.players.map((p) => ({ id: p.id, name: p.name, tank: p.tankId }));
    for (const client of room.clients) {
      client.queue.length = 0;
      client.last = NO_INPUT;
      client.ack = 0;
      client.send({ t: 'start', room: info, tank: room.match.player(client.id)?.tankId ?? 0, players });
    }
    this.broadcastRooms();
  }

  /** Az idő múlása: visszaszámlálások, a meccsek léptetése, pillanatképek. `now`: ezredmásodperc. */
  tick(now: number): void {
    this.now = now;
    for (const room of [...this.rooms.values()]) {
      if (room.status === 'starting') {
        const left = Math.ceil((room.startAt - now) / 1000);
        if (now >= room.startAt) this.start(room, now);
        else if (left !== room.lastCountdown) {
          room.lastCountdown = left;
          this.sendRoom(room, now);
        }
        continue;
      }
      if (room.status !== 'playing' || !room.match) continue;
      room.acc = Math.min(room.acc + (now - room.last), STEP_MS * 6);
      room.last = now;
      while (room.acc >= STEP_MS && !room.match.over) {
        room.acc -= STEP_MS;
        this.step(room);
      }
      if (room.match.over) this.finish(room);
    }
  }

  private readonly inputs = new Map<string, TankInput>();

  private step(room: Room): void {
    const match = room.match!;
    this.inputs.clear();
    for (const client of room.clients) {
      const next = client.queue.shift();
      if (next) {
        client.last = next.input;
        client.ack = next.s;
      }
      this.inputs.set(client.id, client.last);
    }
    match.step(this.inputs);
    if (match.world.events.length) room.events.push(...match.world.events);
    if (match.world.tick % SNAPSHOT_EVERY !== 0) return;
    for (const client of room.clients) this.sendState(room, client);
    room.events = [];
  }

  /** Annak a tanknak az állapota, amelyet a játékos kamerája követ: a sajátja (ha valamiért nincs, egy másik játékosé). */
  private viewTank(match: Match, client: Client): TankState | undefined {
    const own = match.tankOf(client.id);
    if (own && !own.out) return own;
    for (const p of match.players) {
      if (p.gone) continue;
      const tank = match.world.tank(p.tankId);
      if (tank && !tank.out) return tank;
    }
    return own;
  }

  private sendState(room: Room, client: Client): void {
    const match = room.match!;
    const { world } = match;
    const own = match.tankOf(client.id) ?? null;
    const view = this.viewTank(match, client);
    const cx = view?.x ?? 0;
    const cy = view?.y ?? 0;
    const near = (o: { x: number; y: number }, range: number): boolean => Math.abs(o.x - cx) < range && Math.abs(o.y - cy) < range;

    const events = room.events.filter((ev) => {
      if (!LOCAL_EVENTS.has(ev.type)) return true;
      if ('tank' in ev && own && ev.tank === own.id) return true;
      const at = eventPosition(ev);
      return at ? near(at, LIMITS.eventRange) : false;
    });
    if (events.length) client.send({ t: 'ev', e: events });

    const radar = own !== null && own.effects.radar > 0;
    const snap: Snapshot = {
      t: 'snap',
      k: world.tick,
      a: client.ack,
      me: own,
      v: view?.id ?? 0,
      // a közeli tankok, és minden játékos (ők a térképen mindig látszanak)
      T: world.tanks.filter((t) => !t.bot || near(t, LIMITS.tankRange)).map(packTank),
      B: world.bullets.filter((b) => near(b, LIMITS.nearRange)).map(packBullet),
      P: world.pickups.filter((p) => near(p, radar ? LIMITS.tankRange : LIMITS.nearRange)).map(packPickup),
      O: world.oils.filter((o) => near(o, LIMITS.nearRange)).map(packOil),
      W: world.wrecks.filter((w) => near(w, LIMITS.nearRange)).map(packWreck),
      V: world.vehicles.filter((v) => near(v, LIMITS.nearRange)).map(packVehicle),
      U: world.turrets.filter((t) => near(t, LIMITS.nearRange)).map(packTurret),
      S: match.players.map((p) => {
        const tank = world.tank(p.tankId);
        return [p.tankId, tank ? tank.kills : 0, tank ? tank.deaths : 0, p.gone ? 1 : 0];
      }),
      r: Math.ceil(match.timeLeft),
    };
    client.send(snap);
  }

  private finish(room: Room): void {
    const match = room.match!;
    const standings = match.standings();
    for (const client of room.clients) {
      if (room.events.length) client.send({ t: 'ev', e: room.events });
      client.send({ t: 'over', winner: match.winner, standings });
      client.room = null;
    }
    // a befejezett játék eltűnik a listából
    this.rooms.delete(room.id);
    this.broadcastRooms();
  }
}

function cleanName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18) : '';
}
