// A civil járművek és a telepített ágyúk megjelenítése. Az állapotuk a szerver
// pillanatképeiből jön (20/mp); a képek két pillanatkép között interpolálva
// mozognak, onnan indulva, ahol éppen látszanak. Csak megjelenítés.

import Phaser from 'phaser';
import { BASE_PPM } from '../quality';
import { turretMaxHp, VEHICLES, VSTATE, type TurretState, type VehicleState } from '../sim/vehicles';
import { angleDiff, tankSize, tankTier } from '../sim/world';
import { GTEX } from './gameTextures';
import { tankTex, TURRET_PIVOT, TURRET_SIZE } from './tankTextures';
import { createVehicleTextures, vehicleTexture, VTEX } from './vehicleTextures';

const DEPTH = { flat: 2.5, wreck: 5, shadow: 7.8, body: 8, base: 9.4, barrel: 10.6, beam: 13.4, flame: 15.2, marker: 15.6, bar: 17 };
const WRECK_TINT = 0x4a4038;
const FLAT_TINT = 0x6a625a;

interface CarView {
  body: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  flame: Phaser.GameObjects.Sprite | null;
  beam: Phaser.GameObjects.Image | null;
  marker: Phaser.GameObjects.Image | null;
  /** a legutóbbi szerverállapot */
  target: VehicleState;
  /** az interpoláció kezdete, és ami éppen látszik (méter, radián) */
  fromX: number;
  fromY: number;
  fromA: number;
  x: number;
  y: number;
  a: number;
  state: number;
  alpha: number;
  gone: boolean;
}

interface GunView {
  base: Phaser.GameObjects.Image;
  barrel: Phaser.GameObjects.Image;
  barBack: Phaser.GameObjects.Image;
  barFill: Phaser.GameObjects.Image;
  target: TurretState;
  fromA: number;
  a: number;
  /** a saját lövegünk-e, és melyik szinthez tartozó rajz látszik éppen */
  own: boolean;
  level: number;
}

export type VehicleFx = (kind: 'smoke' | 'spray', px: number, py: number) => void;

