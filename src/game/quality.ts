// Részletesség (pixel/méter) megválasztása. A látómező mindig 160 × 90 méter;
// a részletesség csak azt szabja meg, hány pixelből áll a kép – és ezzel azt,
// mennyi munkája van a processzornak és a videokártyának.

/** A sprite-ok ehhez a részletességhez készültek; más értéknél arányosan méreteződnek. */
export const BASE_PPM = 12;
export const VIEW_METERS = { width: 160, height: 90 };

/** A Q billentyűvel körbejárható fokozatok. */
export const QUALITY_STEPS = [12, 10, 8] as const;
const MIN_PPM = 6;
const PARAM = 'ppm';

/**
 * Alapértelmezés: annyi pixel, amennyit a kijelző teljes képernyőn meg tud
 * mutatni (ennél többet fölösleges kiszámolni), legfeljebb Full HD.
 * Az URL `?ppm=8` paraméterével felülbírálható.
 */
export function pickPpm(): { ppm: number; auto: boolean } {
  const param = Number(new URLSearchParams(window.location.search).get(PARAM));
  if (Number.isFinite(param) && param >= MIN_PPM && param <= BASE_PPM) return { ppm: Math.round(param), auto: false };

  const dpr = window.devicePixelRatio || 1;
  const fit = Math.min((window.screen.width * dpr) / VIEW_METERS.width, (window.screen.height * dpr) / VIEW_METERS.height);
  const ppm = Math.max(QUALITY_STEPS[QUALITY_STEPS.length - 1], Math.min(BASE_PPM, Math.ceil(fit)));
  return { ppm, auto: true };
}

/** Váltás a következő (alacsonyabb, majd újra a legmagasabb) fokozatra: az oldal újratöltődik. */
export function cycleQuality(current: number): void {
  const lower = QUALITY_STEPS.find((step) => step < current);
  const next = lower ?? QUALITY_STEPS[0];
  const url = new URL(window.location.href);
  url.searchParams.set(PARAM, String(next));
  window.location.href = url.toString();
}
