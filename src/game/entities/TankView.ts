// Egy tank megjelenítése: a szimuláció állapotát (méter) képernyőre (világpixel) teszi.
// A saját tank zöld, az ellenség vörös; fölötte életerősáv, körülötte a pajzs és a
// sebezhetetlenség gyűrűje.

import Phaser from 'phaser';
import { BASE_PPM } from '../quality';
import { angleDiff, tankMaxHp, tankSize, type TankState } from '../sim/world';
import { GTEX } from './gameTextures';
import { TEX, TURRET_PIVOT, TURRET_SIZE } from './textures';

interface Snapshot {
  x: number;
  y: number;
  hull: number;
  turret: number;
}

const BAR = { width: 46, height: 5, above: 34 };

export class TankView {
  private readonly shadow: Phaser.GameObjects.Image;
  private readonly hull: Phaser.GameObjects.Image;
  private readonly turret: Phaser.GameObjects.Image;
  /** a lombréteg fölött látszó jelölő, ha a (saját) tank fa alatt áll */
  private readonly marker: Phaser.GameObjects.Image | null;
  private readonly ring: Phaser.GameObjects.Image;
  private readonly barBack: Phaser.GameObjects.Image;
  private readonly barFill: Phaser.GameObjects.Image;
  private readonly hullFrames: readonly string[];
  private readonly prev: Snapshot;
  private readonly scale: number;
  private frame = -1;
  private level = 0;
  private shown = true;
  /** az utolsó kirajzolt (interpolált) hely világpixelben */
  px = 0;
  py = 0;

  constructor(
    scene: Phaser.Scene,
    private readonly ppm: number,
    tank: TankState,
    private readonly enemy: boolean,
  ) {
    const scale = ppm / BASE_PPM;
    this.scale = scale;
    this.hullFrames = enemy ? GTEX.enemyHull : TEX.hull;
    this.shadow = scene.add.image(0, 0, TEX.shadow).setAlpha(0.3).setDepth(9).setScale(scale);
    this.hull = scene.add.image(0, 0, this.hullFrames[0]).setDepth(10).setScale(scale);
    this.turret = scene.add
      .image(0, 0, enemy ? GTEX.enemyTurret : TEX.turret)
      .setOrigin(TURRET_PIVOT.x / TURRET_SIZE.w, TURRET_PIVOT.y / TURRET_SIZE.h)
      .setDepth(11)
      .setScale(scale);
    this.ring = scene.add.image(0, 0, GTEX.ring).setDepth(12).setScale(scale).setVisible(false);
    this.marker = enemy ? null : scene.add.image(0, 0, TEX.marker).setDepth(16).setAlpha(0).setScale(scale);
    // életerősáv (a lombréteg fölött, hogy fa alatt is látsszon)
    this.barBack = scene.add.image(0, 0, GTEX.px).setDepth(17).setTint(0x101418).setAlpha(0.85);
    this.barFill = scene.add.image(0, 0, GTEX.px).setDepth(18).setOrigin(0, 0.5);
    this.barBack.setDisplaySize((BAR.width + 2) * scale, (BAR.height + 2) * scale);
    this.prev = { x: tank.x, y: tank.y, hull: tank.hullAngle, turret: tank.turretAngle };
    this.render(tank, 1, 0);
  }

  /** Szimulációs lépés előtt hívandó, hogy a két állapot közt interpolálni lehessen. */
  remember(tank: TankState): void {
    const p = this.prev;
    p.x = tank.x;
    p.y = tank.y;
    p.hull = tank.hullAngle;
    p.turret = tank.turretAngle;
  }

  /** Ugrás (újraéledés, áthelyezés) után: ne interpoláljon a régi helyről. */
  snap(tank: TankState): void {
    this.remember(tank);
  }

  private show(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    for (const part of [this.shadow, this.hull, this.turret, this.barBack, this.barFill]) part.setVisible(visible);
    if (!visible) {
      this.ring.setVisible(false);
      this.marker?.setAlpha(0);
    }
  }

  /** alpha: 0 = előző lépés állapota, 1 = a legfrissebb; time: másodperc a villogó hatásokhoz */
  render(tank: TankState, alpha: number, time: number): void {
    this.show(tank.alive);
    if (!tank.alive) return;
    const p = this.prev;
    const x = (p.x + (tank.x - p.x) * alpha) * this.ppm;
    const y = (p.y + (tank.y - p.y) * alpha) * this.ppm;
    const hull = p.hull + angleDiff(tank.hullAngle, p.hull) * alpha;
    const turret = p.turret + angleDiff(tank.turretAngle, p.turret) * alpha;
    this.px = x;
    this.py = y;
    // szintlépéskor a tank megnő
    const size = this.scale * tankSize(tank);
    if (tank.level !== this.level) {
      this.level = tank.level;
      this.shadow.setScale(size);
      this.hull.setScale(size);
      this.turret.setScale(size);
    }
    const off = 6 * size;
    this.shadow.setPosition(x + off, y + off).setRotation(hull);
    this.hull.setPosition(x, y).setRotation(hull);
    // lánctalp-animáció a megtett út szerint (tolatásnál visszafelé); textúrát csak váltáskor cserélünk
    const frames = this.hullFrames.length;
    const frame = ((Math.floor(tank.odometer * 4) % frames) + frames) % frames;
    if (frame !== this.frame) {
      this.frame = frame;
      this.hull.setTexture(this.hullFrames[frame]);
    }
    this.turret.setPosition(x, y).setRotation(turret);
    this.marker?.setPosition(x, y).setRotation(hull);

    // gyűrű: arany villogás sebezhetetlenségnél, kék a pajzstöltetek szerint
    const invulnerable = tank.effects.invulnerable > 0;
    if (invulnerable || tank.shield > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 9);
      this.ring
        .setVisible(true)
        .setPosition(x, y)
        .setTint(invulnerable ? 0xffd84a : 0x5ab4ff)
        .setAlpha(invulnerable ? 0.55 + 0.4 * pulse : 0.4 + 0.18 * tank.shield)
        .setScale(size * (invulnerable ? 1.02 + 0.06 * pulse : 0.96));
    } else if (this.ring.visible) {
      this.ring.setVisible(false);
    }

    // életerősáv
    const ratio = Math.max(0, tank.hp / tankMaxHp(tank));
    const top = y - BAR.above * size;
    this.barBack.setPosition(x, top);
    this.barFill
      .setPosition(x - (BAR.width / 2) * this.scale, top)
      .setDisplaySize(Math.max(1, BAR.width * ratio * this.scale), BAR.height * this.scale)
      .setTint(this.enemy ? 0xe0483a : ratio > 0.5 ? 0x5ad24a : ratio > 0.25 ? 0xe8c23a : 0xe0483a);
  }

  /** A látómezőn kívüli tank elrejtése (a helyét ilyenkor nem kell frissíteni). */
  hide(): void {
    this.show(false);
  }

  /** A fa alatti jelölő finoman jelenik meg és tűnik el. */
  setCovered(covered: boolean): void {
    const marker = this.marker;
    if (!marker) return;
    const target = covered && this.shown ? 0.9 : 0;
    const alpha = marker.alpha;
    if (Math.abs(target - alpha) < 0.01) {
      if (alpha !== target) marker.setAlpha(target);
      return;
    }
    marker.setAlpha(alpha + (target - alpha) * 0.15);
  }

  destroy(): void {
    for (const part of [this.shadow, this.hull, this.turret, this.ring, this.barBack, this.barFill]) part.destroy();
    this.marker?.destroy();
  }
}
