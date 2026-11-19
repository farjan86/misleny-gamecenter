// A szerver magja hálózat nélkül: szobalista, váró, indulás, pillanatképek, a meccs vége.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../server/accounts';
import { Gate } from '../server/gate';
import { Lobby } from '../server/lobby';
import type { MapData } from '../src/game/maps/types';
import { encode, packInput, PROTOCOL_VERSION, type ClientMessage, type RoomInfo, type ServerMessage, type Snapshot } from '../src/game/net/protocol';
import { MATCH } from '../src/game/sim/match';

const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;

class FakeClient {
  readonly inbox: ServerMessage[] = [];
  closed = false;
  private readonly session: { message(text: string): void; close(): void };

  constructor(lobby: Lobby, name: string) {
    this.session = lobby.connect({ send: (text) => this.inbox.push(JSON.parse(text) as ServerMessage), close: () => (this.closed = true) });
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name });
  }

  send(message: ClientMessage): void {
    this.session.message(encode(message));
  }

  disconnect(): void {
    this.session.close();
  }

  last<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i].t === type) return this.inbox[i] as Extract<ServerMessage, { t: T }>;
    return undefined;
  }

  rooms(): RoomInfo[] {
    return this.last('rooms')?.rooms ?? [];
  }
}

const small = { area: { minX: 500, minY: 500, maxX: 1000, maxY: 1000 }, bots: 1, pickups: 2, lives: 1 };

describe('szobalista és váró', () => {
  it('a létrehozott szoba megjelenik a listában, és látszik, hányan várnak', () => {
    const lobby = new Lobby(data);
    const host = new FakeClient(lobby, 'Anna');
    const guest = new FakeClient(lobby, 'Béla');
    expect(host.last('welcome')?.map).toEqual({ width: 2000, height: 3460 });
    expect(guest.rooms()).toEqual([]);

    host.send({ t: 'create', settings: { ...small, name: 'Esti csata', maxPlayers: 3, weather: 'night' } });
    const room = guest.rooms()[0];
    expect(room).toMatchObject({ host: 'Anna', players: ['Anna'], status: 'waiting' });
    expect(room.settings).toMatchObject({ name: 'Esti csata', maxPlayers: 3, weather: 'night', lives: 1 });
    expect(room.plan.bots).toBeGreaterThanOrEqual(1);
    expect(host.last('room')?.room.players).toEqual(['Anna']);

    guest.send({ t: 'join', room: room.id });
    expect(host.last('room')?.room.players).toEqual(['Anna', 'Béla']);
    expect(host.last('room')?.room.status).toBe('waiting');
    // a harmadik játékos a listában azt látja, hogy ketten várnak
    const third = new FakeClient(lobby, 'Cili');
    expect(third.rooms()[0].players).toHaveLength(2);
  });

  it('ha a host kilép a váróból, a szoba megszűnik, a többiek visszakerülnek a listához', () => {
    const lobby = new Lobby(data);
    const host = new FakeClient(lobby, 'Anna');
    const guest = new FakeClient(lobby, 'Béla');
    host.send({ t: 'create', settings: { ...small, maxPlayers: 3 } });
    guest.send({ t: 'join', room: guest.rooms()[0].id });
    host.disconnect();
    expect(guest.last('left')?.reason).toContain('megszűnt');
    expect(guest.rooms()).toEqual([]);
    expect(lobby.stats.rooms).toBe(0);
  });

  it('a betelt vagy megszűnt szobába nem lehet belépni; a hibás verziójú kliens hibát kap', () => {
    const lobby = new Lobby(data);
    const host = new FakeClient(lobby, 'Anna');
    const b = new FakeClient(lobby, 'Béla');
    const c = new FakeClient(lobby, 'Cili');
    host.send({ t: 'create', settings: { ...small, maxPlayers: 2 } });
    const id = b.rooms()[0].id;
    b.send({ t: 'join', room: id });
    c.send({ t: 'join', room: id });
    expect(c.last('error')?.message).toContain('betelt');
    c.send({ t: 'join', room: 'nincs-ilyen' });
    expect(c.last('error')?.message).toContain('nem létezik');

    const old = lobby.connect({ send: (text) => oldInbox.push(JSON.parse(text) as ServerMessage), close: () => undefined });
    const oldInbox: ServerMessage[] = [];
    old.message(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'Régi' }));
    expect(oldInbox[0]).toMatchObject({ t: 'error' });
  });
});

