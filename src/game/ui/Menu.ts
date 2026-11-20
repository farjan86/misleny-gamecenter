// A menük: főképernyő (belépés / regisztráció), beállítások (billentyűk), a
// játékok listája, új játék létrehozása, a váró és az eredménytábla. Sima DOM,
// a játékvászon fölött; a szerverrel a NetClient-en keresztül beszél.

import type { GameMap } from '../maps/GameMap';
import { renderMap } from '../maps/raster';
import type { NetClient, NetStatus } from '../net/NetClient';
import { cleanCode, ROOM_CODE, type RoomInfo, type ServerMessage, type Standing } from '../net/protocol';
import { ACTION_LABEL, ACTIONS, defaultKeys, keyName, saveSettings, type Settings } from '../settings';
import { areaOfCells, gridSize, MATCH, matchPlan, sanitizeSettings, WEATHERS, type MatchSettings } from '../sim/match';

type Screen = 'main' | 'settings' | 'lobby' | 'create' | 'room' | 'results';
const SCREENS: Screen[] = ['main', 'settings', 'lobby', 'create', 'room', 'results'];

const LEVEL_NAME = ['nincs', 'nagyon kevés', 'kevés', 'közepes', 'sok', 'nagyon sok'];
const SKILL_NAME = ['', 'kezdő', 'gyenge', 'közepes', 'ügyes', 'mesterlövész'];
const AGGRESSION_NAME = ['', 'békés', 'óvatos', 'közepes', 'harcias', 'vadászik rád'];
const WEATHER_NAME = { day: 'Nappal', rain: 'Eső', night: 'Este' } as const;
const STATUS_NAME = { waiting: 'Játékra vár', starting: 'Betelt – indul', playing: 'Betelt – játékban' } as const;
/** az oldal újratöltése után egyből ide térjen vissza a menü */
const RETURN_KEY = 'tank-misleny.return';

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
  return `${km2(size)} · ${WEATHER_NAME[s.weather].toLowerCase()} · ${s.minutes} perc · ${bots}`;
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
  /** az a privát szoba, amelyhez éppen a belépőkódot kérjük */
  private codeRoom: string | null = null;
  /** az „Új játék” képernyő egyjátékos módban van-e (szerver nélkül indul) */
  private single = false;
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
    this.bindMain();
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
  static reloadTo(screen: 'lobby' | 'main'): void {
    try {
      window.sessionStorage.setItem(RETURN_KEY, screen);
    } catch {
      /* nem baj, ha nem megy: a főképernyő nyílik meg */
    }
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
  }

  hide(): void {
    this.root.classList.add('hidden');
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
    el('settings-reset').onclick = () => {
      this.settings.keys = defaultKeys();
      this.save();
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
      this.show('create');
    };
    const input = el<HTMLInputElement>('code-input');
    const submit = (): void => {
      if (!this.codeRoom) return;
      if (cleanCode(input.value).length < ROOM_CODE.min) return this.error('Add meg a belépőkódot.');
      this.net.send({ t: 'join', room: this.codeRoom, code: input.value });
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
      const open = room.status === 'waiting' && room.players.length < room.settings.maxPlayers;
      const row = document.createElement('div');
      row.className = 'room';
      row.innerHTML =
        `<div><div class="name">${room.locked ? '<span class="lock" title="Privát játék – belépőkód kell">🔒</span> ' : ''}${esc(room.settings.name)}</div>` +
        `<div class="small">létrehozta: ${esc(room.host)}${room.locked ? ' · privát' : ''}</div></div>` +
        `<div>${room.players.length} / ${room.settings.maxPlayers} játékos</div>` +
        `<div class="small">${roomDetails(room)}</div>` +
        `<div class="state ${open ? 'waiting' : 'full'}">${STATUS_NAME[room.status]}</div>`;
      const join = document.createElement('span');
      join.className = open ? 'btn' : 'btn disabled';
      join.textContent = 'Belépés';
      join.onclick = () => {
        if (!open) return;
        if (room.locked) this.askCode(room);
        else this.net.send({ t: 'join', room: room.id });
      };
      row.appendChild(join);
      list.appendChild(row);
    }
  }

  // --- új játék ------------------------------------------------------------------

  private readonly sliders = ['players', 'minutes', 'bots', 'skill', 'aggression', 'pickups', 'traffic', 'weather'] as const;

  private bindCreate(): void {
    el('create-back').onclick = () => this.show(this.single ? 'main' : 'lobby');
    el('create-ok').onclick = () => {
      const settings = this.readCreate();
      // a létszám a többjátékos beállítás része: egyjátékos indítás nem írja felül
      this.settings.lastMatch = this.single ? { ...settings, maxPlayers: this.settings.lastMatch?.maxPlayers ?? 4 } : settings;
      this.save();
      if (this.single) return this.onSingle(settings, this.net.name || this.settings.name || 'Játékos');
      const code = el<HTMLInputElement>('create-code').value;
      if (code.trim() && cleanCode(code).length < ROOM_CODE.min) return this.error(`A belépőkód legalább ${ROOM_CODE.min} karakter legyen.`);
      this.net.send({ t: 'create', settings, ...(code.trim() ? { code } : {}) });
    };
    for (const name of this.sliders) el<HTMLInputElement>(`sl-${name}`).addEventListener('input', () => this.updateCreate());

    const canvas = el<HTMLCanvasElement>('area-map');
    const cellAt = (ev: MouseEvent): { c: number; r: number } => {
      const rect = canvas.getBoundingClientRect();
      return {
        c: Math.max(0, Math.min(this.grid.cols - 1, Math.floor(((ev.clientX - rect.left) / rect.width) * this.grid.cols))),
        r: Math.max(0, Math.min(this.grid.rows - 1, Math.floor(((ev.clientY - rect.top) / rect.height) * this.grid.rows))),
      };
    };
    canvas.addEventListener('mousedown', (ev) => {
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
      el<HTMLInputElement>('sl-players').value = String(last.maxPlayers);
      el<HTMLInputElement>('sl-minutes').value = String(last.minutes);
      el<HTMLInputElement>('sl-bots').value = String(last.bots);
      el<HTMLInputElement>('sl-skill').value = String(last.botSkill);
      el<HTMLInputElement>('sl-aggression').value = String(last.botAggression);
      el<HTMLInputElement>('sl-pickups').value = String(last.pickups);
      el<HTMLInputElement>('sl-traffic').value = String(last.traffic);
      el<HTMLInputElement>('sl-weather').value = String(WEATHERS.indexOf(last.weather));
    }
    el<HTMLInputElement>('create-name').value = `${this.net.name} játéka`;
    // egyjátékos módban nincs szoba: nem kell név és létszám, és azonnal indul
    el('create-title').textContent = this.single ? 'Egyjátékos játék' : 'Új játék';
    el('create-name-field').classList.toggle('hidden', this.single);
    el('create-players-field').classList.toggle('hidden', this.single);
    el('create-code-field').classList.toggle('hidden', this.single);
    el('create-ok').textContent = this.single ? 'Indítás' : 'Létrehozás';
    this.updateCreate();
  }

  private readCreate(): MatchSettings {
    const value = (name: string): number => Number(el<HTMLInputElement>(`sl-${name}`).value);
    const s = this.selection();
    return sanitizeSettings(
      {
        name: el<HTMLInputElement>('create-name').value,
        area: areaOfCells(this.map.width, this.map.height, s.c0, s.r0, s.c1, s.r1),
        maxPlayers: this.single ? 1 : value('players'),
        minutes: value('minutes'),
        bots: value('bots'),
        botSkill: value('skill'),
        botAggression: value('aggression'),
        pickups: value('pickups'),
        traffic: value('traffic'),
        weather: WEATHERS[value('weather')] ?? 'day',
      },
      this.map.width,
      this.map.height,
    );
  }

  /** A csúszkák feliratai és a térkép a kijelöléssel; a tényleges létszámokat a pálya mérete adja. */
  private updateCreate(): void {
    const settings = this.readCreate();
    const plan = matchPlan(settings);
    el('val-players').textContent = `${settings.maxPlayers} fő`;
    el('val-minutes').textContent = `${settings.minutes} perc`;
    el('val-bots').textContent = settings.bots ? `${LEVEL_NAME[settings.bots]} – kb. ${plan.bots} bot` : 'nincs';
    el('val-skill').textContent = settings.bots ? SKILL_NAME[settings.botSkill] : '–';
    el('val-aggression').textContent = settings.bots ? AGGRESSION_NAME[settings.botAggression] : '–';
    el('val-pickups').textContent = settings.pickups ? `${LEVEL_NAME[settings.pickups]} – kb. ${plan.pickups} db` : 'nincs';
    el('val-traffic').textContent = settings.traffic ? `${LEVEL_NAME[settings.traffic]} – kb. ${plan.traffic} jármű` : 'nincs';
    el('val-weather').textContent = WEATHER_NAME[settings.weather];
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

  // --- eredmény ------------------------------------------------------------------

  showResults(winner: string | null, standings: Standing[], myId: string): void {
    const me = standings.find((s) => s.id === myId);
    const first = standings.find((s) => s.id === winner);
    // egyedül játszva nincs győztes: az eredmény a kilövések száma
    const solo = standings.length === 1;
    el('results-title').textContent = solo
      ? `Lejárt az idő – ${me?.kills ?? 0} kilövés`
      : winner === myId
        ? 'Győztél!'
        : first
          ? `Vége – nyert: ${first.name}`
          : 'Lejárt az idő – döntetlen';
    const table = el('results-table');
    table.replaceChildren();
    for (const s of standings) {
      const row = document.createElement('div');
      row.className = s === me ? 'player-row me' : 'player-row';
      row.innerHTML = `<span>${s.place}. ${esc(s.name)}</span><span>${s.kills} kilövés · ${s.deaths} halál · ${s.level}. szint</span>`;
      table.appendChild(row);
    }
    this.show('results');
  }
}
