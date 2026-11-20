// A szerver magja hálózat nélkül: szobalista, váró, indulás, pillanatképek, a meccs vége.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../server/accounts';
import { Gate } from '../server/gate';
import { LIMITS, Lobby } from '../server/lobby';
import type { MapData } from '../src/game/maps/types';
import { CHAT, cleanChat, encode, messageReader, packInput, PROTOCOL_VERSION, VOICE, type ClientMessage, type FullSnapshot, type RoomInfo, type ServerMessage } from '../src/game/net/protocol';
import { MATCH } from '../src/game/sim/match';

const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;

class FakeClient {
  readonly inbox: ServerMessage[] = [];
  closed = false;
  private readonly session: { message(text: string): void; close(): void };

  /** a pillanatképek összefésülve, teljes állapotként (a szerver csak a változást küldi) */
  readonly snaps: FullSnapshot[] = [];
  /** a pillanatképek tényleges mérete a hálózaton (karakter) */
  snapBytes = 0;

  constructor(lobby: Lobby, name: string) {
    const read = messageReader();
    this.session = lobby.connect({
      send: (text) => {
        const message = read(text);
        if (message.t === 'snap') {
          this.snaps.push(message as FullSnapshot);
          this.snapBytes += text.length;
        }
        this.inbox.push(message as ServerMessage);
      },
      close: () => (this.closed = true),
    });
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name });
  }

  /** a legutóbbi teljes állapot */
  snap(): FullSnapshot {
    return this.snaps[this.snaps.length - 1];
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

const small = { area: { minX: 500, minY: 500, maxX: 1000, maxY: 1000 }, bots: 1, pickups: 2, traffic: 0, minutes: 5 };

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
    expect(room.settings).toMatchObject({ name: 'Esti csata', maxPlayers: 3, weather: 'night', minutes: 5, mode: 'deathmatch' });
    expect(room.plan.bots).toBeGreaterThanOrEqual(1);
    expect(host.last('room')?.room.players).toEqual(['Anna']);

    guest.send({ t: 'join', room: room.id });
    expect(host.last('room')?.room.players).toEqual(['Anna', 'Béla']);
    expect(host.last('room')?.room.status).toBe('waiting');
    // a harmadik játékos a listában azt látja, hogy ketten várnak
    const third = new FakeClient(lobby, 'Cili');
    expect(third.rooms()[0].players).toHaveLength(2);
  });

  it('privát játék: csak a helyes belépőkóddal lehet belépni, a kód a listában nem látszik', () => {
    const lobby = new Lobby(data);
    lobby.tick(1000);
    const host = new FakeClient(lobby, 'Anna');
    const friend = new FakeClient(lobby, 'Béla');
    const stranger = new FakeClient(lobby, 'Idegen');
    host.send({ t: 'create', settings: { ...small, name: 'Baráti meccs', maxPlayers: 3 }, code: ' Misleny 42 ' });
    const room = stranger.rooms()[0];
    expect(room.locked).toBe(true);
    // a szobalistából a kód semmilyen formában nem derül ki
    expect(JSON.stringify(stranger.inbox).toLowerCase()).not.toContain('misleny42');
    // a létrehozó a váróban látja, hogy tovább tudja adni
    expect(host.last('room')?.code).toBe('misleny42');

    stranger.send({ t: 'join', room: room.id });
    expect(stranger.last('error')?.message).toBe('Hibás belépőkód.');
    stranger.send({ t: 'join', room: room.id, code: 'tipp' });
    expect(stranger.last('room')).toBeUndefined();
    expect(host.last('room')?.room.players).toEqual(['Anna']);

    // a kis- és nagybetű, a szóközök nem számítanak
    friend.send({ t: 'join', room: room.id, code: 'MISLENY42' });
    expect(friend.last('room')?.room.players).toEqual(['Anna', 'Béla']);
    expect(friend.last('room')?.code).toBe('misleny42');
    expect(JSON.stringify(stranger.inbox).toLowerCase()).not.toContain('misleny42');
  });

  it('privát játék: a sorozatos találgatást várakozás lassítja', () => {
    const lobby = new Lobby(data);
    lobby.tick(1000);
    const host = new FakeClient(lobby, 'Anna');
    const stranger = new FakeClient(lobby, 'Idegen');
    host.send({ t: 'create', settings: { ...small, maxPlayers: 2 }, code: 'titok' });
    const id = stranger.rooms()[0].id;
    for (let i = 0; i < LIMITS.codeTries; i++) stranger.send({ t: 'join', room: id, code: `rossz${i}` });
    expect(stranger.last('error')?.message).toBe('Hibás belépőkód.');
    // ennyi hiba után a helyes kód sem megy át, amíg a várakozás le nem telik
    stranger.send({ t: 'join', room: id, code: 'titok' });
    expect(stranger.last('error')?.message).toContain('Túl sok hibás kód');
    expect(stranger.last('room')).toBeUndefined();
    lobby.tick(1000 + LIMITS.codeWait + 1);
    stranger.send({ t: 'join', room: id, code: 'titok' });
    expect(stranger.last('room')?.room.players).toEqual(['Anna', 'Idegen']);
  });

  it('kód nélkül a játék nyilvános; a túl rövid kódot a szerver visszautasítja', () => {
    const lobby = new Lobby(data);
    const host = new FakeClient(lobby, 'Anna');
    const guest = new FakeClient(lobby, 'Béla');
    host.send({ t: 'create', settings: { ...small, maxPlayers: 2 }, code: 'ab' });
    expect(host.last('error')?.message).toContain('belépőkód');
    expect(guest.rooms()).toEqual([]);
    host.send({ t: 'create', settings: { ...small, maxPlayers: 2 }, code: '   ' });
    expect(guest.rooms()[0].locked).toBe(false);
    expect(host.last('room')?.code).toBeUndefined();
    guest.send({ t: 'join', room: guest.rooms()[0].id });
    expect(guest.last('room')?.room.players).toEqual(['Anna', 'Béla']);
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
    const first = (): FullSnapshot | undefined => host.snaps[0];
    for (let i = 0; i < 120; i++) {
      host.send({ t: 'input', s: ++seq, i: packInput({ throttle: 1, turn: 0, aim: null, fire: false }) });
      now += 1000 / 60;
      lobby.tick(now);
    }
    const start = first()!;
    const end = host.snap();
    expect(end.me?.id).toBe(mine);
    expect(end.v).toBe(mine);
    expect(end.a).toBeGreaterThan(seq - 6);
    // a tank elindult (a véletlen kezdőhelytől függ, hogy két másodperc múlva nem állítja-e meg épp egy fal)
    const fastest = Math.max(...host.snaps.map((m) => m.me?.speed ?? 0));
    expect(fastest).toBeGreaterThan(5);
    expect(Math.hypot(end.me!.x - start.me!.x, end.me!.y - start.me!.y)).toBeGreaterThan(3);
    // a saját tank állapota külön megy, a tankok listájában nem ismétlődik
    expect(end.T.some((t) => t[0] === mine)).toBe(false);
    expect(end.me?.id).toBe(mine);
    // az állás: [tank, kilövések, halálok, kilépett-e]; a hátralévő idő másodpercben
    expect(end.S).toEqual([[mine, 0, 0, 0]]);
    expect(end.r).toBeGreaterThanOrEqual(5 * 60 - 2);
    expect(end.r).toBeLessThan(5 * 60);
    // 20 pillanatkép másodpercenként
    const snaps = host.snaps.length;
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
    clients[0].send({ t: 'create', settings: { area: { minX: 0, minY: 0, maxX: 2000, maxY: 3460 }, bots: 5, pickups: 5, traffic: 5, minutes: 30, maxPlayers: 8 } });
    const id = clients[1].rooms()[0].id;
    for (const c of clients.slice(1)) c.send({ t: 'join', room: id });
    let now = MATCH.countdown * 1000 + 1;
    lobby.tick(now);
    expect(clients[7].last('start')).toBeDefined();
    const started = performance.now();
    const steps = 600;
    let batchStart = started;
    let best = Infinity;
    for (let i = 0; i < steps; i++) {
      for (const c of clients) c.send({ t: 'input', s: i + 1, i: packInput({ throttle: 1, turn: i % 120 < 60 ? 0.4 : -0.4, aim: i / 30, fire: true }) });
      now += 1000 / 60;
      lobby.tick(now);
      if (i % 100 === 99) {
        const t = performance.now();
        best = Math.min(best, (t - batchStart) / 100);
        batchStart = t;
      }
    }
    const ms = (performance.now() - started) / steps;
    const bytes = clients[0].snapBytes;
    console.log(`8 játékos, 100 bot, 60 jármű: átlag ${ms.toFixed(2)}, a legjobb 100 lépés ${best.toFixed(2)} ms / lépés, pillanatkép átlag ${(bytes / (steps / 3) / 1024).toFixed(1)} KB (${((bytes / (steps / 60)) / 1024).toFixed(0)} KB/s játékosonként)`);
    // egy lépésre 16,7 ms jut; a legjobb szakasz a gép tényleges sebességét mutatja (a tesztek párhuzamosan futnak)
    expect(best).toBeLessThan(6);
    expect(ms).toBeLessThan(14);
  }, 60000);

  it('az idő lejártakor a meccs véget ér: mindenki megkapja az eredményt, és a szoba eltűnik', () => {
    const lobby = new Lobby(data, 0);
    const host = new FakeClient(lobby, 'Anna');
    const guest = new FakeClient(lobby, 'Béla');
    host.send({ t: 'create', settings: { ...small, maxPlayers: 2, bots: 0, pickups: 0, minutes: 5 } });
    guest.send({ t: 'join', room: guest.rooms()[0].id });
    let now = 10;
    lobby.tick(now);
    expect(host.last('start')?.room.settings.minutes).toBe(5);
    // öt perc játékidő (a szerver egy hívásban legfeljebb hat lépést pótol be)
    const steps = 5 * 60 * 60 + 10;
    for (let i = 0; i < steps && !host.last('over'); i++) {
      now += 1000 / 60;
      lobby.tick(now);
    }
    const clock = host.snaps.map((m) => m.r);
    expect(clock[0]).toBe(300);
    expect(clock[clock.length - 1]).toBeLessThanOrEqual(1);
    for (const client of [host, guest]) {
      const over = client.last('over')!;
      // senki nem lőtt ki senkit: döntetlen
      expect(over.winner).toBeNull();
      expect(over.standings.map((s) => s.place)).toEqual([1, 1]);
    }
    expect(lobby.stats.rooms).toBe(0);
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

describe('egyjátékos mód: ugyanaz a szobakezelő, visszaszámlálás nélkül', () => {
  it('az egyfős játék azonnal indul, a botok beállításai eljutnak a meccsig', () => {
    const lobby = new Lobby(data, 0);
    const solo = new FakeClient(lobby, 'Gyakorló');
    solo.send({ t: 'create', settings: { ...small, maxPlayers: 1, bots: 4, botSkill: 5, botAggression: 1 } });
    lobby.tick(10);
    const start = solo.last('start')!;
    expect(start.players).toHaveLength(1);
    expect(start.room.settings).toMatchObject({ maxPlayers: 1, botSkill: 5, botAggression: 1 });
    expect(start.room.plan.bots).toBeGreaterThan(0);
    lobby.tick(210);
    expect(solo.snap()?.me?.id).toBe(start.tank);
  });

  it('a hiányzó vagy hibás botbeállítás a közepes szintre kerül', () => {
    const lobby = new Lobby(data, 0);
    const solo = new FakeClient(lobby, 'Gyakorló');
    solo.send({ t: 'create', settings: { ...small, maxPlayers: 1, botSkill: 42, botAggression: Number.NaN } });
    lobby.tick(10);
    expect(solo.last('start')!.room.settings).toMatchObject({ botSkill: 5, botAggression: 3 });
  });
});

describe('ki van bejelentkezve', () => {
  it('a menükben lévők látják, kik vannak még bent, és ki hol van: előszobában, váróban vagy meccsen', () => {
    const lobby = new Lobby(data, 0);
    lobby.tick(1000);
    const anna = new FakeClient(lobby, 'Anna');
    expect(anna.last('online')?.players).toEqual([{ name: 'Anna', where: 'lobby' }]);
    const bela = new FakeClient(lobby, 'Béla');
    // a korábban belépett is megtudja, hogy új játékos jött
    expect(anna.last('online')?.players).toEqual([{ name: 'Anna', where: 'lobby' }, { name: 'Béla', where: 'lobby' }]);
    expect(bela.last('online')?.players).toHaveLength(2);
    // Béla szobát nyit: a váróban van
    bela.send({ t: 'create', settings: { ...small, maxPlayers: 2 } });
    expect(anna.last('online')?.players).toContainEqual({ name: 'Béla', where: 'room' });
    expect(bela.last('online')?.players).toContainEqual({ name: 'Béla', where: 'room' });
    // Cili belép hozzá: indul a meccs, mindketten meccsen vannak
    const cili = new FakeClient(lobby, 'Cili');
    cili.send({ t: 'join', room: cili.rooms()[0].id });
    lobby.tick(1100);
    expect(bela.last('start')).toBeDefined();
    expect(anna.last('online')?.players).toEqual([{ name: 'Anna', where: 'lobby' }, { name: 'Béla', where: 'game' }, { name: 'Cili', where: 'game' }]);
    // aki kilép az oldalról, eltűnik a listából
    cili.disconnect();
    expect(anna.last('online')?.players.map((p) => p.name)).toEqual(['Anna', 'Béla']);
    const before = bela.inbox.filter((m) => m.t === 'online').length;
    const dani = new FakeClient(lobby, 'Dani');
    expect(dani.last('online')?.players.map((p) => p.name)).toEqual(['Anna', 'Béla', 'Dani']);
    // a meccsen lévő nem kapja a listát (ott nem látszik): nem terheli a hálózatát
    expect(bela.inbox.filter((m) => m.t === 'online').length).toBe(before);
  });
});

describe('üzenetek és hang', () => {
  const chats = (c: FakeClient): Extract<ServerMessage, { t: 'chat' }>[] => c.inbox.filter((m): m is Extract<ServerMessage, { t: 'chat' }> => m.t === 'chat');
  const voices = (c: FakeClient): Extract<ServerMessage, { t: 'voice' }>[] => c.inbox.filter((m): m is Extract<ServerMessage, { t: 'voice' }> => m.t === 'voice');
  const frame = 'A'.repeat(800);

  it('az előszobában mindenki megkapja az üzenetet, aki nincs szobában; a később belépő az utolsókat is', () => {
    const lobby = new Lobby(data);
    lobby.tick(1000);
    const anna = new FakeClient(lobby, 'Anna');
    const bela = new FakeClient(lobby, 'Béla');
    const cili = new FakeClient(lobby, 'Cili');
    // Cili szobát nyit: ő már nem az előszobában van
    cili.send({ t: 'create', settings: { ...small, maxPlayers: 3 } });
    anna.send({ t: 'chat', text: '  Sziasztok,   ki jön <b>játszani</b>?\n ' });
    expect(chats(bela)).toEqual([{ t: 'chat', from: 'Anna', text: 'Sziasztok, ki jön b játszani /b ?', scope: 'lobby' }]);
    // a küldő is megkapja, megjelölve, hogy az övé
    expect(chats(anna)).toEqual([{ t: 'chat', from: 'Anna', text: 'Sziasztok, ki jön b játszani /b ?', scope: 'lobby', me: true }]);
    expect(chats(cili)).toHaveLength(0);
    // üres vagy hibás üzenet nem megy át
    anna.send({ t: 'chat', text: '   ' });
    anna.send({ t: 'chat', text: 42 as never });
    expect(chats(bela)).toHaveLength(1);
    expect(cleanChat('x'.repeat(500))).toHaveLength(CHAT.maxLength);
    // aki később lép be, megkapja az előszoba utolsó üzeneteit
    const dani = new FakeClient(lobby, 'Dani');
    expect(dani.last('chatHistory')?.lines).toEqual([{ from: 'Anna', text: 'Sziasztok, ki jön b játszani /b ?' }]);
  });

  it('szobában és meccsen az üzenet csak a szobatársaknak megy', () => {
    const lobby = new Lobby(data, 0);
    lobby.tick(1000);
    const anna = new FakeClient(lobby, 'Anna');
    const bela = new FakeClient(lobby, 'Béla');
    const kint = new FakeClient(lobby, 'Kint');
    anna.send({ t: 'create', settings: { ...small, maxPlayers: 3 } });
    bela.send({ t: 'join', room: bela.rooms()[0].id });
    // a váróban
    anna.send({ t: 'chat', text: 'Várjuk a harmadikat' });
    expect(chats(bela)).toEqual([{ t: 'chat', from: 'Anna', text: 'Várjuk a harmadikat', scope: 'room' }]);
    expect(chats(kint)).toHaveLength(0);
    // a szobán belüli beszélgetés nem kerül az előszoba előzményei közé
    expect(new FakeClient(lobby, 'Új').last('chatHistory')).toBeUndefined();
    // a meccs alatt is
    const cili = new FakeClient(lobby, 'Cili');
    cili.send({ t: 'join', room: cili.rooms()[0].id });
    lobby.tick(1100);
    expect(anna.last('start')).toBeDefined();
    bela.send({ t: 'chat', text: 'Hol vagytok?' });
    expect(chats(anna).pop()).toMatchObject({ from: 'Béla', text: 'Hol vagytok?', scope: 'room' });
    expect(chats(cili).pop()).toMatchObject({ from: 'Béla', text: 'Hol vagytok?' });
    expect(chats(kint)).toHaveLength(0);
  });

  it('aki elárasztja a csevegést, annak az üzenetei egy időre nem mennek át', () => {
    const lobby = new Lobby(data);
    lobby.tick(1000);
    const anna = new FakeClient(lobby, 'Anna');
    const bela = new FakeClient(lobby, 'Béla');
    for (let i = 0; i < CHAT.burst + 3; i++) anna.send({ t: 'chat', text: `üzenet ${i}` });
    expect(chats(bela)).toHaveLength(CHAT.burst);
    expect(anna.last('error')?.message).toContain('Túl gyorsan');
    lobby.tick(1000 + CHAT.window + 1);
    anna.send({ t: 'chat', text: 'újra' });
    expect(chats(bela).pop()?.text).toBe('újra');
  });

  it('a hang a szobatársaknak megy tovább, a beszélőnek nem; az előszobából és a hibás darab nem megy át', () => {
    const lobby = new Lobby(data, 0);
    lobby.tick(1000);
    const anna = new FakeClient(lobby, 'Anna');
    const bela = new FakeClient(lobby, 'Béla');
    const kint = new FakeClient(lobby, 'Kint');
    // szobán kívül nincs kinek beszélni
    anna.send({ t: 'voice', d: frame });
    expect(voices(bela)).toHaveLength(0);
    anna.send({ t: 'create', settings: { ...small, maxPlayers: 2 } });
    bela.send({ t: 'join', room: bela.rooms()[0].id });
    lobby.tick(1100);
    expect(anna.last('start')).toBeDefined();
    anna.send({ t: 'voice', d: frame });
    expect(voices(bela)).toEqual([{ t: 'voice', from: 'Anna', d: frame }]);
    expect(voices(anna)).toHaveLength(0);
    expect(voices(kint)).toHaveLength(0);
    // túl nagy, üres vagy nem base64 darab
    anna.send({ t: 'voice', d: 'A'.repeat(VOICE.maxChars + 1) });
    anna.send({ t: 'voice', d: '' });
    anna.send({ t: 'voice', d: '<script>' });
    anna.send({ t: 'voice', d: 5 as never });
    expect(voices(bela)).toHaveLength(1);
    // másodpercenként csak korlátozott számú darab megy át
    lobby.tick(3000);
    for (let i = 0; i < VOICE.maxPerSecond + 20; i++) anna.send({ t: 'voice', d: frame });
    expect(voices(bela)).toHaveLength(1 + VOICE.maxPerSecond);
  });

  it('egy szobában egyszerre legfeljebb hárman beszélhetnek; aki elhallgat, helyet ad', () => {
    const lobby = new Lobby(data, 0);
    lobby.tick(1000);
    const names = ['Anna', 'Béla', 'Cili', 'Dani', 'Emma'];
    const players = names.map((name) => new FakeClient(lobby, name));
    players[0].send({ t: 'create', settings: { ...small, maxPlayers: names.length } });
    for (const p of players.slice(1)) p.send({ t: 'join', room: p.rooms()[0].id });
    lobby.tick(1100);
    expect(players[0].last('start')).toBeDefined();
    const listener = players[4];
    for (const p of players.slice(0, 4)) p.send({ t: 'voice', d: frame });
    // az első három hangja megy át, a negyediké nem
    expect(voices(listener).map((v) => v.from)).toEqual(names.slice(0, VOICE.speakers));
    // szünet után a negyedik is szóhoz jut
    lobby.tick(1100 + VOICE.quiet + 50);
    players[3].send({ t: 'voice', d: frame });
    expect(voices(listener).pop()?.from).toBe('Dani');
  });
});