export class VehicleLayer {
  private readonly cars = new Map<number, CarView>();
  private readonly guns = new Map<number, GunView>();
  private readonly scale: number;
  private frame = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ppm: number,
    private readonly weather: 'day' | 'rain' | 'night',
    /** a saját tank azonosítója: a saját ágyú zöld, a többieké kék */
    private readonly myTank: number,
    private readonly fx: VehicleFx,
  ) {
    this.scale = ppm / BASE_PPM;
    createVehicleTextures(scene);
  }

  get count(): number {
    return this.cars.size;
  }

  get turretCount(): number {
    return this.guns.size;
  }

  /** Új szerverállapot érkezett: az interpoláció onnan indul, ahol a jármű éppen látszik. */
  rebase(vehicles: readonly VehicleState[], turrets: readonly TurretState[]): void {
    const { scene, scale } = this;
    const seen = new Set<number>();
    for (const v of vehicles) {
      seen.add(v.id);
      let view = this.cars.get(v.id);
      if (!view) {
        const key = vehicleTexture(v.kind, v.look);
        view = {
          shadow: scene.add.image(0, 0, key).setTint(0x000000).setAlpha(0).setScale(scale).setDepth(DEPTH.shadow),
          body: scene.add.image(0, 0, key).setScale(scale).setDepth(DEPTH.body).setAlpha(0),
          flame: null,
          beam: null,
          marker: null,
          target: v,
          fromX: v.x,
          fromY: v.y,
          fromA: v.angle,
          x: v.x,
          y: v.y,
          a: v.angle,
          state: -1,
          alpha: 0,
          gone: false,
        };
        this.cars.set(v.id, view);
      } else if (Math.hypot(v.x - view.x, v.y - view.y) > 14) {
        // nagy ugrásnál nem csúsztatjuk át a pályán
        view.fromX = v.x;
        view.fromY = v.y;
        view.fromA = v.angle;
      } else {
        view.fromX = view.x;
        view.fromY = view.y;
        view.fromA = view.a;
      }
      view.target = v;
      view.gone = false;
    }
    // ami eltűnt a pillanatképből (kihajtott, vagy a roncsa eltűnt), gyorsan elhalványul
    for (const [id, view] of this.cars) if (!seen.has(id)) view.gone = true;

    seen.clear();
    for (const t of turrets) {
      seen.add(t.id);
      let view = this.guns.get(t.id);
      if (!view) {
        const own = t.owner === this.myTank;
        view = {
          base: scene.add.image(t.x * this.ppm, t.y * this.ppm, VTEX.turretBase).setScale(scale).setDepth(DEPTH.base),
          barrel: scene.add
            .image(t.x * this.ppm, t.y * this.ppm, tankTex.turret(own ? 'own' : 'rival', 0))
            .setOrigin(TURRET_PIVOT.x / TURRET_SIZE.w, TURRET_PIVOT.y / TURRET_SIZE.h)
            .setScale(scale * 0.92)
            .setDepth(DEPTH.barrel),
          barBack: scene.add.image(t.x * this.ppm, (t.y - 2.6) * this.ppm, GTEX.px).setDepth(DEPTH.bar).setTint(0x101418).setAlpha(0.85).setDisplaySize(38 * scale, 6 * scale),
          barFill: scene.add
            .image((t.x - 1.5) * this.ppm, (t.y - 2.6) * this.ppm, GTEX.px)
            .setDepth(DEPTH.bar + 1)
            .setOrigin(0, 0.5)
            .setTint(own ? 0x5ad24a : 0xe0483a),
          target: t,
          fromA: t.angle,
          a: t.angle,
          own,
          level: 0,
        };
        this.guns.set(t.id, view);
      } else view.fromA = view.a;
      view.target = t;
    }
    for (const [id, view] of this.guns) {
      if (seen.has(id)) continue;
      for (const part of [view.base, view.barrel, view.barBack, view.barFill]) part.destroy();
      this.guns.delete(id);
    }
  }

  private dropCar(id: number, view: CarView): void {
    view.body.destroy();
    view.shadow.destroy();
    view.flame?.destroy();
    view.beam?.destroy();
    view.marker?.destroy();
    this.cars.delete(id);
  }

  /** `alpha`: két szerverállapot közötti arány; `view`: a látómező világpixelben; `dt`: mp. */
  render(alpha: number, view: Phaser.Geom.Rectangle, seconds: number, dt: number): void {
    this.frame++;
    const { ppm, scale } = this;
    const margin = 8 * ppm;
    const night = this.weather === 'night';
    for (const [id, car] of this.cars) {
      const v = car.target;
      // megjelenéskor előtűnik, eltűnéskor elhalványul
      car.alpha = Math.max(0, Math.min(1, car.alpha + (car.gone ? -dt * 3 : dt * 4)));
      if (car.gone && car.alpha === 0) {
        this.dropCar(id, car);
        continue;
      }
      if (!car.gone) {
        car.x = car.fromX + (v.x - car.fromX) * alpha;
        car.y = car.fromY + (v.y - car.fromY) * alpha;
        car.a = car.fromA + angleDiff(v.angle, car.fromA) * alpha;
      }
      const px = car.x * ppm;
      const py = car.y * ppm;
      const visible = px > view.x - margin && px < view.right + margin && py > view.y - margin && py < view.bottom + margin;
      car.body.setVisible(visible);
      car.shadow.setVisible(visible && v.state !== VSTATE.flat);
      if (v.state !== car.state) this.restyle(car, v);
      const driving = v.state === VSTATE.driving;
      car.flame?.setVisible(visible);
      car.beam?.setVisible(visible && driving);
      car.marker?.setVisible(visible && driving);
      if (!visible) continue;
      car.body.setPosition(px, py).setRotation(car.a).setAlpha(car.alpha);
      car.shadow.setPosition(px + 4 * scale, py + 4 * scale).setRotation(car.a).setAlpha(0.3 * car.alpha);
      const cos = Math.cos(car.a);
      const sin = Math.sin(car.a);
      const half = (VEHICLES[v.kind].length / 2) * ppm;
      if (night && driving) {
        if (!car.beam) car.beam = this.scene.add.image(0, 0, VTEX.beam).setOrigin(0, 0.5).setDepth(DEPTH.beam).setBlendMode(Phaser.BlendModes.ADD).setScale(scale * 1.25);
        car.beam.setPosition(px + cos * half, py + sin * half).setRotation(car.a).setAlpha(0.42 * car.alpha);
      }
      if (v.kind === 'truck' && driving) {
        // az ellátó teherautót lüktető sárga gyűrű jelöli, hogy messziről is feltűnjön
        if (!car.marker) car.marker = this.scene.add.image(0, 0, GTEX.ring).setDepth(DEPTH.marker).setTint(0xffd24a);
        const pulse = 0.5 + 0.5 * Math.sin(seconds * 5);
        car.marker.setPosition(px, py).setScale(scale * (1.05 + 0.1 * pulse)).setAlpha((0.35 + 0.4 * pulse) * car.alpha);
      }
      if (v.state === VSTATE.burning && car.flame) {
        car.flame.setPosition(px + cos * half * 0.3, py + sin * half * 0.3);
        if ((this.frame + id) % 7 === 0) this.fx('smoke', px - cos * half * 0.2, py - sin * half * 0.2 - 5 * scale);
      } else if (this.weather === 'rain' && driving && v.speed > 6 && (this.frame + id) % 6 === 0) {
        this.fx('spray', px - cos * half, py - sin * half);
      }
    }

    for (const gun of this.guns.values()) {
      const t = gun.target;
      gun.a = gun.fromA + angleDiff(t.angle, gun.fromA) * alpha;
      gun.barrel.setRotation(gun.a);
      // a löveg a gazdája szintjét követi: a csöve a tank típusáé, és a tankkal együtt nő
      if (t.level !== gun.level) {
        gun.level = t.level;
        const size = scale * (0.86 + 0.5 * (tankSize(t) - 1));
        gun.barrel.setTexture(tankTex.turret(gun.own ? 'own' : 'rival', tankTier(t.level))).setScale(size);
        gun.base.setScale(scale * (1 + 0.45 * (tankSize(t) - 1)));
      }
      gun.barFill.setDisplaySize(Math.max(1, 36 * scale * Math.max(0, Math.min(1, t.hp / turretMaxHp(t.level)))), 4 * scale);
    }
  }

  /** A jármű állapotváltása: égni kezd, kiég, összelapul. */
  private restyle(car: CarView, v: VehicleState): void {
    car.state = v.state;
    const { scale } = this;
    if (v.state === VSTATE.burning) {
      if (!car.flame) {
        car.flame = this.scene.add
          .sprite(0, 0, GTEX.fire, 0)
          .setDepth(DEPTH.flame)
          .setScale(scale * (v.kind === 'car' ? 1.1 : 1.6));
        car.flame.play('fire');
      }
      return;
    }
    car.flame?.destroy();
    car.flame = null;
    if (v.state === VSTATE.wreck) car.body.setTint(WRECK_TINT).setDepth(DEPTH.wreck);
    else if (v.state === VSTATE.flat) car.body.setTint(FLAT_TINT).setDepth(DEPTH.flat).setScale(scale * 1.04, scale * 1.18);
  }

  /** A közlekedő járművek helye és iránya (az esti fényszórókhoz). */
  forEachDriving(visit: (x: number, y: number, angle: number, length: number) => void): void {
    for (const car of this.cars.values()) {
      if (car.target.state === VSTATE.driving && !car.gone) visit(car.x, car.y, car.a, VEHICLES[car.target.kind].length);
    }
  }
}
