// A játékszerver magja: szobalista, váró, a meccsek futtatása és a
// pillanatképek kiküldése. Nincs benne hálózati kód – a kapcsolatokat egy
// egyszerű `Link` felületen keresztül látja, így a tesztek hálózat nélkül,
// a main.ts pedig WebSocketen keresztül használja.

import { GameMap } from '../src/game/maps/GameMap';
import type { MapData } from '../src/game/maps/types';
import {
  CHAT,
  cleanChat,
  cleanCode,
  encode,
  packBarrel,
  packBullet,
  packMe,
  packMine,
  packOil,
  packPickup,
  packSmoke,
  packTank,
  packTurret,
  packVehicle,
  packWreck,
  PROTOCOL_VERSION,
  ROOM_CODE,
  roundJson,
  SNAPSHOT_EVERY,
  unpackInput,
  VOICE,
  type ClientMessage,
  type RoomInfo,
  type RoomStatus,
  type ServerMessage,
} from '../src/game/net/protocol';
import { applyTempo, MATCH, Match, matchPlan, sanitizeSettings, type MatchPlan, type MatchSettings, DEMO, demoPlayers, type Carry } from '../src/game/sim/match';
import { cleanLook, NO_INPUT, SIM_DT, type SimEvent, type TankInput, type TankState } from '../src/game/sim/world';

export interface Link {
  send(text: string): void;
  close(): void;
}

/** Egy nyitott játék mentett adatai (a szerver újraindítása után ezekből nyílik meg újra). */
export interface StoredOpenGame {
  id: string;
  host: string;
  settings: MatchSettings;
}

/** A nyitott játékok tárolója: a szerveren fájl (data/open-games.json); a böngészőben (egyjátékos mód) nincs. */
export interface OpenGameStore {
  load(): unknown;
  save(games: StoredOpenGame[]): void;
}

export const LIMITS = {
  clients: 400,
  rooms: 60,
  /** ennyi bemenet várakozhat egy játékostól; fölötte a régiek elvesznek (felzárkózás) */
  inputQueue: 8,
  /** a pillanatképbe ekkora körzetből kerülnek be a tankok, illetve a többi elem (m) */
  tankRange: 380,
  nearRange: 185,
  /** a közeli körzeten kívüli botok (ők csak a kis térképen látszanak) csak minden ennyiedik pillanatképben frissülnek */
  farEvery: 4,
  /** a csak látványt adó események ennél messzebbről nem mennek ki (m) */
  eventRange: 240,
  /** ennél több játékosnál a távoli játékosok is csak minden farEvery-edik pillanatképben frissülnek */
  crowd: 8,
  /** a bejelentkezettek listájában legfeljebb ennyi név megy ki */
  onlineList: 80,
  /** ennyi hibás belépőkód után a kapcsolatnak várnia kell (ms) */
  codeTries: 5,
  codeWait: 30000,
} as const;

const STEP_MS = SIM_DT * 1000;

class Client {
  name = '';
  /** a választott alaptank (csak megjelenés) */
  look = 0;
  ready = false;
  room: Room | null = null;
  readonly queue: { s: number; input: TankInput }[] = [];
  last: TankInput = NO_INPUT;
  ack = 0;
  /** amit a kliens a pillanatképekből legutóbb megkapott, mezőnként (JSON-szövegként): csak a változás megy ki */
  readonly sent = new Map<string, string>();
  /** az utóbbi üzenetek időpontjai (az elárasztás ellen) */
  readonly chatTimes: number[] = [];
  /** a hangdarabok számlálója az aktuális másodpercben, és az utolsó továbbadott darab ideje */
  voiceSecond = 0;
  voiceCount = 0;
  voiceAt = -Infinity;
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

/** a nyitott játékból kilépett (vagy a módosításkor újratöltő) játékos állapota ennyi ideig marad meg (ms) */
const PARK_MS = 120000;

class Room {
  status: RoomStatus = 'waiting';
  /** nyitott játék: azonnal indul, bárki bármikor beléphet, addig fut, amíg a gazdája le nem állítja */
  demo = false;
  /** a nyitott játékból kilépettek megőrzött állapota fióknév szerint (szint, felszerelés), és mikor léptek ki */
  readonly parked = new Map<string, { carry: Carry; at: number }>();
  readonly clients: Client[] = [];
  plan: MatchPlan;
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
    /** a nyitott játéknál a gazdája módosíthatja */
    public settings: MatchSettings,
    /** a privát játék belépőkódja (üres: bárki beléphet); a szobán kívülre soha nem megy ki */
    readonly code: string = '',
  ) {
    this.plan = matchPlan(settings);
  }