describe('a meccs a szerveren', () => {
  it('ha minden hely elkelt, visszaszámlálás után indul; a betelt játék is látszik a listában', () => {
    const lobby = new Lobby(data);
    const host = new FakeClient(lobby, 'Anna');
    const guest = new FakeClient(lobby, 'Béla');
    const watcher = new FakeClient(lobby, 'Néző');
    lobby.tick(1000);
    host.send({ t: 'create', settings: { ...small, maxPlayers: 2 } });
    guest.send({ t: 'join', room: guest.rooms()[0].id });
    expect(host.last('room')).toMatchObject({ countdown: MATCH.countdown, room: { status: 'starting' } });
    expect(watcher.rooms()[0].status).toBe('starting');
    lobby.tick(1000 + MATCH.countdown * 1000 - 100);
    expect(host.last('start')).toBeUndefined();
    lobby.tick(1000 + MATCH.countdown * 1000 + 10);
    const start = host.last('start')!;
    expect(start.players.map((p) => p.name)).toEqual(['Anna', 'Béla']);
    expect(start.tank).toBe(start.players[0].tank);
    expect(guest.last('start')!.tank).toBe(start.players[1].tank);
    expect(watcher.rooms()[0]).toMatchObject({ status: 'playing', players: ['Anna', 'Béla'] });
  });

  it('a szerver a bemenetek alapján lépteti a tankot, és nyugtázza a feldolgozott bemenetet', () => {
    const lobby = new Lobby(data);
    const host = new FakeClient(lobby, 'Anna');
    lobby.tick(0);
    host.send({ t: 'create', settings: { ...small, maxPlayers: 1, bots: 0 } });
    lobby.tick(MATCH.countdown * 1000 + 1);
    const mine = host.last('start')!.tank;
    let now = MATCH.countdown * 1000 + 1;
    let seq = 0;
    const first = (): Snapshot | undefined => host.inbox.find((m): m is Snapshot => m.t === 'snap');
    for (let i = 0; i < 120; i++) {
      host.send({ t: 'input', s: ++seq, i: packInput({ throttle: 1, turn: 0, aim: null, fire: false }) });
      now += 1000 / 60;
      lobby.tick(now);
    }
    const start = first()!;
    const end = host.last('snap')!;
    expect(end.me?.id).toBe(mine);
    expect(end.v).toBe(mine);
    expect(end.a).toBeGreaterThan(seq - 6);
    expect(end.me!.speed).toBeGreaterThan(5);
    expect(Math.hypot(end.me!.x - start.me!.x, end.me!.y - start.me!.y)).toBeGreaterThan(5);
    // a pillanatképben benne van a saját tank és a közeli tárgyak
    expect(end.T.some((t) => t[0] === mine)).toBe(true);
    expect(end.S).toEqual([[mine, 1, 0, 0]]);
    // 20 pillanatkép másodpercenként
    const snaps = host.inbox.filter((m) => m.t === 'snap').length;
    expect(snaps).toBeGreaterThanOrEqual(38);
    expect(snaps).toBeLessThanOrEqual(42);
  });

  it('ha valaki kilép játék közben, a bent maradó nyer; a befejezett játék eltűnik a listából', () => {
    const lobby = new Lobby(data);
    const host = new FakeClient(lobby, 'Anna');
    const guest = new FakeClient(lobby, 'Béla');
    const watcher = new FakeClient(lobby, 'Néző');
    lobby.tick(0);
    host.send({ t: 'create', settings: { ...small, maxPlayers: 2, bots: 0 } });
    guest.send({ t: 'join', room: guest.rooms()[0].id });
    lobby.tick(MATCH.countdown * 1000 + 1);
    lobby.tick(MATCH.countdown * 1000 + 40);
    expect(lobby.stats.playing).toBe(1);
    host.disconnect();
    lobby.tick(MATCH.countdown * 1000 + 80);
    const over = guest.last('over')!;
    expect(over.standings.map((s) => [s.name, s.place])).toEqual([
      ['Béla', 1],
      ['Anna', 2],
    ]);
    expect(watcher.rooms()).toEqual([]);
    expect(lobby.stats.rooms).toBe(0);
    // a győztes visszakerült a listához: új játékot hozhat létre
    guest.send({ t: 'create', settings: { ...small, maxPlayers: 2 } });
    expect(watcher.rooms()).toHaveLength(1);
  });

  it('nyolc játékos, sok bot: egy szimulációs lépés a pillanatképekkel együtt is gyors', () => {
    const lobby = new Lobby(data);
    const clients = Array.from({ length: 8 }, (_, i) => new FakeClient(lobby, `J${i}`));
    lobby.tick(0);
    clients[0].send({ t: 'create', settings: { area: { minX: 0, minY: 0, maxX: 2000, maxY: 3460 }, bots: 5, pickups: 5, lives: 5, maxPlayers: 8 } });
    const id = clients[1].rooms()[0].id;
    for (const c of clients.slice(1)) c.send({ t: 'join', room: id });
    let now = MATCH.countdown * 1000 + 1;
    lobby.tick(now);
    expect(clients[7].last('start')).toBeDefined();
    const started = performance.now();
    const steps = 600;
    for (let i = 0; i < steps; i++) {
      for (const c of clients) c.send({ t: 'input', s: i + 1, i: packInput({ throttle: 1, turn: i % 120 < 60 ? 0.4 : -0.4, aim: i / 30, fire: true }) });
      now += 1000 / 60;
      lobby.tick(now);
    }
    const ms = (performance.now() - started) / steps;
    const bytes = clients[0].inbox.filter((m) => m.t === 'snap').reduce((sum, m) => sum + encode(m).length, 0);
    console.log(`8 játékos, 100 bot: ${ms.toFixed(2)} ms / lépés, pillanatkép átlag ${(bytes / (steps / 3) / 1024).toFixed(1)} KB (${((bytes / (steps / 60)) / 1024).toFixed(0)} KB/s játékosonként)`);
    expect(ms).toBeLessThan(8);
  }, 60000);
});

