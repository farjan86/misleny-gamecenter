// A menük: főképernyő (belépés / regisztráció), beállítások (billentyűk), a
// játékok listája, új játék létrehozása, a váró és az eredménytábla. Sima DOM,
// a játékvászon fölött; a szerverrel a NetClient-en keresztül beszél.

import type { GameMap } from '../maps/GameMap';
import { renderMap } from '../maps/raster';
import type { NetClient, NetStatus } from '../net/NetClient';
import { CHAT, cleanCode, ROOM_CODE, type OnlinePlayer, type RoomInfo, type ServerMessage, type Standing } from '../net/protocol';
import { ACTION_LABEL, ACTIONS, DEFAULT_VOLUME, defaultKeys, FIXED_KEYS, keyName, saveSettings, type Settings } from '../settings';
import { Sfx } from '../systems/audio';
import { areaOfCells, GAME_MODE_HINT, GAME_MODE_NAME, GAME_MODES, gridSize, MATCH, matchPlan, sanitizeSettings, SCORE, WEATHERS, type GameMode, type MatchSettings, DEMO, demoPlayers, applyTempo, TEMPO, TEMPO_HINTS, TEMPO_NAMES, tempoKm2 } from '../sim/match';
import { BOSS } from '../sim/bossRules';
import { pickArea } from './areaPick';
import { HULL_SIZE, LOOK_TIER_NAMES, TANK_LOOK_HINT, TANK_LOOK_NAMES, tankSprites, TURRET_PIVOT } from '../entities/tankTextures';
import { LEVEL, BOT_TOUGHNESS, BOT_TOUGHNESS_LEVELS, DAMAGE, TANK } from '../sim/world';
import { buildGuide, buildHowTo } from './Guide';
import { guardLeave } from './leaveGuard';
import { MenuArt } from './MenuArt';

type Screen = 'main' | 'settings' | 'guide' | 'garage' | 'lobby' | 'create' | 'room' | 'results';
const SCREENS: Screen[] = ['main', 'settings', 'guide', 'garage', 'lobby', 'create', 'room', 'results'];

const LEVEL_NAME = ['nincs', 'nagyon kevés', 'kevés', 'közepes', 'sok', 'nagyon sok'];
const SKILL_NAME = ['', 'kezdő', 'gyenge', 'közepes', 'ügyes', 'nagyon ügyes – tárgyat vesz fel, fejlődik', 'ultra ügyes – tárgyat vesz fel, fejlődik'];
const TOUGHNESS_NAME = ['', 'törékeny', 'gyenge', 'közepes', 'szívós', 'páncélos'];
const AGGRESSION_NAME = ['', 'békés', 'óvatos', 'közepes', 'harcias', 'vadászik rád'];
const WEATHER_NAME = { day: 'Nappal', rain: 'Eső', night: 'Este' } as const;
const STATUS_NAME = { waiting: 'Játékra vár', starting: 'Betelt – indul', playing: 'Betelt – játékban' } as const;
/** az oldal újratöltése után egyből ide térjen vissza a menü */
const RETURN_KEY = 'tank-misleny.return';
/** újratöltés után ebbe a (nyitott) játékba lép vissza */
const REJOIN_KEY = 'tank-misleny.rejoin';
/** nyitva van-e a főképernyőn a játékmenet leírása */
const HOWTO_KEY = 'tank-misleny.howto';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Hiányzó menüelem: #${id}`);
  return node as T;
}

const esc = (text: string): string => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
/** A játéktér területe: a nagyon kicsi hektárban, a többi km²-ben. */
const km2 = (value: number): string => (value < 0.1 ? `${(value * 100).toFixed(1).replace('.', ',')} hektár` : `${value.toFixed(2).replace('.', ',')} km²`);

function roomDetails(room: RoomInfo): string {
  const s = room.settings;
  const bots = room.plan.bots ? `kb. ${room.plan.bots} bot` : 'bot nélkül';
  // a területet a határokból számoljuk (a hálózaton átjövő érték két tizedesre kerekített)
  const size = ((s.area.maxX - s.area.minX) * (s.area.maxY - s.area.minY)) / 1e6;
  return `${GAME_MODE_NAME[s.mode] ?? s.mode}${s.tempo > 0 ? ` · ${TEMPO_NAMES[s.tempo]}` : ''} · ${km2(size)} · ${WEATHER_NAME[s.weather].toLowerCase()} · ${room.demo ? 'korlátlan ideig' : `${s.minutes} perc`} · ${bots}`;
}

export class Menu {
  private readonly root = el<HTMLDivElement>('menu');
  private readonly errorBox = el<HTMLDivElement>('menu-error');
  private screen: Screen = 'main';
  private errorTimer = 0;
  private retryTimer = 0;
  /** a billentyűre váró mező (művelet és hely), ha éppen átállítás folyik */
  private listening: { action: (typeof ACTIONS)[number]; slot: number } | null = null;
  // az új játék kijelölt cellái
  private readonly grid: { cols: number; rows: number };
  private sel = { c0: 0, r0: 0, c1: 1, r1: 1 };
  private dragging = false;
  private areaBase: HTMLCanvasElement | null = null;
  private currentRoom: RoomInfo | null = null;
  /** a háttér és a főképernyő animált fejléce */
  private readonly art: MenuArt;
  private readonly chatBox = el<HTMLDivElement>('chat');
  private readonly chatLog = el<HTMLDivElement>('chat-log');
  /** az a privát szoba, amelyhez éppen a belépőkódot kérjük */
  private codeRoom: string | null = null;
  /** az „Új játék” képernyő egyjátékos módban van-e (szerver nélkül indul) */
  private single = false;
  /** a szerver gazdája (nyitott játékot nyithat, módosíthat és állíthat le) */
  private admin = false;
  /** a módosítás alatt álló nyitott játék (null: új játék létrehozása) */
  private editing: RoomInfo | null = null;
  /** újratöltés után ebbe a játékba lép vissza, amint megjön a játékok listája */
  private rejoin: string | null = null;
  /** az egyjátékos játék indítását kérő visszahívás */
  onSingle: (settings: MatchSettings, name: string) => void = () => undefined;
  /** hová térjen vissza a menü a meccs után */
  afterMatch: 'lobby' | 'main' = 'lobby';

  constructor(
    private readonly map: GameMap,
    private readonly net: NetClient,
    private settings: Settings,
  ) {
    this.grid = gridSize(map.width, map.height);
    if (map.data.meta.extraAttribution) el<HTMLSpanElement>('extra-attribution').textContent = ` · ${map.data.meta.extraAttribution}`;
    this.art = new MenuArt(map);
    this.art.setActive(true);
    this.bindMain();
    this.bindChat();
    this.bindSettings();
    this.bindLobby();
    this.bindCreate();
    el('room-leave').onclick = () => this.net.send({ t: 'leave' });
    el('results-back').onclick = () => Menu.reloadTo(this.afterMatch);

    net.on((message) => this.onMessage(message));
    net.onStatus((status) => this.onStatus(status));
    this.onStatus(net.status);
    // belépés a megőrzött kulccsal, különben csak csatlakozás (hogy lássuk, él-e a szerver)
    if (this.settings.token) net.resume(this.settings.token);
    else net.connect();
  }

