// A játék beállításai: a játékos neve, a billentyűkiosztás és az utoljára
// használt szobabeállítások. Minden a böngészőben őrződik meg.

import type { MatchSettings } from './sim/match';

const STORAGE_KEY = 'tank-misleny.settings.v2';

/** A billentyűvel kiváltható műveletek. */
export const ACTIONS = ['forward', 'back', 'left', 'right', 'fire', 'boost', 'oil', 'deploy', 'mine', 'smoke', 'strike', 'cloak', 'chat', 'talk', 'scores', 'map', 'fullscreen', 'info'] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABEL: Record<Action, string> = {
  forward: 'Előre',
  back: 'Tolatás',
  left: 'Fordulás balra',
  right: 'Fordulás jobbra',
  fire: 'Lövés',
  boost: 'Gyorsító',
  oil: 'Olajfolt lerakása',
  deploy: 'Ágyú telepítése',
  mine: 'Akna lerakása',
  smoke: 'Füst',
  strike: 'Tüzérségi csapás a célkeresztre',
  cloak: 'Álcázás',
  chat: 'Üzenet írása a többieknek',
  talk: 'Beszéd (amíg nyomva van)',
  scores: 'Eredménytábla (amíg nyomva van)',
  map: 'Nagy térkép',
  fullscreen: 'Teljes képernyő',
  info: 'Irányítás (súgó)',
};

/** Műveletenként legfeljebb két billentyű (KeyboardEvent.code). */
export type KeyBindings = Record<Action, string[]>;

export const DEFAULT_KEYS: KeyBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  fire: ['Space'],
  boost: ['ShiftLeft', 'ShiftRight'],
  oil: ['KeyE'],
  deploy: ['KeyQ'],
  mine: ['KeyR'],
  smoke: ['KeyC'],
  strike: ['KeyX'],
  cloak: ['ControlLeft', 'KeyV'],
  chat: ['Enter'],
  talk: ['KeyT'],
  scores: ['Tab'],
  map: ['KeyM'],
  fullscreen: ['KeyF'],
  info: ['KeyH'],
};

export const DEFAULT_VOLUME = 80;

export interface Settings {
  /** az utoljára használt játékosnév (a belépési űrlap ezzel töltődik ki) */
  name: string;
  /** a belépve maradás kulcsa (a szervertől kapjuk); üres, ha nincs belépve */
  token: string;
  keys: KeyBindings;
  /** a hangerő százalékban (0: néma) */
  volume: number;
  /** a választott alaptank (0, 1, 2 – csak megjelenés) */
  look: number;
  /** az utoljára létrehozott játék beállításai (a következő létrehozásnál ezek az alapértékek) */
  lastMatch: Partial<MatchSettings> | null;
}

const copyKeys = (keys: KeyBindings): KeyBindings => Object.fromEntries(ACTIONS.map((a) => [a, [...keys[a]]])) as KeyBindings;

function sanitize(raw: Partial<Settings> | null): Settings {
  const keys = copyKeys(DEFAULT_KEYS);
  const given = (raw?.keys ?? {}) as Partial<Record<Action, unknown>>;
  for (const action of ACTIONS) {
    const list = given[action];
    if (Array.isArray(list)) keys[action] = list.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length < 24).slice(0, 2);
  }
  const name = typeof raw?.name === 'string' ? raw.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18) : '';
  const token = typeof raw?.token === 'string' && raw.token.length < 200 ? raw.token : '';
  const volume = typeof raw?.volume === 'number' && Number.isFinite(raw.volume) ? Math.max(0, Math.min(100, Math.round(raw.volume))) : DEFAULT_VOLUME;
  const look = typeof raw?.look === 'number' && Number.isInteger(raw.look) && raw.look >= 0 && raw.look < 3 ? raw.look : 0;
  return { name, token, keys, volume, look, lastMatch: raw?.lastMatch && typeof raw.lastMatch === 'object' ? raw.lastMatch : null };
}

export function loadSettings(): Settings {
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    return sanitize(text ? (JSON.parse(text) as Partial<Settings>) : null);
  } catch {
    return sanitize(null); // letiltott tárhely vagy sérült adat
  }
}

export function saveSettings(settings: Settings): Settings {
  const clean = sanitize(settings);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    /* ha nem menthető, a beállítás csak erre az alkalomra érvényes */
  }
  return clean;
}

export function defaultKeys(): KeyBindings {
  return copyKeys(DEFAULT_KEYS);
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Szóköz',
  ShiftLeft: 'Bal Shift',
  ShiftRight: 'Jobb Shift',
  ControlLeft: 'Bal Ctrl',
  ControlRight: 'Jobb Ctrl',
  AltLeft: 'Bal Alt',
  AltRight: 'Jobb Alt (AltGr)',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  CapsLock: 'Caps Lock',
  Comma: ',',
  Period: '.',
  Minus: '-',
  Equal: '=',
  Backquote: '0 / `',
  IntlBackslash: 'Í',
};

/** A billentyű kiírható neve (a fizikai helye szerint, amerikai kiosztás betűivel). */
export function keyName(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/** A művelet billentyűi kiírva, pl. „W / ↑”. */
export function keysText(keys: KeyBindings, action: Action): string {
  return keys[action].length ? keys[action].map(keyName).join(' / ') : '–';
}
