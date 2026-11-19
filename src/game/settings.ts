// A játék beállításai. Egyelőre egyetlen érték van (az ellenséges botok száma),
// de minden beállítás itt, egy helyen él és a böngészőben megőrződik – a későbbi
// menürendszer ugyanezt a modult használhatja.

const STORAGE_KEY = 'tank-misleny.settings.v1';

export interface Settings {
  /** gép vezérelte ellenséges tankok száma */
  bots: number;
}

export const BOT_LIMITS = { min: 0, max: 12, initial: 3 } as const;

const DEFAULTS: Settings = { bots: BOT_LIMITS.initial };

function sanitize(raw: Partial<Settings>): Settings {
  const bots = Number.isFinite(raw.bots) ? Math.round(raw.bots as number) : DEFAULTS.bots;
  return { bots: Math.max(BOT_LIMITS.min, Math.min(BOT_LIMITS.max, bots)) };
}

export function loadSettings(): Settings {
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    return sanitize(text ? (JSON.parse(text) as Partial<Settings>) : {});
  } catch {
    return { ...DEFAULTS }; // letiltott tárhely vagy sérült adat
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