  /** Az oldal újratöltése úgy, hogy utána a megadott menü nyíljon meg (a játék így tisztán indul újra). */
  /** Újratöltés, utána automatikus visszalépés a megadott (nyitott) játékba. */
  static reloadToRoom(room: string): void {
    try {
      window.sessionStorage.setItem(REJOIN_KEY, room);
    } catch {
      /* ha nem megy, a játékok listája nyílik meg */
    }
    Menu.reloadTo('lobby');
  }

  static reloadTo(screen: 'lobby' | 'main'): void {
    try {
      window.sessionStorage.setItem(RETURN_KEY, screen);
    } catch {
      /* nem baj, ha nem megy: a főképernyő nyílik meg */
    }
    // ez a játék saját újratöltése: ne kérdezzen rá a böngésző
    guardLeave(false);
    window.location.reload();
  }

  get inRoom(): boolean {
    return this.currentRoom !== null;
  }

  show(screen: Screen): void {
    this.screen = screen;
    this.root.classList.remove('hidden');
    this.root.classList.toggle('overlay', screen === 'results');
    for (const name of SCREENS) el(`screen-${name}`).classList.toggle('hidden', name !== screen);
    if (screen === 'create') this.openCreate();
    if (screen === 'settings') this.renderKeys();
    this.art.setActive(screen === 'main');
    this.placeChat();
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.art.setActive(false);
  }

  // --- csevegő ---------------------------------------------------------------------

