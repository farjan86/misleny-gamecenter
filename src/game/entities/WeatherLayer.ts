// Időjárás a képernyőn: eső (szürkés fátyol és hulló esőcseppek) és este
// (sötétség, amelyet a közvilágítás, a tankok fényszórója, a tüzek és a
// torkolattüzek világítanak meg). Csak megjelenítés – a talaj csúszóssága a
// szimulációban van.

import Phaser from 'phaser';
import type { GameMap } from '../maps/GameMap';
import type { TankState, Weather } from '../sim/world';
import type { FireLayer } from './FireLayer';
import { GTEX } from './gameTextures';

/** A sötétség színe és erőssége: az este nem teljesen sötét, a pálya kivehető marad. */
const NIGHT = { color: 0x070b1e, alpha: 0.74 };
/** A sötétség-réteg ennyied felbontással készül (olcsóbb, a fények széle úgyis lágy). */
const DARK_SCALE = 2;
const LIGHT_TEX = 128;
/** fénykörök sugara méterben */
const LAMP_RADIUS = 13;
const TANK_RADIUS = 6.5;
const BEAM_RADIUS = 11;
const BEAM_AHEAD = 9;

interface Flash {
  x: number;
  y: number;
  radius: number;
  left: number;
  life: number;
}

export class WeatherLayer {
  private readonly dark: Phaser.GameObjects.RenderTexture | null = null;
  private readonly stamp: Phaser.GameObjects.Image | null = null;
  private readonly rain: Phaser.GameObjects.TileSprite | null = null;
  private readonly flashes: Flash[] = [];
  private readonly glows: Phaser.GameObjects.Image[] = [];
  private lastScrollX = 0;
  private lastScrollY = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly map: GameMap,
    private readonly ppm: number,
    readonly weather: Weather,
  ) {
    const cam = scene.cameras.main;
    if (weather === 'night') {
      this.dark = scene.add
        .renderTexture(0, 0, Math.ceil(cam.width / DARK_SCALE), Math.ceil(cam.height / DARK_SCALE))
        .setOrigin(0)
        .setScale(DARK_SCALE)
        .setScrollFactor(0)
        .setDepth(28);
      this.stamp = scene.make.image({ key: GTEX.light }, false);
    } else if (weather === 'rain') {
      scene.add.rectangle(0, 0, cam.width, cam.height, 0x3c4a60, 0.22).setOrigin(0).setScrollFactor(0).setDepth(28);
      this.rain = scene.add.tileSprite(0, 0, cam.width, cam.height, GTEX.rain).setOrigin(0).setScrollFactor(0).setDepth(29).setAlpha(0.55);
    }
  }

  /** Rövid felvillanás (torkolattűz, robbanás): este megvilágítja a környékét. */
  flash(x: number, y: number, radius: number, seconds: number): void {
    if (!this.dark) return;
    if (this.flashes.length > 40) this.flashes.shift();
    this.flashes.push({ x, y, radius, left: seconds, life: seconds });
  }

  update(view: Phaser.Geom.Rectangle, tanks: readonly TankState[], fires: FireLayer, dt: number): void {
    if (this.rain) {
      // az eső ferdén esik; a kamera mozgását is követi, így a cseppek a világhoz képest hullanak
      this.rain.tilePositionX += view.x - this.lastScrollX - 260 * dt;
      this.rain.tilePositionY += view.y - this.lastScrollY - 1150 * dt;
      this.lastScrollX = view.x;
      this.lastScrollY = view.y;
      return;
    }
    const dark = this.dark;
    const stamp = this.stamp;
    if (!dark || !stamp) return;
    const { ppm } = this;
    const k = 1 / DARK_SCALE;
    dark.clear();
    dark.fill(NIGHT.color, NIGHT.alpha);
    const light = (wx: number, wy: number, radius: number, strength = 1): void => {
      const x = (wx * ppm - view.x) * k;
      const y = (wy * ppm - view.y) * k;
      const r = radius * ppm * k;
      if (x < -r || y < -r || x > dark.width + r || y > dark.height + r) return;
      // a fény helyén a sötétség „kiradírozódik” (a korong széle felé egyre kevésbé)
      stamp.setScale((r * 2) / LIGHT_TEX).setAlpha(strength);
      dark.erase(stamp, x, y);
    };

    // közvilágítás: az álló villanyoszlopok és a fotók alapján felvett lámpák
    const minX = view.x / ppm - LAMP_RADIUS;
    const minY = view.y / ppm - LAMP_RADIUS;
    const maxX = view.right / ppm + LAMP_RADIUS;
    const maxY = view.bottom / ppm + LAMP_RADIUS;
    const poles = this.map.data.decor.poles;
    const fallen = this.map.fellables.fallen;
    let glow = 0;
    const lamp = (x: number, y: number): void => {
      if (x < minX || x > maxX || y < minY || y > maxY) return;
      light(x, y, LAMP_RADIUS, 0.92);
      // meleg, sárgás fényfolt a lámpa alatt
      const image = this.glows[glow] ?? (this.glows[glow] = this.scene.add.image(0, 0, GTEX.glow).setDepth(13.5).setBlendMode(Phaser.BlendModes.ADD).setTint(0xffd9a0));
      glow++;
      image
        .setVisible(true)
        .setPosition(x * ppm, y * ppm)
        .setScale((LAMP_RADIUS * 1.25 * ppm) / 64)
        .setAlpha(0.2);
    };
    for (const n of this.map.poleIndex.query(minX, minY, maxX, maxY)) {
      if (!fallen[this.map.poleOffset + n]) lamp(poles[n * 2], poles[n * 2 + 1]);
    }
    for (const l of this.map.data.landmarks?.lamps ?? []) lamp(l[0], l[1]);
    for (let i = glow; i < this.glows.length; i++) this.glows[i].setVisible(false);

    // a tankok fényszórója: fény a tank körül és előtte
    for (const tank of tanks) {
      if (!tank.alive) continue;
      light(tank.x, tank.y, TANK_RADIUS, 0.85);
      light(tank.x + Math.cos(tank.hullAngle) * BEAM_AHEAD, tank.y + Math.sin(tank.hullAngle) * BEAM_AHEAD, BEAM_RADIUS, 0.9);
    }
    fires.forEach((x, y, size) => light(x, y, size * 4.5 + 3, 0.95));
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.left -= dt;
      if (f.left <= 0) {
        this.flashes.splice(i, 1);
        continue;
      }
      light(f.x, f.y, f.radius, f.left / f.life);
    }
  }
}
