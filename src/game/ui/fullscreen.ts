// Teljes képernyős mód: az egész oldal vált teljes képernyőre (nem csak a
// játékvászon), így a felület is látható marad; a játék képe az új mérethez igazodik.

export function isFullscreen(): boolean {
  return document.fullscreenElement !== null;
}

/** Csak felhasználói műveletből (billentyű, kattintás) hívható – a böngésző másként nem engedi. */
export function toggleFullscreen(): void {
  if (!document.fullscreenEnabled) return;
  if (isFullscreen()) {
    void document.exitFullscreen();
    return;
  }
  document.documentElement
    .requestFullscreen({ navigationUI: 'hide' })
    .then(() => {
      // teljes képernyőn a böngésző átengedi a játéknak a gyorsbillentyűit is (pl. Ctrl+W nem zárja be a lapot);
      // nem minden böngésző tudja, és a teljes képernyő elhagyásakor magától megszűnik
      const keyboard = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard;
      keyboard?.lock?.().catch(() => undefined);
    })
    .catch((err: unknown) => {
      console.warn('A teljes képernyős mód nem kapcsolható be:', err);
    });
}
