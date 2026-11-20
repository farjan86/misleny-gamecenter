// Részletesség (pixel/méter) és látómező. A látómező 16:9-es képernyőn
// 160 × 90 méter; szélesebb képernyőn oldalra, magasabb ablakban függőlegesen
// több látszik (így a kép mindig kitölti az ablakot). A részletesség csak azt
// szabja meg, hány pixelből áll a kép – és ezzel azt, mennyi munkája van a
// processzornak és a videokártyának.

/** A sprite-ok ehhez a részletességhez készültek; más értéknél arányosan méreteződnek. */
export const BASE_PPM = 12;
export const VIEW_METERS = { width: 160, height: 90 };
/** A legkeskenyebb és a legszélesebb képarány, amelyhez a látómező még igazodik (1:1 … 32:9). */
export const VIEW_ASPECT = { min: 1, max: 32 / 9 };

/**
 * A látómező mérete méterben az ablak méretéhez: a 16:9-nél szélesebb ablakban a
 * magasság marad 90 m és a szélesség nő, a keskenyebben a szélesség marad 160 m.
 */
export function viewMeters(windowWidth: number, windowHeight: number): { width: number; height: number } {
  const raw = windowWidth > 0 && windowHeight > 0 ? windowWidth / windowHeight : VIEW_METERS.width / VIEW_METERS.height;
  const aspect = Math.max(VIEW_ASPECT.min, Math.min(VIEW_ASPECT.max, raw));
  if (aspect >= VIEW_METERS.width / VIEW_METERS.height) return { width: VIEW_METERS.height * aspect, height: VIEW_METERS.height };
  return { width: VIEW_METERS.width, height: VIEW_METERS.width / aspect };
}

/** A játékvászon mérete képpontban (páros számokra kerekítve). */
export function canvasSize(ppm: number, windowWidth: number, windowHeight: number): { width: number; height: number } {
  const view = viewMeters(windowWidth, windowHeight);
  return { width: Math.round((view.width * ppm) / 2) * 2, height: Math.round((view.height * ppm) / 2) * 2 };
}

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
