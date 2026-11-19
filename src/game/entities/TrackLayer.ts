// Lánctalpnyomok és a tankok által felvert por (esőben sár). A nyomok a
// burkolatlan talajon maradnak meg egy ideig, aztán elhalványulnak. Csak
// megjelenítés; a nyomok képei egy rögzített méretű készletből kerülnek ki,
// így a számuk (és a rájuk fordított idő) korlátos.

import Phaser from 'phaser';
import type { GameMap } from '../maps/GameMap';
import { tankSize, type TankState, type Weather } from '../sim/world';
import { GTEX } from './gameTextures';

/** Ennyi nyomdarab lehet egyszerre a pályán; fölötte a legrégebbi hasznosul újra. */
const MAX_DECALS = 900;
/** Egy nyomdarab hossza méterben (a textúra ekkora útszakaszt ábrázol). */
const STEP = 2;
/** Eddig látszik egy nyom (mp); az utolsó másodpercekben halványul el. */
const LIFE = 45;
const FADE = 10;
const DEPTH = 1;

interface Decal {
  image: Phaser.GameObjects.Image;
  born: number;
  alpha: number;
}

export class TrackLayer {
  private readonly decals: Decal[] = [];
  private next = 0;
  private cursor = 0;
  /** tankonként az utolsó nyomdarab vége */
  private readonly last = new Map<number, { x: number; y: number; seen: number }>();
  private frame = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly map: GameMap,
    private readonly ppm: number,
    private readonly weather: Weather,
  ) {}

  /** `now`: másodperc; `view`: a látómező világpixelben. */
  update(tanks: readonly TankState[], view: Phaser.Geom.Rectangle, now: number): void {
    this.frame++;
    const { ppm } = this;
    const margin = 8 * ppm;
    for (const tank of tanks) {
      if (!tank.alive) {
        this.last.delete(tank.id);
        continue;
      }
      const px = tank.x * ppm;
      const py = tank.y * ppm;
      if (px < view.x - margin || px > view.right + margin || py < view.y - margin || py > view.bottom + margin) {
        this.last.delete(tank.id);
        continue;
      }
      const prev = this.last.get(tank.id);
      if (!prev) {
        this.last.set(tank.id, { x: tank.x, y: tank.y, seen: this.frame });
        continue;
      }
      prev.seen = this.frame;
      const dx = tank.x - prev.x;
      const dy = tank.y - prev.y;
      const dist = Math.hypot(dx, dy);
      if (dist < STEP) continue;
      // nagy ugrás (újraéledés) után nem húzunk nyomot a két hely közé
      if (dist < STEP * 4) this.place((prev.x + tank.x) / 2, (prev.y + tank.y) / 2, Math.atan2(dy, dx), dist, tankSize(tank), now);
      prev.x = tank.x;
      prev.y = tank.y;
    }
    // a látómezőből kikerült vagy eltűnt tankok bejegyzései időnként törlődnek
    if (this.frame % 120 === 0) {
      for (const [id, entry] of this.last) if (entry.seen < this.frame - 60) this.last.delete(id);
    }
    // a nyomok halványítása: képkockánként csak a készlet egy részét nézzük át
    const count = Math.min(this.decals.length, 60);
    for (let i = 0; i < count; i++) {
      this.cursor = (this.cursor + 1) % this.decals.length;
      const decal = this.decals[this.cursor];
      if (!decal.image.visible) continue;
      const left = LIFE - (now - decal.born);
      if (left <= 0) decal.image.setVisible(false);
      else if (left < FADE) decal.image.setAlpha(decal.alpha * (left / FADE));
    }
  }

  private place(x: number, y: number, angle: number, length: number, size: number, now: number): void {
    // burkolt úton a lánctalp nem hagy nyomot
    if (this.map.speedFactor(x, y) >= 1) return;
    let decal = this.decals[this.next];
    if (!decal) {
      decal = { image: this.scene.add.image(0, 0, GTEX.track).setDepth(DEPTH), born: 0, alpha: 0 };
      this.decals.push(decal);
    }
    this.next = (this.next + 1) % MAX_DECALS;
    const rain = this.weather === 'rain';
    decal.born = now;
    decal.alpha = rain ? 0.62 : 0.4;
    decal.image
      .setPosition(x * this.ppm, y * this.ppm)
      .setRotation(angle)
      // a textúra STEP méternyi nyomot ábrázol 12 pixel/méteren; a szélessége a tank méretével nő
      .setScale(((length / STEP) * this.ppm) / 12, (size * this.ppm) / 12)
      .setTint(rain ? 0x4a3a28 : 0x3e4a26)
      .setAlpha(decal.alpha)
      .setVisible(true);
  }

  get count(): number {
    let n = 0;
    for (const decal of this.decals) if (decal.image.visible) n++;
    return n;
  }
}