  private bindChat(): void {
    const input = el<HTMLInputElement>('chat-input');
    input.maxLength = CHAT.maxLength;
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const text = input.value.trim();
      if (text) this.net.send({ t: 'chat', text });
      input.value = '';
    });
  }

  /**
   * A csevegő mindig az éppen látható képernyőre kerül (főképernyő, játékok
   * listája, váró), ha a játékos be van lépve. A váróban a szobatársakkal,
   * máshol az előszobában lévőkkel lehet beszélni.
   */
  private placeChat(): void {
    const slot = el(`screen-${this.screen}`).querySelector('.chat-slot');
    const visible = this.net.authed && slot !== null;
    this.chatBox.classList.toggle('hidden', !visible);
    el('main-features').classList.toggle('hidden', this.net.authed);
    if (!visible || !slot) return;
    if (this.chatBox.parentElement !== slot) {
      slot.appendChild(this.chatBox);
      this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }
    const inRoom = this.screen === 'room';
    el('chat-title').textContent = inRoom ? 'A szoba csevegője' : 'Előszoba';
    el('chat-hint').textContent = inRoom ? 'csak a szobatársak látják' : 'mindenki látja, aki nincs meccsben';
  }

  /** A bejelentkezett játékosok névcímkéi a csevegő tetején: zöld az előszobában, kék a váróban, narancs a meccsen lévő. */
  private renderOnline(players: readonly OnlinePlayer[]): void {
    const box = el('chat-online');
    const where = { lobby: 'az előszobában', room: 'egy váróban', game: 'meccsen' } as const;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `Bejelentkezve (${players.length}):`;
    // a saját név elöl, utána a többiek névsorban
    const sorted = [...players].sort((a, b) => Number(b.name === this.net.name) - Number(a.name === this.net.name) || a.name.localeCompare(b.name, 'hu'));
    box.replaceChildren(
      count,
      ...sorted.map((p) => {
        const tag = document.createElement('span');
        const me = p.name === this.net.name;
        tag.className = `online ${p.where}${me ? ' me' : ''}`;
        tag.textContent = p.where === 'game' ? `${p.name} · meccsen` : p.where === 'room' ? `${p.name} · váróban` : p.name;
        tag.title = me ? 'Ez te vagy' : `${p.name} ${where[p.where]} van`;
        return tag;
      }),
    );
  }

  private chatLine(from: string, text: string, cls: string): void {
    const stick = this.chatLog.scrollTop + this.chatLog.clientHeight >= this.chatLog.scrollHeight - 30;
    const line = document.createElement('div');
    line.className = `chat-msg ${cls}`.trim();
    const name = document.createElement('b');
    name.textContent = `${from}: `;
    line.append(name, text);
    this.chatLog.appendChild(line);
    while (this.chatLog.children.length > 120) this.chatLog.firstElementChild?.remove();
    // ha a végén állt a lista, az új üzenettel együtt görög tovább
    if (stick) this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  error(text: string): void {
    this.errorBox.textContent = text;
    this.errorBox.classList.remove('hidden');
    window.clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => this.errorBox.classList.add('hidden'), 4500);
  }

  private save(): void {
    this.settings = saveSettings(this.settings);
  }

  // --- kapcsolat és belépés ------------------------------------------------------

  private onStatus(status: NetStatus): void {
    const text = status === 'connecting' ? 'Kapcsolódás a szerverhez…' : status === 'offline' ? 'A szerver most nem elérhető – újrapróbálkozás…' : '';
    el('server-status').textContent = text;
    el('lobby-status').textContent = text || 'Válassz egy játékra váró szobát, vagy hozz létre újat.';
    window.clearTimeout(this.retryTimer);
    if (status !== 'offline') return;
    this.showAuth(false);
    // az egyjátékos beállítóképernyőhöz nem kell szerver
    if (this.screen === 'lobby' || (this.screen === 'create' && !this.single) || this.screen === 'room') this.show('main');
    this.currentRoom = null;
    this.retryTimer = window.setTimeout(() => {
      if (this.settings.token) this.net.resume(this.settings.token);
      else this.net.connect();
    }, 3000);
  }

  private showAuth(loggedIn: boolean): void {
    el('auth-box').classList.toggle('hidden', loggedIn);
    el('user-box').classList.toggle('hidden', !loggedIn);
    if (loggedIn) el('user-greeting').textContent = `Szia, ${this.net.name}!`;
    else this.chatLog.replaceChildren();
    this.placeChat();
  }

  private bindMain(): void {
    const name = el<HTMLInputElement>('auth-name');
    const password = el<HTMLInputElement>('auth-password');
    name.value = this.settings.name;
    const submit = (mode: 'login' | 'register'): void => {
      const n = name.value.trim();
      if (n.length < 3) return this.error('Add meg a játékosnevedet (legalább 3 karakter).');
      if (password.value.length < 6) return this.error('A jelszó legalább 6 karakter legyen.');
      this.settings.name = n;
      this.save();
      if (mode === 'login') this.net.login(n, password.value);
      else this.net.register(n, password.value);
    };
    el('auth-login').onclick = () => submit('login');
    el('auth-register').onclick = () => submit('register');
    password.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit('login');
    });
    el('main-settings').onclick = () => this.show('settings');
    // a játékmenet leírása a főképernyőn; hogy nyitva van-e, azt a böngésző megjegyzi
    buildHowTo(el('howto-body'));
    const howto = el<HTMLDetailsElement>('howto');
    try {
      if (window.localStorage.getItem(HOWTO_KEY) === '0') howto.open = false;
    } catch {
      /* letiltott tárhely: nyitva marad */
    }
    howto.addEventListener('toggle', () => {
      try {
        window.localStorage.setItem(HOWTO_KEY, howto.open ? '1' : '0');
      } catch {
        /* nem menthető: csak erre az alkalomra érvényes */
      }
    });
    // az útmutató megnyitáskor épül fel: a tárgyaknál a most beállított billentyűk állnak
    el('main-guide').onclick = () => {
      buildGuide(el('guide-body'), this.settings.keys);
      this.show('guide');
      el('guide-body').scrollTop = 0;
    };
    el('guide-back').onclick = () => this.show('main');
    el('main-garage').onclick = () => {
      this.buildGarage();
      this.show('garage');
    };
    el('garage-back').onclick = () => this.show('main');
    el('main-multiplayer').onclick = () => this.show('lobby');
    const single = (): void => {
      this.single = true;
      this.show('create');
    };
    el('auth-single').onclick = single;
    el('main-single').onclick = single;
    el('main-logout').onclick = () => {
      this.net.logout();
      this.settings.token = '';
      this.save();
      this.showAuth(false);
    };
  }

  private onMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'auth': {
        this.settings.token = message.token;
        this.settings.name = message.name;
        this.admin = message.admin === true;
        this.save();
        el<HTMLInputElement>('auth-password').value = '';
        this.showAuth(true);
        // meccs után egyből a játékok listája nyílik meg
        let back: string | null = null;
        try {
          back = window.sessionStorage.getItem(RETURN_KEY);
          window.sessionStorage.removeItem(RETURN_KEY);
        } catch {
          /* nincs munkamenet-tároló */
        }
        if (back === 'lobby') this.show('lobby');
        try {
          this.rejoin = window.sessionStorage.getItem(REJOIN_KEY);
          window.sessionStorage.removeItem(REJOIN_KEY);
        } catch {
          this.rejoin = null;
        }
        break;
      }
      case 'authError':
        this.error(message.message);
        // a megőrzött kulcs már nem érvényes: újra be kell lépni
        if (!this.net.authed) {
          this.settings.token = '';
          this.save();
          this.showAuth(false);
        }
        break;
      case 'error':
        this.error(message.message);
        break;
      case 'rooms':
        this.renderRooms(message.rooms);
        // a módosított nyitott játékba automatikusan visszalép
        if (this.rejoin) {
          const room = message.rooms.find((r) => r.id === this.rejoin);
          this.rejoin = null;
          if (room) this.net.send({ t: 'join', room: room.id, look: this.settings.look });
        }
        break;
      case 'chat':
        this.chatLine(message.from, message.text, [message.me ? 'me' : '', `scope-${message.scope}`].join(' ').trim());
        break;
      case 'online':
        this.renderOnline(message.players);
        break;
      case 'chatHistory':
        // az előszoba utolsó üzenetei (belépéskor)
        this.chatLog.replaceChildren();
        for (const line of message.lines) this.chatLine(line.from, line.text, `scope-lobby${line.from === this.net.name ? ' me' : ''}`);
        break;
      case 'room':
        this.currentRoom = message.room;
        this.closeCode();
        this.renderRoom(message.room, message.countdown, message.code ?? '');
        if (this.screen !== 'room') this.show('room');
        break;
      case 'left':
        this.currentRoom = null;
        if (message.reason && this.screen === 'room') this.error(message.reason);
        if (this.screen === 'room') this.show('lobby');
        break;
    }
  }

  // --- beállítások: billentyűk ---------------------------------------------------

  private bindSettings(): void {
    el('settings-back').onclick = () => {
      this.listening = null;
      this.show('main');
    };
    // hangerő: a csúszka elengedésekor egy próbahang szól az új hangerőn
    const volume = el<HTMLInputElement>('sl-volume');
    const preview = new Sfx();
    const showVolume = (): void => {
      volume.value = String(this.settings.volume);
      el('val-volume').textContent = this.settings.volume === 0 ? 'néma' : `${this.settings.volume}%`;
    };
    showVolume();
    volume.addEventListener('input', () => {
      this.settings.volume = Number(volume.value);
      showVolume();
    });
    volume.addEventListener('change', () => {
      this.save();
      preview.unlock();
      preview.setVolume(this.settings.volume / 100);
      preview.shot();
    });
    el('settings-reset').onclick = () => {
      this.settings.keys = defaultKeys();
      this.settings.volume = DEFAULT_VOLUME;
      this.save();
      showVolume();
      this.renderKeys();
    };
    window.addEventListener(
      'keydown',
      (ev) => {
        const target = this.listening;
        if (!target || this.screen !== 'settings') return;
        ev.preventDefault();
        ev.stopPropagation();
        const keys = this.settings.keys;
        // a rögzített billentyű (M: térkép) más művelethez sem adható
        if (Object.values(FIXED_KEYS).some((codes) => codes?.includes(ev.code))) {
          this.listening = null;
          this.error(`Az ${keyName(ev.code)} a térképé, ez nem állítható át.`);
          this.renderKeys();
          return;
        }
        if (ev.code === 'Delete' || ev.code === 'Backspace') {
          keys[target.action].splice(target.slot, 1);
        } else if (ev.code !== 'Escape') {
          // egy billentyű csak egy művelethez tartozhat
          for (const action of ACTIONS) keys[action] = keys[action].filter((code) => code !== ev.code);
          const list = keys[target.action];
          list[Math.min(target.slot, list.length)] = ev.code;
        }
        this.listening = null;
        this.save();
        this.renderKeys();
      },
      true,
    );
  }

  private renderKeys(): void {
    const table = el('key-table');
    table.replaceChildren();
    for (const action of ACTIONS) {
      const label = document.createElement('div');
      label.textContent = ACTION_LABEL[action];
      table.appendChild(label);
      const fixed = FIXED_KEYS[action];
      if (fixed) {
        // rögzített billentyű: látszik, de nem kattintható
        const cap = document.createElement('div');
        cap.className = 'keycap fixed';
        cap.title = 'Rögzített billentyű, nem állítható át';
        cap.textContent = `${fixed.map(keyName).join(' / ')} (rögzített)`;
        table.appendChild(cap);
        continue;
      }
      for (let slot = 0; slot < 2; slot++) {
        const cap = document.createElement('div');
        const listening = this.listening?.action === action && this.listening.slot === slot;
        cap.className = listening ? 'keycap listening' : 'keycap';
        const code = this.settings.keys[action][slot];
        cap.textContent = listening ? 'nyomj egy gombot…' : code ? keyName(code) : '–';
        cap.onclick = () => {
          this.listening = { action, slot };
          this.renderKeys();
        };
        table.appendChild(cap);
      }
    }
  }

  // --- a játékok listája ---------------------------------------------------------

  private bindLobby(): void {
    el('lobby-back').onclick = () => {
      this.closeCode();
      this.show('main');
    };
    el('lobby-create').onclick = () => {
      this.closeCode();
      this.single = false;
      this.editing = null;
      this.show('create');
    };
    const input = el<HTMLInputElement>('code-input');
    const submit = (): void => {
      if (!this.codeRoom) return;
      if (cleanCode(input.value).length < ROOM_CODE.min) return this.error('Add meg a belépőkódot.');
      this.net.send({ t: 'join', room: this.codeRoom, code: input.value, look: this.settings.look });
    };
    el('code-ok').onclick = submit;
    el('code-cancel').onclick = () => this.closeCode();
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit();
      else if (ev.key === 'Escape') this.closeCode();
    });
  }

  /** Privát szobába lépés: a kód bekérése a lista alatt. */
  private askCode(room: RoomInfo): void {
    this.codeRoom = room.id;
    el('code-title').textContent = `Belépőkód – ${room.settings.name}`;
    el('code-box').classList.remove('hidden');
    const input = el<HTMLInputElement>('code-input');
    input.value = '';
    input.focus();
  }

  private closeCode(): void {
    this.codeRoom = null;
    el('code-box').classList.add('hidden');
  }

  private renderRooms(rooms: RoomInfo[]): void {
    const list = el('room-list');
    list.replaceChildren();
    // ha közben megszűnt vagy betelt a szoba, amelyhez a kódot kérjük, a kérdés eltűnik
    if (this.codeRoom && !rooms.some((r) => r.id === this.codeRoom && r.status === 'waiting')) this.closeCode();
    if (rooms.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Most nincs nyitott játék. Hozz létre egyet az „Új játék” gombbal!';
      list.appendChild(empty);
      return;
    }
    for (const room of rooms) {
      // a nyitott játékba menet közben is be lehet lépni
      const open = (room.demo || room.status === 'waiting') && room.players.length < room.settings.maxPlayers;
      const row = document.createElement('div');
      row.className = 'room';
      row.innerHTML =
        `<div><div class="name">${room.locked ? '<span class="lock" title="Privát játék – belépőkód kell">🔒</span> ' : ''}${esc(room.settings.name)}</div>` +
        `<div class="small">létrehozta: ${esc(room.host)}${room.locked ? ' · privát' : ''}</div></div>` +
        `<div>${room.players.length} / ${room.settings.maxPlayers} játékos</div>` +
        `<div class="small">${roomDetails(room)}</div>` +
        `<div class="state ${room.demo ? 'demo' : open ? 'waiting' : 'full'}">${room.demo ? 'Nyitott játék – bármikor beléphetsz' : STATUS_NAME[room.status]}</div>`;
      const join = document.createElement('span');
      join.className = open ? 'btn' : 'btn disabled';
      join.textContent = 'Belépés';
      join.onclick = () => {
        if (!open) return;
        if (room.locked) this.askCode(room);
        else this.net.send({ t: 'join', room: room.id, look: this.settings.look });
      };
      row.appendChild(join);
      // a nyitott játékot csak a szerver gazdája módosíthatja és állíthatja le
      if (room.demo && this.admin) {
        const change = document.createElement('span');
        change.className = 'btn stop';
        change.textContent = 'Módosítás';
        change.onclick = () => {
          this.editing = room;
          this.single = false;
          this.show('create');
        };
        row.appendChild(change);
        const stop = document.createElement('span');
        stop.className = 'btn danger stop';
        stop.textContent = 'Leállítás';
        stop.onclick = () => {
          if (window.confirm(`Leállítod a nyitott játékot? A bent lévő ${room.players.length} játékos visszakerül a játékok listájához.`)) this.net.send({ t: 'closeDemo', room: room.id });
        };
        row.appendChild(stop);
      }
      list.appendChild(row);
    }
  }

  // --- új játék ------------------------------------------------------------------

  private readonly sliders = ['players', 'minutes', 'bots', 'skill', 'aggression', 'toughness', 'pickups', 'traffic', 'weather', 'tempo', 'expected'] as const;
  /** a tempó által beállított (tempó állásban zárolt) csúszkák */
  private readonly tempoSliders = ['bots', 'skill', 'aggression', 'toughness', 'pickups', 'traffic'] as const;

  /** A tempó állása (0: egyéni). */
  private tempo(): number {
    return Number(el<HTMLInputElement>('sl-tempo').value) || 0;
  }

  /** Hány játékosra méretezzük a pályát: egyjátékosnál 1, nyitott játéknál a várható létszám, különben a létszám. */
  private sizingCount(): number {
    if (this.single) return 1;
    return this.demoChosenOrEditing() ? Number(el<HTMLInputElement>('sl-expected').value) : Number(el<HTMLInputElement>('sl-players').value);
  }

  /** Tempó állásban: ajánlott játéktér a játékosszámhoz, véletlen „jó” helyen (avoid: a mostanitól eltérő hely). */
  private suggestArea(avoid = false): void {
    const tempo = this.tempo();
    if (tempo <= TEMPO.custom) return;
    this.sel = pickArea(this.map.data, this.grid.cols, this.grid.rows, tempoKm2(tempo, this.sizingCount()), MATCH.minCells, Math.random, avoid ? this.selection() : undefined);
  }

  private bindCreate(): void {
    el('create-back').onclick = () => {
      this.editing = null;
      this.show(this.single ? 'main' : 'lobby');
    };
    el('create-ok').onclick = () => {
      const settings = this.readCreate();
      // a létszám a többjátékos beállítás része: egyjátékos indítás nem írja felül
      this.settings.lastMatch = this.single ? { ...settings, maxPlayers: this.settings.lastMatch?.maxPlayers ?? 4 } : settings;
      this.save();
      if (this.single) return this.onSingle(settings, this.net.name || this.settings.name || 'Játékos');
      const code = el<HTMLInputElement>('create-code').value;
      if (code.trim() && cleanCode(code).length < ROOM_CODE.min) return this.error(`A belépőkód legalább ${ROOM_CODE.min} karakter legyen.`);
      if (this.editing) {
        // a futó nyitott játék módosítása: a bent lévők újratöltenek, és az új pályán folytatják
        const room = this.editing;
        this.editing = null;
        this.net.send({ t: 'modifyOpen', room: room.id, settings });
        this.show('lobby');
        return;
      }
      if (this.demoChosen()) {
        // a nyitott játék a gazdája nélkül indul: ő a játékok listájához kerül, onnan beléphet, ha akar
        this.net.send({ t: 'create', settings, look: this.settings.look, demo: true });
        this.show('lobby');
        return;
      }
      this.net.send({ t: 'create', settings, look: this.settings.look, ...(code.trim() ? { code } : {}) });
    };
    for (const name of this.sliders) el<HTMLInputElement>(`sl-${name}`).addEventListener('input', () => this.updateCreate());
    // a tempó és a létszám változásakor a gép új pályát ajánl (a többi csúszkánál a pálya marad)
    for (const name of ['tempo', 'players', 'expected']) {
      el<HTMLInputElement>(`sl-${name}`).addEventListener('input', () => {
        this.suggestArea();
        this.updateCreate();
      });
    }
    // Egyénire váltáskor a csúszkák a tempó értékeiről indulnak: a botok szintje is akkora, hogy nagyjából ugyanannyi bot legyen
    let lastTempo = this.tempo();
    el<HTMLInputElement>('sl-tempo').addEventListener('input', () => {
      const tempo = this.tempo();
      if (tempo === TEMPO.custom && lastTempo > TEMPO.custom) {
        const was = this.readCreateAt(lastTempo);
        const plan = matchPlan(was, this.demoChosenOrEditing());
        const perLevel = Math.max(0.01, MATCH.botsPerKm2 * plan.km2);
        el<HTMLInputElement>('sl-bots').value = String(Math.max(1, Math.min(MATCH.levels.max, Math.round(plan.bots / perLevel))));
        this.updateCreate();
      }
      lastTempo = tempo;
    });
    el('area-reroll').onclick = () => {
      this.suggestArea(true);
      this.updateCreate();
    };
    // játékmód: a választható módok listája (ha új mód készül, magától megjelenik itt)
    const mode = el<HTMLSelectElement>('create-mode');
    mode.replaceChildren(
      ...GAME_MODES.map((m) => {
        const option = document.createElement('option');
        option.value = m;
        option.textContent = GAME_MODE_NAME[m];
        return option;
      }),
    );
    mode.addEventListener('change', () => this.updateCreate());
    el<HTMLInputElement>('create-demo').addEventListener('change', () => {
      // nyitott játéknál a létszám 2–100 között állítható (alapból 100), különben 1–8
      const slider = el<HTMLInputElement>('sl-players');
      const demo = el<HTMLInputElement>('create-demo').checked;
      slider.min = String(demo ? DEMO.minPlayers : MATCH.players.min);
      slider.max = String(demo ? DEMO.maxPlayers : MATCH.players.max);
      slider.value = String(demo ? DEMO.maxPlayers : Math.min(Number(slider.value), MATCH.players.max));
      // nyitott játéknál a várható létszámhoz igazodik a pálya
      this.suggestArea();
      this.updateCreate();
    });

    const canvas = el<HTMLCanvasElement>('area-map');
    const cellAt = (ev: MouseEvent): { c: number; r: number } => {
      const rect = canvas.getBoundingClientRect();
      return {
        c: Math.max(0, Math.min(this.grid.cols - 1, Math.floor(((ev.clientX - rect.left) / rect.width) * this.grid.cols))),
        r: Math.max(0, Math.min(this.grid.rows - 1, Math.floor(((ev.clientY - rect.top) / rect.height) * this.grid.rows))),
      };
    };
    canvas.addEventListener('mousedown', (ev) => {
      // tempó állásban a pályát a gép ajánlja: kijelölni Egyéni állásban lehet
      if (this.tempo() > TEMPO.custom) {
        this.error('Tempó állásban a pályát a gép ajánlja („Másik helyszín” gomb). Saját kijelöléshez állítsd a tempót Egyénire.');
        return;
      }
      const { c, r } = cellAt(ev);
      this.dragging = true;
      this.sel = { c0: c, r0: r, c1: c, r1: r };
      this.updateCreate();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!this.dragging) return;
      const { c, r } = cellAt(ev);
      if (c === this.sel.c1 && r === this.sel.r1) return;
      this.sel.c1 = c;
      this.sel.r1 = r;
      this.updateCreate();
    });
    window.addEventListener('mouseup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.updateCreate();
    });
  }

  /** A kijelölés rendezve, és legalább a legkisebb megengedett méretre bővítve. */
  private selection(): { c0: number; r0: number; c1: number; r1: number } {
    let c0 = Math.min(this.sel.c0, this.sel.c1);
    let c1 = Math.max(this.sel.c0, this.sel.c1);
    let r0 = Math.min(this.sel.r0, this.sel.r1);
    let r1 = Math.max(this.sel.r0, this.sel.r1);
    const min = MATCH.minCells;
    if (c1 - c0 + 1 < min) {
      c1 = Math.min(this.grid.cols - 1, c0 + min - 1);
      c0 = Math.max(0, c1 - min + 1);
    }
    if (r1 - r0 + 1 < min) {
      r1 = Math.min(this.grid.rows - 1, r0 + min - 1);
      r0 = Math.max(0, r1 - min + 1);
    }
    return { c0, r0, c1, r1 };
  }

  private openCreate(): void {
    const { map } = this;
    if (!this.areaBase) {
      // a pálya egyszerűsített képe a kijelöléshez
      const scale = 500 / map.height;
      const w = Math.round(map.width * scale);
      const h = Math.round(map.height * scale);
      const buf = new Uint32Array(w * h);
      renderMap(map, { buf, w, h, ox: 0, oy: 0, scale, detail: false });
      this.areaBase = document.createElement('canvas');
      this.areaBase.width = w;
      this.areaBase.height = h;
      this.areaBase.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer), w, h), 0, 0);
      const canvas = el<HTMLCanvasElement>('area-map');
      canvas.width = w;
      canvas.height = h;

      // alapértékek: az előző játék beállításai, különben a hivatal környéke
      const last = sanitizeSettings(this.settings.lastMatch, map.width, map.height);
      const cw = map.width / this.grid.cols;
      const ch = map.height / this.grid.rows;
      if (this.settings.lastMatch?.area) {
        this.sel = { c0: Math.round(last.area.minX / cw), r0: Math.round(last.area.minY / ch), c1: Math.round(last.area.maxX / cw) - 1, r1: Math.round(last.area.maxY / ch) - 1 };
      } else {
        const c = Math.floor(map.data.townhall.x / cw);
        const r = Math.floor(map.data.townhall.y / ch);
        // kb. 750 × 750 méter a hivatal körül
        this.sel = { c0: Math.max(0, c - 4), r0: Math.max(0, r - 4), c1: Math.min(this.grid.cols - 1, c + 4), r1: Math.min(this.grid.rows - 1, r + 4) };
      }
      el<HTMLSelectElement>('create-mode').value = last.mode;
      el<HTMLInputElement>('sl-players').value = String(last.maxPlayers);
      el<HTMLInputElement>('sl-minutes').value = String(last.minutes);
      el<HTMLInputElement>('sl-bots').value = String(last.bots);
      el<HTMLInputElement>('sl-skill').value = String(last.botSkill);
      el<HTMLInputElement>('sl-aggression').value = String(last.botAggression);
      el<HTMLInputElement>('sl-toughness').value = String(last.botToughness ?? BOT_TOUGHNESS_LEVELS.normal);
      el<HTMLInputElement>('sl-pickups').value = String(last.pickups);
      el<HTMLInputElement>('sl-traffic').value = String(last.traffic);
      el<HTMLInputElement>('sl-weather').value = String(WEATHERS.indexOf(last.weather));
      // az alap tempó a pörgős; ha legutóbb mást választott, azt
      el<HTMLInputElement>('sl-tempo').value = String(this.settings.lastMatch?.tempo !== undefined ? last.tempo : TEMPO.normal);
      el<HTMLInputElement>('sl-expected').value = String(last.expectedPlayers);
    }
    el<HTMLInputElement>('create-name').value = `${this.net.name} játéka`;
    // egyjátékos módban nincs szoba: nem kell név és létszám, és azonnal indul
    el('create-title').textContent = this.single ? 'Egyjátékos játék' : 'Új játék';
    el('create-name-field').classList.toggle('hidden', this.single);
    el('create-players-field').classList.toggle('hidden', this.single);
    el('create-code-field').classList.toggle('hidden', this.single);
    el('create-ok').textContent = this.single ? 'Indítás' : 'Létrehozás';
    // nyitott játékot csak a szerver gazdája nyithat
    el('create-demo-field').classList.toggle('hidden', this.single || !this.admin);
    const open = el<HTMLInputElement>('create-demo');
    open.checked = false;
    open.disabled = false;
    el<HTMLInputElement>('sl-players').min = String(MATCH.players.min);
    el<HTMLInputElement>('sl-players').max = String(MATCH.players.max);
    if (this.editing && this.admin && !this.single) this.fillFromRoom(this.editing);
    // tempó állásban minden megnyitáskor friss ajánlat (a módosításnál a játék mostani pályája marad)
    else this.suggestArea();
    this.updateCreate();
  }

  /** A futó nyitott játék beállításai a létrehozó képernyőn (módosításhoz). */
  private fillFromRoom(room: RoomInfo): void {
    const s = room.settings;
    const cw = this.map.width / this.grid.cols;
    const ch = this.map.height / this.grid.rows;
    this.sel = { c0: Math.round(s.area.minX / cw), r0: Math.round(s.area.minY / ch), c1: Math.round(s.area.maxX / cw) - 1, r1: Math.round(s.area.maxY / ch) - 1 };
    el<HTMLInputElement>('create-name').value = s.name;
    el<HTMLSelectElement>('create-mode').value = s.mode;
    const open = el<HTMLInputElement>('create-demo');
    open.checked = true;
    open.disabled = true;
    // a létszám nem lehet kisebb, mint ahányan éppen bent vannak
    const players = el<HTMLInputElement>('sl-players');
    players.min = String(Math.max(DEMO.minPlayers, room.players.length));
    players.max = String(DEMO.maxPlayers);
    players.value = String(Math.max(s.maxPlayers, room.players.length));
    const set = (id: string, v: number): void => {
      el<HTMLInputElement>(id).value = String(v);
    };
    set('sl-bots', s.bots);
    set('sl-skill', s.botSkill);
    set('sl-aggression', s.botAggression);
    set('sl-toughness', s.botToughness ?? BOT_TOUGHNESS_LEVELS.normal);
    set('sl-pickups', s.pickups);
    set('sl-traffic', s.traffic);
    set('sl-weather', WEATHERS.indexOf(s.weather));
    set('sl-tempo', s.tempo ?? TEMPO.custom);
    set('sl-expected', s.expectedPlayers ?? 10);
    el('create-title').textContent = `Nyitott játék módosítása – ${s.name}`;
  }

  /** A szerver gazdája nyitott játékot kért (korlátlan ideig fut, szabad belépéssel). */
  private demoChosenOrEditing(): boolean {
    return this.editing !== null || this.demoChosen();
  }

  /** A szerver gazdája új nyitott játékot kért. */
  private demoChosen(): boolean {
    return !this.single && this.admin && el<HTMLInputElement>('create-demo').checked;
  }

  /** A beállítások, mintha a tempó `tempo` állásban lenne (az Egyénire váltás előtti értékekhez). */
  private readCreateAt(tempo: number): MatchSettings {
    const slider = el<HTMLInputElement>('sl-tempo');
    const now = slider.value;
    slider.value = String(tempo);
    try {
      return this.readCreate();
    } finally {
      slider.value = now;
    }
  }

  private readCreate(): MatchSettings {
    const value = (name: string): number => Number(el<HTMLInputElement>(`sl-${name}`).value);
    const s = this.selection();
    const settings = sanitizeSettings(
      {
        name: el<HTMLInputElement>('create-name').value,
        mode: el<HTMLSelectElement>('create-mode').value as GameMode,
        area: areaOfCells(this.map.width, this.map.height, s.c0, s.r0, s.c1, s.r1),
        maxPlayers: this.single ? 1 : value('players'),
        minutes: value('minutes'),
        bots: value('bots'),
        botSkill: value('skill'),
        botAggression: value('aggression'),
        botToughness: value('toughness'),
        pickups: value('pickups'),
        traffic: value('traffic'),
        weather: WEATHERS[value('weather')] ?? 'day',
        tempo: value('tempo'),
        expectedPlayers: value('expected'),
      },
      this.map.width,
      this.map.height,
    );
    // a nyitott játék létszáma nagyobb lehet (2–100): a gazdája adja meg
    if (this.demoChosenOrEditing()) settings.maxPlayers = demoPlayers(value('players'));
    // tempó állásban a botok, a tárgyak és a forgalom a tempó táblázatából jön (a szerver is így számol)
    return applyTempo(settings);
  }

  /** A csúszkák feliratai és a térkép a kijelöléssel; a tényleges létszámokat a pálya mérete adja. */
  private updateCreate(): void {
    const settings = this.readCreate();
    const plan = matchPlan(settings, this.demoChosenOrEditing());
    el('mode-note').textContent = GAME_MODE_HINT[settings.mode];
    // a tempó: a felirat, a leírás, és a tempó által beállított mezők zárolása (a csúszkák a tempó értékeit mutatják)
    const tempo = settings.tempo;
    const locked = tempo > TEMPO.custom;
    el('val-tempo').textContent = TEMPO_NAMES[tempo];
    el('tempo-note').textContent = locked ? `${TEMPO_HINTS[tempo]} A pályát, a botokat, a tárgyakat és a forgalmat a gép állítja be – kézi beállításhoz válaszd az Egyénit.` : TEMPO_HINTS[tempo];
    for (const name of this.tempoSliders) {
      const input = el<HTMLInputElement>(`sl-${name}`);
      input.disabled = locked;
      input.closest('label')?.classList.toggle('locked', locked);
    }
    if (locked) {
      el<HTMLInputElement>('sl-bots').value = String(settings.bots);
      el<HTMLInputElement>('sl-skill').value = String(settings.botSkill);
      el<HTMLInputElement>('sl-aggression').value = String(settings.botAggression);
      el<HTMLInputElement>('sl-toughness').value = String(settings.botToughness);
      el<HTMLInputElement>('sl-pickups').value = String(settings.pickups);
      el<HTMLInputElement>('sl-traffic').value = String(settings.traffic);
    }
    el('area-reroll').classList.toggle('hidden', !locked);
    el('area-map').classList.toggle('locked', locked);
    el('area-hint').textContent = locked ? 'Pálya: a tempóhoz és a létszámhoz ajánlott terület' : 'Pálya: húzd az egeret a térképen a játéktér kijelöléséhez';
    el('create-expected-field').classList.toggle('hidden', !this.demoChosenOrEditing());
    el('val-expected').textContent = `${settings.expectedPlayers} fő`;
    el('val-players').textContent = `${settings.maxPlayers} fő`;
    el('val-minutes').textContent = `${settings.minutes} perc`;
    el('val-bots').textContent = locked ? `a tempó szerint – ${plan.bots} bot` : settings.bots ? `${LEVEL_NAME[settings.bots]} – kb. ${plan.bots} bot` : 'nincs';
    el('val-skill').textContent = settings.bots ? SKILL_NAME[settings.botSkill] : '–';
    el('val-aggression').textContent = settings.bots ? AGGRESSION_NAME[settings.botAggression] : '–';
    {
      // a szívósság: mennyit sebez egy lövése, és hány találatot bír ki (a játékos 1. szintű tankjához mérve)
      const t = BOT_TOUGHNESS[settings.botToughness - 1];
      const hits = Math.ceil(TANK.maxHp / (DAMAGE.shell * t.armor));
      el('val-toughness').textContent = settings.bots ? `${TOUGHNESS_NAME[settings.botToughness]} – lövése ${Math.round(DAMAGE.shell * t.damage)}, ${hits} találatot bír` : '–';
    }
    el('val-pickups').textContent = settings.pickups ? `${LEVEL_NAME[settings.pickups]} – kb. ${plan.pickups} db` : 'nincs';
    el('val-traffic').textContent = settings.traffic ? `${LEVEL_NAME[settings.traffic]} – kb. ${plan.traffic} jármű` : 'nincs';
    el('val-weather').textContent = WEATHER_NAME[settings.weather];
    // nyitott játék: nincs létszám (legfeljebb 100), időkorlát és belépőkód
    const demo = this.demoChosenOrEditing();
    el('create-players-field').classList.toggle('hidden', this.single);
    el('sl-minutes').closest('label')?.classList.toggle('hidden', demo);
    el('create-code-field').classList.toggle('hidden', this.single || demo);
    if (!this.single) el('create-ok').textContent = this.editing ? 'Módosítás mentése' : demo ? 'Nyitott játék indítása' : 'Létrehozás';
    const { area } = settings;
    el('area-text').textContent = `Kijelölt játéktér: ${area.maxX - area.minX} × ${area.maxY - area.minY} m (${km2(plan.km2)}) – a legkisebb kb. ${Math.round((this.map.width / this.grid.cols) * MATCH.minCells)} m széles`;

    const canvas = el<HTMLCanvasElement>('area-map');
    const ctx = canvas.getContext('2d');
    if (!ctx || !this.areaBase) return;
    const { cols, rows } = this.grid;
    const cw = canvas.width / cols;
    const ch = canvas.height / rows;
    const s = this.selection();
    ctx.drawImage(this.areaBase, 0, 0);
    // a kijelölésen kívüli rész elsötétül
    ctx.fillStyle = 'rgba(8, 10, 14, 0.62)';
    ctx.fillRect(0, 0, canvas.width, s.r0 * ch);
    ctx.fillRect(0, (s.r1 + 1) * ch, canvas.width, canvas.height);
    ctx.fillRect(0, s.r0 * ch, s.c0 * cw, (s.r1 - s.r0 + 1) * ch);
    ctx.fillRect((s.c1 + 1) * cw, s.r0 * ch, canvas.width, (s.r1 - s.r0 + 1) * ch);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < cols; c++) {
      ctx.moveTo(Math.round(c * cw) + 0.5, 0);
      ctx.lineTo(Math.round(c * cw) + 0.5, canvas.height);
    }
    for (let r = 1; r < rows; r++) {
      ctx.moveTo(0, Math.round(r * ch) + 0.5);
      ctx.lineTo(canvas.width, Math.round(r * ch) + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = '#ffd84a';
    ctx.lineWidth = 3;
    ctx.strokeRect(s.c0 * cw + 1.5, s.r0 * ch + 1.5, (s.c1 - s.c0 + 1) * cw - 3, (s.r1 - s.r0 + 1) * ch - 3);
  }

  // --- váró ----------------------------------------------------------------------

  private renderRoom(room: RoomInfo, countdown: number, code: string): void {
    el('room-title').textContent = room.settings.name;
    // privát játék: a bent lévők látják a kódot, hogy tovább tudják adni
    const codeNote = el('room-code');
    codeNote.classList.toggle('hidden', !room.locked);
    codeNote.textContent = room.locked ? `🔒 Privát játék – belépőkód: ${code}` : '';
    el('room-summary').textContent = `${roomDetails(room)} · tárgyak: ${LEVEL_NAME[room.settings.pickups]} · forgalom: ${LEVEL_NAME[room.settings.traffic]}`;
    const list = el('room-players');
    list.replaceChildren();
    for (let i = 0; i < room.settings.maxPlayers; i++) {
      const row = document.createElement('div');
      const name = room.players[i];
      row.className = name === undefined ? 'player-row free' : name === this.net.name ? 'player-row me' : 'player-row';
      row.innerHTML = `<span>${i + 1}.</span><span>${name === undefined ? 'szabad hely' : esc(name)}</span>`;
      list.appendChild(row);
    }
    el('room-state').textContent =
      room.status === 'starting' ? `Mindenki megvan – indul: ${countdown}…` : `Várakozás a játékosokra: ${room.players.length} / ${room.settings.maxPlayers}`;
  }

  // --- tankválasztó ---------------------------------------------------------------

  /** Egy tank képe (test + torony) külön vásznon; scale: nagyítás. */
  private tankPicture(look: number, tier: number, scale: number, marks = 0): HTMLCanvasElement {
    const sprites = tankSprites(tier, 'own', marks, look);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(HULL_SIZE.w * scale);
    canvas.height = Math.round(HULL_SIZE.h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.imageSmoothingEnabled = false;
    ctx.scale(scale, scale);
    ctx.drawImage(sprites.hull[0], 0, 0);
    ctx.drawImage(sprites.turret, HULL_SIZE.w / 2 - TURRET_PIVOT.x, HULL_SIZE.h / 2 - TURRET_PIVOT.y);
    return canvas;
  }

  /** A három alaptank kártyái, és a kiválasztott tank fejlődése az osztályokon át. */
  private buildGarage(): void {
    const cards = el('garage-cards');
    cards.replaceChildren();
    TANK_LOOK_NAMES.forEach((name, look) => {
      const card = document.createElement('div');
      card.className = look === this.settings.look ? 'garage-card selected' : 'garage-card';
      card.setAttribute('role', 'button');
      card.appendChild(this.tankPicture(look, 0, 2.4));
      const text = document.createElement('div');
      text.innerHTML = `<b>${esc(name)}</b><span>${esc(TANK_LOOK_HINT[look])}</span>`;
      card.appendChild(text);
      card.onclick = () => {
        this.settings.look = look;
        this.settings = saveSettings(this.settings);
        this.buildGarage();
      };
      cards.appendChild(card);
    });
    const look = this.settings.look;
    el('garage-title').textContent = `${TANK_LOOK_NAMES[look]} – így fejlődik a szintekkel`;
    const row = el('garage-tiers');
    row.replaceChildren();
    LOOK_TIER_NAMES[look].forEach((tierName, tier) => {
      const item = document.createElement('div');
      item.className = 'garage-tier';
      item.appendChild(this.tankPicture(look, tier, 1.45, Math.min(2, tier)));
      const label = document.createElement('span');
      const next = LEVEL.tiers[tier + 1];
      label.innerHTML = `<b>${esc(tierName)}</b><br />${LEVEL.tiers[tier]}${next ? `–${next - 1}` : `–${LEVEL.max}`}. szint`;
      item.appendChild(label);
      row.appendChild(item);
    });
  }

  // --- eredmény ------------------------------------------------------------------

  showResults(winner: string | null, standings: Standing[], myId: string): void {
    const me = standings.find((s) => s.id === myId);
    const first = standings.find((s) => s.id === winner);
    // egyedül játszva nincs győztes és nincs ellenséges játékos: az eredmény a kilőtt botok száma
    const solo = standings.length === 1;
    el('results-title').textContent = solo
      ? `Lejárt az idő – ${me?.bots ?? 0} kilőtt bot`
      : winner === myId
        ? 'Győztél!'
        : first
          ? `Vége – nyert: ${first.name}`
          : 'Lejárt az idő – döntetlen';
    const table = el('results-table');
    table.replaceChildren();
    // a meccs legjobbja: a statisztikákból számolt pontszám szerint (nem feltétlenül a győztes)
    const mvp = standings.find((s) => s.mvp);
    if (mvp) {
      const box = document.createElement('div');
      box.className = 'mvp';
      const why = [
        `${mvp.kills} kilövés`,
        mvp.bots > 0 ? `${mvp.bots} bot` : '',
        `${mvp.damage} sebzés`,
        mvp.accuracy >= 0 ? `${mvp.accuracy}% pontosság` : '',
        mvp.streak > 1 ? `${mvp.streak}-es sorozat` : '',
      ].filter(Boolean);
      box.innerHTML = `<span class="mvp-star">★</span> A meccs legjobbja: <b>${esc(mvp.name)}</b> – ${mvp.score} pont<br /><span class="stats">${why.join(' · ')}</span>`;
      table.appendChild(box);
    }
    const ratio = (s: Standing): string => (s.deaths > 0 ? (s.kills / s.deaths).toFixed(1).replace('.', ',') : s.kills > 0 ? `${s.kills},0` : '–');
    const grid = document.createElement('table');
    grid.className = 'results-grid';
    grid.innerHTML =
      '<thead><tr><th>#</th><th class="name">Játékos</th><th title="Teljesítménypont a statisztikákból">Pont</th><th title="Kilőtt ellenséges játékosok">Kilövés</th><th title="Kilőtt botok (a helyezésbe nem számít)">Bot</th><th>Halál</th><th title="Kilövés / halál">Arány</th>' +
      '<th title="Az ellenfeleknek okozott sebzés">Sebzés</th><th title="Elszenvedett sebzés">Kapott</th><th>Találat / lövés</th><th>Pontosság</th><th title="Leghosszabb kilövéssorozat halál nélkül">Sorozat</th><th title="Ledöntött házak">Ház</th><th>Szint</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const s of standings) {
      const row = document.createElement('tr');
      row.className = [s === me ? 'me' : '', s.mvp ? 'best' : '', s.gone ? 'gone' : ''].filter(Boolean).join(' ');
      row.innerHTML =
        `<td>${s.place}.</td><td class="name">${s.mvp ? '<span class="mvp-star">★</span> ' : ''}${esc(s.name)}${s.gone ? ' <span class="stats">(kilépett)</span>' : ''}</td>` +
        `<td class="score">${s.score}</td><td>${s.kills}</td><td>${s.bots ?? 0}</td><td>${s.deaths}</td><td>${ratio(s)}</td><td>${s.damage}</td><td>${s.taken}</td>` +
        `<td>${s.hits} / ${s.shots}</td><td>${s.accuracy >= 0 ? `${s.accuracy}%` : '–'}</td><td>${s.streak}</td><td>${s.wrecked}</td><td>${s.level}.</td>`;
      body.appendChild(row);
    }
    grid.appendChild(body);
    const scroll = document.createElement('div');
    scroll.className = 'results-scroll';
    scroll.appendChild(grid);
    table.appendChild(scroll);
    const note = document.createElement('p');
    note.className = 'note results-note';
    note.textContent = `Pont: kilövés ${SCORE.kill}, halál ${SCORE.death}, sebzés pontonként ${String(SCORE.damage).replace('.', ',')}, sorozat ${SCORE.streak}, pontosság %-onként ${SCORE.accuracy} (legalább ${SCORE.accuracyShots} lövésnél), ledöntött ház ${SCORE.wrecked} (legfeljebb ${SCORE.wreckedMax}), szint ${SCORE.level}. A helyezés a kilövések száma szerint dől el; kilövésnek csak az ellenséges játékos kilövése számít, a kilőtt botok csak statisztika.`;
    table.appendChild(note);
    // különdíjak: több játékosnál az kapja, aki a legjobb az adott dologban
    if (!solo) {
      const best = (value: (s: Standing) => number, text: (s: Standing) => string): string => {
        const top = [...standings].sort((a, b) => value(b) - value(a))[0];
        return top && value(top) > 0 ? `<div>${text(top)}</div>` : '';
      };
      const awards = document.createElement('div');
      awards.className = 'awards';
      awards.innerHTML =
        best((s) => s.streak, (s) => `Leghosszabb sorozat: <b>${esc(s.name)}</b> – ${s.streak} kilövés halál nélkül`) +
        best((s) => s.wrecked, (s) => `Legtöbb ledöntött ház: <b>${esc(s.name)}</b> – ${s.wrecked}`) +
        best((s) => s.accuracy, (s) => `Legpontosabb lövész: <b>${esc(s.name)}</b> – ${s.accuracy}%`);
      if (awards.innerHTML) table.appendChild(awards);
    }
    // a főgonosz legyőzője (egyedül játszva is)
    const slayers = standings.filter((s) => (s.bosses ?? 0) > 0);
    if (slayers.length) {
      const box = document.createElement('div');
      box.className = 'awards';
      box.innerHTML = slayers.map((s) => `<div>A ${BOSS.name} legyőzője: <b>${esc(s.name)}</b>${(s.bosses ?? 0) > 1 ? ` – ${s.bosses}×` : ''}</div>`).join('');
      table.appendChild(box);
    }
    this.show('results');
  }
}
