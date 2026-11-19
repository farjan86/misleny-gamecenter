// Teljes képernyős mód: az F billentyű vagy a HUD gombja kapcsolja.
// Az egész oldal vált teljes képernyőre (nem csak a játékvászon), így a HUD is
// látható marad; a játék képe az új mérethez igazodik.

const LABEL_ENTER = '⛶ Teljes képernyő (F)';
const LABEL_EXIT = '⛶ Kilépés a teljes képernyőből (F)';

export function isFullscreen(): boolean {
  return document.fullscreenElement !== null;
}

export function toggleFullscreen(): void {
  if (isFullscreen()) {
    void document.exitFullscreen();
    return;
  }
  // a böngésző csak felhasználói műveletből (billentyű, kattintás) engedi
  document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch((err: unknown) => {
    console.warn('A teljes képernyős mód nem kapcsolható be:', err);
  });
}

export function setupFullscreen(): void {
  const button = document.getElementById('hud-fullscreen');
  if (!document.fullscreenEnabled) {
    // pl. beágyazott keretben vagy régi böngészőben nem érhető el
    button?.remove();
    return;
  }

  button?.addEventListener('click', toggleFullscreen);
  // Közvetlenül a böngésző eseményére iratkozunk fel (nem a játék
  // billentyűkezelőjére), hogy a kérés biztosan felhasználói műveletnek számítson.
  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'KeyF' || ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    ev.preventDefault();
    toggleFullscreen();
  });
  document.addEventListener('fullscreenchange', () => {
    if (button) button.textContent = isFullscreen() ? LABEL_EXIT : LABEL_ENTER;
  });
  if (button) button.textContent = LABEL_ENTER;
}