  info(): RoomInfo {
    return { id: this.id, host: this.host.name, players: this.clients.map((c) => c.name), status: this.status, locked: this.code !== '', settings: this.settings, plan: this.plan, ...(this.demo ? { demo: true } : {}) };
  }
}

/** A csak látványt adó események: ezek csak a közelben lévőknek mennek ki. */
const LOCAL_EVENTS = new Set<SimEvent['type']>(['shot', 'impact', 'laser', 'ricochet', 'oil', 'bump', 'ram', 'structure', 'hit', 'slip', 'pickup', 'respawn', 'blast', 'crushed', 'honk', 'deploy', 'turretDown', 'mine', 'smoke', 'strike', 'boom', 'streak', 'cloak', 'mg']);

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

  /** a szerver gazdáinak fiókneve kisbetűsen: csak ők nyithatnak (és állíthatnak le) nyitott játékot */
  private readonly admins: ReadonlySet<string>;

  /**
   * `countdown`: a meccs indulása előtti visszaszámlálás másodpercben (helyi, egyjátékos játéknál 0).
   * `admins`: a szerver gazdáinak fiókneve (data/admins.txt).
   */
  constructor(
    private readonly mapData: MapData,
    private readonly countdown: number = MATCH.countdown,
    admins: Iterable<string> = [],
    /** a nyitott játékok tárolója: a szerver újraindítása után ezek újra megnyílnak */
    private readonly store: OpenGameStore | null = null,
  ) {
    this.width = mapData.meta.width;
    this.height = mapData.meta.height;
    this.admins = new Set([...admins].map((n) => n.trim().toLowerCase()).filter(Boolean));
    this.restoreOpenGames();
  }

  /**
   * A mentett nyitott játékok újranyitása (üresen, szüneteltetve, amíg valaki be nem lép).
   * A sérült vagy hibás bejegyzés kimarad; csak az nyílik meg, akinek a gazdája ma is a szerver gazdája.
   */
  private restoreOpenGames(): void {
    if (!this.store) return;
    let raw: unknown;
    try {
      raw = this.store.load();
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    for (const entry of raw.slice(0, LIMITS.rooms)) {
      if (!entry || typeof entry !== 'object') continue;
      const { id, host, settings: stored } = entry as Partial<StoredOpenGame>;
      if (typeof id !== 'string' || !/^r\d{1,9}$/.test(id) || this.rooms.has(id)) continue;
      if (typeof host !== 'string' || !this.isAdmin(host)) continue;
      const settings = applyTempo(sanitizeSettings(stored ?? null, this.width, this.height));
      settings.maxPlayers = demoPlayers(stored?.maxPlayers);
      const owner = new Client('host', { send: () => undefined, close: () => undefined });
      owner.name = cleanName(host);
      const room = new Room(id, owner, settings);
      room.demo = true;
      room.plan = matchPlan(settings, true);
      this.rooms.set(id, room);
      this.nextRoom = Math.max(this.nextRoom, Number(id.slice(1)) + 1);
      this.start(room, 0);
    }
  }

  /** A nyitott játékok mentése (létrehozás, módosítás, leállítás után). */
  private saveOpenGames(): void {
    if (!this.store) return;
    const games: StoredOpenGame[] = [...this.rooms.values()].filter((r) => r.demo).map((r) => ({ id: r.id, host: r.host.name, settings: r.settings }));
    try {
      this.store.save(games);
    } catch (error) {
      console.error('A nyitott játékok mentése nem sikerült:', error);
    }
  }

  /** A futó nyitott játékok neve (a szerver induláskor kiírja). */
  get openGames(): string[] {
    return [...this.rooms.values()].filter((r) => r.demo).map((r) => r.settings.name);
  }

  /** A szerver gazdája-e (nyitott játékot nyithat). */
  isAdmin(name: string): boolean {
    return name !== '' && this.admins.has(name.trim().toLowerCase());
  }

  get stats(): { clients: number; rooms: number; playing: number } {
    let playing = 0;
    for (const room of this.rooms.values()) if (room.status === 'playing') playing++;
    return { clients: this.clients.size, rooms: this.rooms.size, playing };
  }

  /** Azoknak a játékosoknak a neve, akik éppen meccsen vannak (a statisztikához). */
  playingNames(): Set<string> {
    const names = new Set<string>();
    for (const room of this.rooms.values()) {
      if (room.status === 'playing') for (const client of room.clients) names.add(client.name);
    }
    return names;
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
      if (this.history.length) client.send({ t: 'chatHistory', lines: this.history });
      this.broadcastOnline();
      return;
    }
    if (!client.ready) return;
    switch (msg.t) {
      case 'ping':
        client.send({ t: 'pong', c: Number(msg.c) || 0 });
        break;
      case 'create':
        client.look = cleanLook(msg.look);
        this.create(client, msg.settings, msg.code, msg.demo === true);
        break;
      case 'closeDemo':
        this.closeDemo(client, String(msg.room));
        break;
      case 'modifyOpen':
        this.modifyOpen(client, String(msg.room), msg.settings);
        break;
      case 'join':
        client.look = cleanLook(msg.look);
        this.join(client, String(msg.room), msg.code);
        break;
      case 'leave':
        this.leave(client, 'Kiléptél a játékból.');
        break;
      case 'chat':
        this.chat(client, msg.text);
        break;
      case 'voice':
        this.voice(client, msg.d);
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

  /** az előszoba utolsó üzenetei: aki belép, megkapja */
  private readonly history: { from: string; text: string }[] = [];

  /** Szöveges üzenet: az előszobában mindenki megkapja, aki a listát nézi; szobában és meccsen a szobatársak. */
  private chat(client: Client, raw: unknown): void {
    const text = cleanChat(raw);
    if (!text) return;
    // elárasztás ellen: rövid időn belül csak néhány üzenet megy át
    const times = client.chatTimes;
    while (times.length && this.now - times[0] > CHAT.window) times.shift();
    if (times.length >= CHAT.burst) {
      client.send({ t: 'error', message: 'Túl gyorsan írsz – várj pár másodpercet.' });
      return;
    }
    times.push(this.now);
    const room = client.room;
    const scope = room ? 'room' : 'lobby';
    const targets = room ? room.clients : [...this.clients.values()].filter((c) => c.ready && !c.room);
    for (const target of targets) target.send({ t: 'chat', from: client.name, text, scope, ...(target === client ? { me: true } : {}) });
    if (!room) {
      this.history.push({ from: client.name, text });
      if (this.history.length > CHAT.history) this.history.shift();
    }
  }

  /** Hangdarab továbbadása a szobatársaknak (a küldőnek nem megy vissza). */
  private voice(client: Client, raw: unknown): void {
    const room = client.room;
    if (!room || typeof raw !== 'string' || raw.length === 0 || raw.length > VOICE.maxChars || !/^[A-Za-z0-9+/]+=*$/.test(raw)) return;
    // darabszám-korlát másodpercenként
    const second = Math.floor(this.now / 1000);
    if (second !== client.voiceSecond) {
      client.voiceSecond = second;
      client.voiceCount = 0;
    }
    if (++client.voiceCount > VOICE.maxPerSecond) return;
    // egyszerre csak néhányan beszélhetnek: aki később kezdi, annak a hangja addig nem megy át
    if (this.now - client.voiceAt > VOICE.quiet) {
      let speaking = 0;
      for (const other of room.clients) if (other !== client && this.now - other.voiceAt <= VOICE.quiet) speaking++;
      if (speaking >= VOICE.speakers) return;
    }
    client.voiceAt = this.now;
    const text = encode({ t: 'voice', from: client.name, d: raw });
    for (const other of room.clients) if (other !== client) other.link.send(text);
  }

  private roomList(): RoomInfo[] {
    return [...this.rooms.values()].map((room) => room.info());
  }

  /** A szobalista kiküldése mindenkinek, aki éppen a listát nézi. */
  private broadcastRooms(): void {
    const text = encode({ t: 'rooms', rooms: this.roomList() });
    for (const client of this.clients.values()) if (client.ready && !client.room) client.link.send(text);
    // ilyenkor az is változhatott, hogy ki hol van
    this.broadcastOnline();
  }

  /**
   * A bejelentkezett játékosok listája (név és hogy hol van) mindenkinek, aki a
   * menükben van: az előszobában és a várókban. A meccsen lévők nem kapják (ott nem látszik).
   */
  private broadcastOnline(): void {
    const players = [...this.clients.values()]
      .filter((c) => c.ready)
      .slice(0, LIMITS.onlineList)
      .map((c) => ({ name: c.name, where: !c.room ? ('lobby' as const) : c.room.status === 'playing' ? ('game' as const) : ('room' as const) }));
    const text = encode({ t: 'online', players });
    for (const client of this.clients.values()) if (client.ready && client.room?.status !== 'playing') client.link.send(text);
  }

  private sendRoom(room: Room, now: number): void {
    const countdown = room.status === 'starting' ? Math.max(0, Math.ceil((room.startAt - now) / 1000)) : 0;
    const info = room.info();
    // a belépőkódot a bent lévők látják (ők már tudják), hogy tovább tudják adni
    for (const client of room.clients) client.send({ t: 'room', room: info, you: client.id, countdown, ...(room.code ? { code: room.code } : {}) });
  }

  private create(client: Client, raw: Partial<MatchSettings>, rawCode?: unknown, demo = false): void {
    if (client.room) return;
    if (this.rooms.size >= LIMITS.rooms) {
      client.send({ t: 'error', message: 'Most nem hozható létre több játék, próbáld később.' });
      return;
    }
    const settings = applyTempo(sanitizeSettings(raw, this.width, this.height));
    if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) settings.name = `${client.name} játéka`;
    if (demo) {
      // nyitott játék: csak a szerver gazdája nyithatja, egyszerre egy fut; nincs belépőkód és időkorlát
      if (!this.isAdmin(client.name)) {
        client.send({ t: 'error', message: 'Nyitott játékot csak a szerver gazdája nyithat.' });
        return;
      }
      settings.maxPlayers = demoPlayers(raw?.maxPlayers);
      // a gazdája nem kerül bele: a nyitott játék üresen indul (amíg senki nincs bent, szünetel),
      // ő a játékok listájánál marad, és ha akar, ugyanúgy beléphet, mint bárki más
      const room = new Room(`r${this.nextRoom++}`, client, settings);
      room.demo = true;
      room.plan = matchPlan(settings, true);
      this.rooms.set(room.id, room);
      this.start(room, this.now);
      this.saveOpenGames();
      return;
    }
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
    if (room.demo) {
      // a nyitott játékba menet közben is be lehet lépni, amíg van hely
      if (room.clients.length >= room.settings.maxPlayers) {
        client.send({ t: 'error', message: 'Ez a nyitott játék most tele van, próbáld kicsit később.' });
        return;
      }
      this.joinRunning(client, room);
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
    // ha minden hely elkelt, rövid visszaszámlálás után indul a meccs (a nyitott játék azonnal indul)
    if (!room.demo && room.clients.length >= room.settings.maxPlayers) {
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
      // a nyitott játékból kilépő szintje és felszerelése egy ideig megmarad: ha visszalép, folytathatja
      if (room.demo && room.match) {
        const carry = room.match.carry(client.id);
        if (carry) this.park(room, client.name, carry);
      }
      room.match?.leave(client.id);
      // a nyitott játék üresen is megmarad (szünetel), amíg a gazdája le nem állítja
      if (room.clients.length === 0 && !room.demo) this.rooms.delete(room.id);
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
    this.broadcastOnline();
  }

  /** Belépés a már futó (nyitott játék) játékba: a játékos tankot kap, a többiek értesülnek róla. */
  private joinRunning(client: Client, room: Room): void {
    const match = room.match;
    if (!match) return;
    client.room = room;
    client.queue.length = 0;
    client.last = NO_INPUT;
    client.ack = 0;
    client.sent.clear();
    room.clients.push(client);
    // aki nemrég lépett ki (vagy a módosítás miatt töltött újra), a szintjével és a felszerelésével folytatja
    const parked = room.parked.get(client.name);
    room.parked.delete(client.name);
    const carry = parked && this.now - parked.at < PARK_MS ? parked.carry : null;
    const player = match.addPlayer(client.id, client.name, client.look, carry);
    const info = { id: player.id, name: player.name, tank: player.tankId, look: player.look };
    for (const other of room.clients) if (other !== client) other.send({ t: 'joined', player: info });
    const destroyed = match.destroyed();
    client.send({ t: 'start', room: room.info(), tank: player.tankId, players: this.playersOf(match), workshops: this.workshopsOf(match), ...(destroyed ? { destroyed } : {}) });
    this.broadcastRooms();
  }

  /** Kilépett játékos állapotának megőrzése a nyitott játékban (a régi bejegyzések törlődnek). */
  private park(room: Room, name: string, carry: Carry): void {
    for (const [key, entry] of room.parked) if (this.now - entry.at >= PARK_MS) room.parked.delete(key);
    room.parked.set(name, { carry, at: this.now });
  }

  /**
   * A futó nyitott játék módosítása (csak a szerver gazdája): új pálya a megadott beállításokkal
   * (játéktér, botok, tárgyak, forgalom, időjárás…). A bent lévők szintje és felszerelése
   * megmarad: a kliensük újratölti az oldalt, visszalép, és az új pályán éled újra. A létszám
   * nem lehet kisebb, mint ahányan éppen bent vannak.
   */
  private modifyOpen(client: Client, id: string, raw: Partial<MatchSettings>): void {
    const room = this.rooms.get(id);
    if (!room || !room.demo) return;
    if (!this.isAdmin(client.name)) {
      client.send({ t: 'error', message: 'A nyitott játékot csak a szerver gazdája módosíthatja.' });
      return;
    }
    const settings = applyTempo(sanitizeSettings(raw, this.width, this.height));
    if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) settings.name = room.settings.name;
    settings.maxPlayers = Math.min(DEMO.maxPlayers, Math.max(demoPlayers(raw?.maxPlayers), room.clients.length));
    // a bent lévők állapota félre: az új pályán ezzel folytatják
    for (const other of room.clients) {
      const carry = room.match?.carry(other.id);
      if (carry) this.park(room, other.name, carry);
      other.room = null;
      other.send({ t: 'reload', room: room.id, reason: 'A játék beállításai megváltoztak – új pálya töltődik be.' });
    }
    room.clients.length = 0;
    room.settings = settings;
    room.plan = matchPlan(settings, true);
    this.start(room, this.now);
    this.saveOpenGames();
  }

  /** A nyitott játék leállítása (csak a szerver gazdája): mindenki visszakerül a játékok listájához. */
  private closeDemo(client: Client, id: string): void {
    const room = this.rooms.get(id);
    if (!room || !room.demo) return;
    if (!this.isAdmin(client.name)) {
      client.send({ t: 'error', message: 'A nyitott játékot csak a szerver gazdája állíthatja le.' });
      return;
    }
    for (const other of room.clients) {
      other.room = null;
      other.send({ t: 'left', reason: 'A nyitott játékot leállították.' });
    }
    room.clients.length = 0;
    this.rooms.delete(room.id);
    this.saveOpenGames();
    this.broadcastRooms();
  }

  private playersOf(match: Match): { id: string; name: string; tank: number; look: number }[] {
    return match.players.filter((p) => !p.gone).map((p) => ({ id: p.id, name: p.name, tank: p.tankId, look: p.look }));
  }

  private workshopsOf(match: Match): number[][] {
    return match.world.workshops.map((w) => [Math.round(w.x * 10) / 10, Math.round(w.y * 10) / 10]);
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
      room.clients.map((c) => ({ id: c.id, name: c.name, look: c.look })),
      seed,
      room.demo,
    );
    room.status = 'playing';
    room.acc = 0;
    room.last = now;
    room.events = [];
    const info = room.info();
    const players = this.playersOf(room.match);
    const workshops = this.workshopsOf(room.match);
    for (const client of room.clients) {
      client.queue.length = 0;
      client.last = NO_INPUT;
      client.ack = 0;
      // új meccs: a kliens még semmit nem kapott meg, az első pillanatkép teljes
      client.sent.clear();
      client.send({ t: 'start', room: info, tank: room.match.player(client.id)?.tankId ?? 0, players, workshops });
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
      // az üres nyitott játék szünetel: senki nem látja, fölösleges számolni
      if (room.demo && room.clients.length === 0) {
        room.last = now;
        room.acc = 0;
        continue;
      }
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

    // A pillanatkép szövege mezőnként áll össze: minden mező csak akkor kerül bele,
    // ha más, mint amit ez a kliens legutóbb kapott (a tankok mindig mennek).
    const sent = client.sent;
    const parts: string[] = ['"t":"snap"', `"k":${world.tick}`, `"a":${client.ack}`, `"v":${view?.id ?? 0}`, `"r":${match.endless ? -1 : Math.ceil(match.timeLeft)}`];
    const put = (key: string, value: unknown): void => {
      const text = roundJson(value);
      if (sent.get(key) === text) return;
      sent.set(key, text);
      parts.push(`"${key}":${text}`);
    };

    // a saját tank: csak a megváltozott mezők
    if (!own) put('me', null);
    else {
      sent.delete('me');
      const state = packMe(own) as Record<string, unknown>;
      let delta = '';
      for (const key in state) {
        const text = roundJson(state[key]);
        const id = `me.${key}`;
        if (sent.get(id) === text) continue;
        sent.set(id, text);
        delta += `${delta ? ',' : ''}"${key}":${text}`;
      }
      if (delta) parts.push(`"me":{${delta}}`);
    }

    // a közeli tankok és minden játékos (ők a térképen mindig látszanak) minden pillanatképben;
    // a távoli botok csak a kis térképen látszanak: ritkábban frissülnek
    const far = (world.tick / SNAPSHOT_EVERY) % LIMITS.farEvery === 0;
    // sok játékosnál (nyitott játék) a távoli játékosok is ritkábban frissülnek: ők is csak a kis térképen látszanak
    const crowded = match.players.length > LIMITS.crowd;
    const tanks: number[][] = [];
    for (const t of world.tanks) {
      // a saját tank állapota külön megy (me): a listában nem ismétlődik
      if (t === own) continue;
      if (near(t, LIMITS.nearRange)) tanks.push(packTank(t));
      else if (!t.bot && (!crowded || far)) tanks.push(packTank(t));
      else if (far && near(t, LIMITS.tankRange)) tanks.push(packTank(t));
    }
    parts.push(`"T":${roundJson(tanks)}`);

    const radar = own !== null && own.effects.radar > 0;
    put('B', world.bullets.filter((b) => near(b, LIMITS.nearRange)).map(packBullet));
    // a szupertárgy mindenkinek látszik a térképen, bármilyen messze van
    put('P', world.pickups.filter((p) => p.kind === 'super' || near(p, radar ? LIMITS.tankRange : LIMITS.nearRange)).map(packPickup));
    put('O', world.oils.filter((o) => near(o, LIMITS.nearRange)).map(packOil));
    put('W', world.wrecks.filter((w) => near(w, LIMITS.nearRange)).map(packWreck));
    put('V', world.vehicles.filter((v) => near(v, LIMITS.nearRange)).map(packVehicle));
    put('U', world.turrets.filter((t) => near(t, LIMITS.nearRange)).map(packTurret));
    put('M', world.mines.filter((m) => near(m, LIMITS.nearRange)).map(packMine));
    put('K', world.smokes.filter((s) => near(s, LIMITS.nearRange)).map(packSmoke));
    put('G', world.barrels.filter((b) => near(b, LIMITS.nearRange)).map(packBarrel));
    put(
      'S',
      match.players.map((p) => {
        const tank = world.tank(p.tankId);
        return [p.tankId, tank ? tank.kills : 0, tank ? tank.deaths : 0, p.gone ? 1 : 0];
      }),
    );
    client.link.send(`{${parts.join(',')}}`);
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
