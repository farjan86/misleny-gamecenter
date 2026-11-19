// Egy tank megjelenítése: a szimuláció állapotát (méter) képernyőre (világpixel) teszi.

import Phaser from 'phaser';
import { BASE_PPM } from '../quality';
import { angleDiff, type TankState } from '../sim/world';
import { TEX, TURRET_PIVOT, TURRET_SIZE } from './textures';

interface Snapshot {
  x: number;
  y: number;
  hull: number;
  turret: number;
}

export class TankView {
  private readonly shadow: Phaser.GameObjects.Image;
  private readonly hull: Phaser.GameObjects.Image;
  private readonly turret: Phaser.GameObjects.Image;
  /** a lombréteg fölött látszó jelölő, ha a tank fa alatt áll */
  private readonly marker: Phaser.GameObjects.Image;
  private readonly prev: Snapshot;
  private readonly shadowOffset: number;
  private frame = -1;
  /** az utolsó kirajzolt (interpolált) hely világpixelben */
  px = 0;
  py = 0;

  constructor(
    scene: Phaser.Scene,
    private readonly ppm: number,
    tank: TankState,
  ) {
    const scale = ppm / BASE_PPM;
    this.shadowOffset = 6 * scale;
    this.shadow = scene.add.image(0, 0, TEX.shadow).setAlpha(0.3).setDepth(9).setScale(scale);
    this.hull = scene.add.image(0, 0, TEX.hull[0]).setDepth(10).setScale(scale);
    this.turret = scene.add
      .image(0, 0, TEX.turret)
      .setOrigin(TURRET_PIVOT.x / TURRET_SIZE.w, TURRET_PIVOT.y / TURRET_SIZE.h)
      .setDepth(11)
      .setScale(scale);
    this.marker = scene.add.image(0, 0, TEX.marker).setDepth(16).setAlpha(0).setScale(scale);
    this.prev = { x: tank.x, y: tank.y, hull: tank.hullAngle, turret: tank.turretAngle };
    this.render(tank, 1);
  }

  /** Szimulációs lépés előtt hívandó, hogy a két állapot közt interpolálni lehessen. */
  remember(tank: TankState): void {
    const p = this.prev;
    p.x = tank.x;
    p.y = tank.y;
    p.hull = tank.hullAngle;
    p.turret = tank.turretAngle;
  }

  /** alpha: 0 = előző lépés állapota, 1 = a legfrissebb */
  render(tank: TankState, alpha: number): void {
    const p = this.prev;
    const x = (p.x + (tank.x - p.x) * alpha) * this.ppm;
    const y = (p.y + (tank.y - p.y) * alpha) * this.ppm;
    const hull = p.hull + angleDiff(tank.hullAngle, p.hull) * alpha;
    const turret = p.turret + angleDiff(tank.turretAngle, p.turret) * alpha;
    this.px = x;
    this.py = y;
    this.shadow.setPosition(x + this.shadowOffset, y + this.shadowOffset).setRotation(hull);
    this.hull.setPosition(x, y).setRotation(hull);
    // lánctalp-animáció a megtett út szerint (tolatásnál visszafelé); textúrát csak váltáskor cserélünk
    const frames = TEX.hull.length;
    const frame = ((Math.floor(tank.odometer * 4) % frames) + frames) % frames;
    if (frame !== this.frame) {
      this.frame = frame;
      this.hull.setTexture(TEX.hull[frame]);
    }
    this.turret.setPosition(x, y).setRotation(turret);
    this.marker.setPosition(x, y).setRotation(hull);
  }

  /** A jelölő finoman jelenik meg és tűnik el. */
  setCovered(covered: boolean): void {
    const target = covered ? 0.9 : 0;
    const alpha = this.marker.alpha;
    if (Math.abs(target - alpha) < 0.01) {
      if (alpha !== target) this.marker.setAlpha(target);
      return;
    }
    this.marker.setAlpha(alpha + (target - alpha) * 0.15);
  }

  destroy(): void {
    this.shadow.destroy();
    this.hull.destroy();
    this.turret.destroy();
    this.marker.destroy();
  }
}
