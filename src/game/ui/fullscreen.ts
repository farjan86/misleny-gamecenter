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
  document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch((err: unknown) => {
    console.warn('A teljes képernyős mód nem kapcsolható be:', err);
  });
}