describe('regisztráció és belépés', () => {
  // a teszt saját, memóriában élő fióktárat használ
  const setup = (): { gate: Gate; accounts: Accounts } => {
    const accounts = new Accounts(null);
    return { gate: new Gate(new Lobby(data), accounts), accounts };
  };
  const open = (gate: Gate): { inbox: ServerMessage[]; send(m: ClientMessage): void; closed: () => boolean; close(): void } => {
    const inbox: ServerMessage[] = [];
    let closed = false;
    const session = gate.connect({ send: (text) => inbox.push(JSON.parse(text) as ServerMessage), close: () => (closed = true) });
    return { inbox, send: (m) => session.message(JSON.stringify(m)), closed: () => closed, close: () => session.close() };
  };
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));
  const last = <T extends ServerMessage['t']>(inbox: ServerMessage[], type: T): Extract<ServerMessage, { t: T }> | undefined =>
    [...inbox].reverse().find((m): m is Extract<ServerMessage, { t: T }> => m.t === type);

  it('belépés nélkül nem érhető el a szobalista; regisztráció után igen, a fiók nevével', async () => {
    const { gate } = setup();
    const c = open(gate);
    c.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Csaló' });
    c.send({ t: 'create', settings: {} });
    expect(c.inbox).toEqual([]);
    c.send({ t: 'register', v: PROTOCOL_VERSION, name: '  Páncélos   Pista ', password: 'titok123' });
    await settle();
    const auth = last(c.inbox, 'auth')!;
    expect(auth.name).toBe('Páncélos Pista');
    expect(auth.token).toHaveLength(64);
    expect(last(c.inbox, 'welcome')).toBeDefined();
    c.send({ t: 'create', settings: { maxPlayers: 3 } });
    expect(last(c.inbox, 'room')?.room.host).toBe('Páncélos Pista');
  });

  it('a név egyedi (kis- és nagybetűtől függetlenül); a hibás név és a rövid jelszó elutasításra kerül', async () => {
    const { gate, accounts } = setup();
    const a = open(gate);
    a.send({ t: 'register', v: PROTOCOL_VERSION, name: 'Tigris', password: 'jelszo1' });
    await settle();
    const b = open(gate);
    b.send({ t: 'register', v: PROTOCOL_VERSION, name: 'TIGRIS', password: 'masik-jelszo' });
    await settle();
    expect(last(b.inbox, 'authError')?.message).toContain('foglalt');
    for (const [name, password] of [['ab', 'jelszo1'], ['<script>', 'jelszo1'], ['Rendes név', '123']]) {
      b.send({ t: 'register', v: PROTOCOL_VERSION, name, password });
      await settle();
    }
    expect(b.inbox.filter((m) => m.t === 'authError')).toHaveLength(4);
    expect(accounts.count).toBe(1);
  });

  it('belépés jelszóval és megőrzött kulccsal; hibás jelszóval nem; kijelentkezés után a kulcs érvénytelen', async () => {
    const { gate } = setup();
    const first = open(gate);
    first.send({ t: 'register', v: PROTOCOL_VERSION, name: 'Leopárd', password: 'helyes-jelszo' });
    await settle();
    first.close();

    const wrong = open(gate);
    wrong.send({ t: 'login', v: PROTOCOL_VERSION, name: 'Leopárd', password: 'rossz-jelszo' });
    await settle();
    expect(last(wrong.inbox, 'authError')?.message).toBe('Hibás név vagy jelszó.');
    wrong.send({ t: 'login', v: PROTOCOL_VERSION, name: 'Nincs Ilyen', password: 'rossz-jelszo' });
    await settle();
    expect(wrong.inbox.filter((m) => m.t === 'authError')).toHaveLength(2);

    const ok = open(gate);
    ok.send({ t: 'login', v: PROTOCOL_VERSION, name: 'leopárd', password: 'helyes-jelszo' });
    await settle();
    const token = last(ok.inbox, 'auth')!.token;
    expect(last(ok.inbox, 'auth')!.name).toBe('Leopárd');
    ok.close();

    const back = open(gate);
    back.send({ t: 'resume', v: PROTOCOL_VERSION, token });
    expect(last(back.inbox, 'auth')?.name).toBe('Leopárd');
    back.send({ t: 'logout' });
    expect(back.closed()).toBe(true);
    const stale = open(gate);
    stale.send({ t: 'resume', v: PROTOCOL_VERSION, token });
    expect(last(stale.inbox, 'authError')?.message).toContain('lejárt');
  });

  it('ha ugyanazzal a fiókkal máshonnan is belépnek, a régi kapcsolat megszakad', async () => {
    const { gate } = setup();
    const one = open(gate);
    one.send({ t: 'register', v: PROTOCOL_VERSION, name: 'Párduc', password: 'jelszo-123' });
    await settle();
    const two = open(gate);
    two.send({ t: 'login', v: PROTOCOL_VERSION, name: 'Párduc', password: 'jelszo-123' });
    await settle();
    expect(one.closed()).toBe(true);
    expect(last(one.inbox, 'authError')?.message).toContain('máshol');
    expect(last(two.inbox, 'auth')?.name).toBe('Párduc');
  });

  it('a fiókok fájlban megmaradnak, és a jelszó nem olvasható ki belőle', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tank-accounts-'));
    const file = path.join(dir, 'sub', 'accounts.json');
    try {
      const one = new Accounts(file);
      const made = await one.register('Jaguár', 'nagyon-titkos');
      expect(made.ok).toBe(true);
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('Jaguár');
      expect(text).not.toContain('nagyon-titkos');
      if (made.ok) expect(text).not.toContain(made.token);
      // újraindítás után a fiók és a belépve maradás is megvan
      const two = new Accounts(file);
      expect(two.count).toBe(1);
      expect((await two.login('Jaguár', 'nagyon-titkos')).ok).toBe(true);
      if (made.ok) expect(two.resume(made.token)).toMatchObject({ ok: true, name: 'Jaguár' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
