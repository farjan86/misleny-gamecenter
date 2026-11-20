// Védelem a véletlen kilépés ellen: meccs közben a böngésző megerősítést kér,
// mielőtt bezárná vagy újratöltené a lapot. Erre azért van szükség, mert a
// játék a Ctrl billentyűt is használja, és a böngésző néhány gyorsbillentyűjét
// (Ctrl+W: lap bezárása, Ctrl+T, Ctrl+N) az oldal nem tudja letiltani – ha
// valaki előre megy (W) és közben Ctrl-t nyom, a lap bezárulna.

let active = false;

window.addEventListener('beforeunload', (ev) => {
  if (!active) return;
  ev.preventDefault();
  // a régebbi böngészők ebből tudják, hogy kérdezniük kell
  ev.returnValue = '';
});

/** A védelem be- és kikapcsolása (meccs közben be; a játék saját újratöltése előtt ki). */
export function guardLeave(on: boolean): void {
  active = on;
}
