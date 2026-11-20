// Egy tank megjelenítése: a szimuláció állapotát (méter) képernyőre (világpixel) teszi.
// A saját tank zöld, a botoké vörös, a többi játékosé kék; fölötte életerősáv,
// körülötte a pajzs és a sebezhetetlenség gyűrűje. A tank kinézete a szintjének
// osztályát követi (felderítő … titán), a mérete a szintjét. Ahogy fogy az
// életereje, egyre sérültebbnek látszik: karcok és belövések, aztán korom és
// repedések, végül kiszakadt, izzó páncél és láng a testén.

import Phaser from 'phaser';
import { BASE_PPM } from '../quality';
import { angleDiff, LEVEL, tankMaxHp, tankSize, tankTier, type TankState } from '../sim/world';
import { FIRE_FRAMES, GTEX } from './gameTextures';
import { damageStage, tankTex, TANK_TIERS, TRACK_FRAMES, TURRET_PIVOT, TURRET_SIZE, type TankPaint } from './tankTextures';
import { TEX } from './textures';

interface Snapshot {
  x: number;
  y: number;
  hull: number;
  turret: number;
}

const BAR = { width: 46, height: 5, above: 34 };
/** a tank alatt lüktető fény színe osztályonként (0: nincs) – az ostromtanktól fölfelé */
const AURA = [0, 0, 0, 0xff8a2a, 0xff5030, 0x5fe6ff];

export class TankView {
  private readonly shadow: Phaser.GameObjects.Image;
  private readonly hull: Phaser.GameObjects.Image;
  private readonly turret: Phaser.GameObjects.Image;
  /** a sérülések rajza a test és a torony fölött, és a súlyosan sérült tankon égő láng */
  private readonly hullDamage: Phaser.GameObjects.Image;
  private readonly turretDamage: Phaser.GameObjects.Image;
  private readonly flame: Phaser.GameObjects.Image;
  /** a kirajzolt sérülés fokozata (0: ép); a GameScene ebből tudja, mennyire füstöl a tank */
  stage = 0;
  private stageKey = '';
  /** a lombréteg fölött látszó jelölő, ha a (saját) tank fa alatt áll */
  private readonly marker: Phaser.GameObjects.Image | null;
  private readonly ring: Phaser.GameObjects.Image;
  private readonly barBack: Phaser.GameObjects.Image;
  private readonly barFill: Phaser.GameObjects.Image;
  /** a magasabb osztályú tank alatt lüktető fény */
  private aura: Phaser.GameObjects.Image | null = null;
  /** a szupertárgy lüktető lila fénye */
  private power: Phaser.GameObjects.Image | null = null;
  /** a játékos neve az életerősáv fölött (csak a többi játékos tankján; a sajátunkon és a botokon nincs) */
  private readonly label: Phaser.GameObjects.Text | null;
  /** szintjelvény az életerősáv elején (a 2. szinttől) */
  private badge: Phaser.GameObjects.Text | null = null;
  private hullFrames: readonly string[] = [];
  private readonly prev: Snapshot;
  private readonly scale: number;
  private readonly enemy: boolean;
  private frame = -1;
  private level = 0;
  private tier = -1;
  /** az életerősáv szélessége világpixelben (a tankkal együtt nő) */
  private barWidth = 0;
  private lastHull = 0;
  private lastTurret = 0;
  /** a saját tank fölötti kiegészítők: a gyorsító hőfoka és az életek */
  private heatBack: Phaser.GameObjects.Image | null = null;
  private heatFill: Phaser.GameObjects.Image | null = null;
  private readonly pips: Phaser.GameObjects.Image[] = [];
  private shown = true;
  /** az utolsó kirajzolt (interpolált) hely világpixelben */
  px = 0;
  py = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ppm: number,
    tank: TankState,
    /** a saját tank zöld, a botok vörösek, a többi játékos kék */
    private readonly kind: TankPaint,
    /** a tank fölé írt név (üres: nincs felirat) */
    name = '',
  ) {
    const scale = ppm / BASE_PPM;
    this.scale = scale;
    const enemy = kind !== 'own';
    this.enemy = enemy;
    this.shadow = scene.add.image(0, 0, TEX.shadow).setAlpha(0.3).setDepth(9).setScale(scale);
    this.hull = scene.add.image(0, 0, tankTex.hull(kind, 0, 0)).setDepth(10).setScale(scale);
    this.turret = scene.add
      .image(0, 0, tankTex.turret(kind, 0))
      .setOrigin(TURRET_PIVOT.x / TURRET_SIZE.w, TURRET_PIVOT.y / TURRET_SIZE.h)
      .setDepth(11)
      .setScale(scale);
    this.hullDamage = scene.add.image(0, 0, tankTex.damageHull(0, 1)).setDepth(10.5).setVisible(false);
    this.turretDamage = scene.add
      .image(0, 0, tankTex.damageTurret(0, 1))
      .setOrigin(TURRET_PIVOT.x / TURRET_SIZE.w, TURRET_PIVOT.y / TURRET_SIZE.h)
      .setDepth(11.5)
      .setVisible(false);
    this.flame = scene.add.image(0, 0, GTEX.fire, 0).setDepth(11.7).setVisible(false);
    this.ring = scene.add.image(0, 0, GTEX.ring).setDepth(12).setScale(scale).setVisible(false);
    this.marker = enemy ? null : scene.add.image(0, 0, TEX.marker).setDepth(16).setAlpha(0).setScale(scale);
    // életerősáv (a lombréteg fölött, hogy fa alatt is látsszon)
    this.barBack = scene.add.image(0, 0, GTEX.px).setDepth(17).setTint(0x101418).setAlpha(0.85);
    this.barFill = scene.add.image(0, 0, GTEX.px).setDepth(18).setOrigin(0, 0.5);
    // a név kicsi, halvány felirat: látszik, ki az ellenfél, de nem takar
    this.label = name
      ? scene.add
          .text(0, 0, name, { fontFamily: 'Consolas, "Lucida Console", monospace', fontStyle: 'bold', fontSize: `${Math.round(13 * scale)}px`, color: '#f4f0e0', stroke: '#101418', strokeThickness: Math.max(2, Math.round(3 * scale)) })
          .setOrigin(0.5, 1)
          .setAlpha(0.85)
          .setDepth(18)
      : null;
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

  /**
   * Új szerverállapot érkezett: az interpoláció onnan indul, ahol a tank éppen
   * látszik (nem az előző állapotból), így a mozgás nem ugrik.
   */
  rebase(tank: TankState): void {
    const p = this.prev;
    const x = this.px / this.ppm;
    const y = this.py / this.ppm;
    // nagy ugrásnál (újraéledés) nem csúsztatjuk át a pályán
    if (!this.shown || Math.hypot(tank.x - x, tank.y - y) > 12) {
      this.remember(tank);
      return;
    }
    p.x = x;
    p.y = y;
    p.hull = this.lastHull;
    p.turret = this.lastTurret;
  }

  /** A saját tank fölött: a gyorsító hőfoka (0..1) és a hátralévő életek (−1: nincs kijelzés). */
  setOwnStatus(heat: number, overheated: boolean, lives: number): void {
    if (!this.heatBack || !this.heatFill) {
      this.heatBack = this.scene.add.image(0, 0, GTEX.px).setDepth(17).setTint(0x101418).setAlpha(0.85);
      this.heatFill = this.scene.add.image(0, 0, GTEX.px).setDepth(18).setOrigin(0, 0.5);
    }
    this.heatBack.setDisplaySize(this.barWidth + 2 * this.scale, 5 * this.scale);
    const visible = this.shown;
    const top = this.barBack.y + 6 * this.scale;
    this.heatBack.setVisible(visible && heat > 0).setPosition(this.barBack.x, top);
    this.heatFill
      .setVisible(visible && heat > 0)
      .setPosition(this.barBack.x - this.barWidth / 2, top)
      .setDisplaySize(Math.max(1, this.barWidth * Math.min(1, heat)), 3 * this.scale)
      .setTint(overheated ? 0xe0483a : 0xe8a02a);
    const count = Math.max(0, Math.min(5, lives));
    while (this.pips.length < count) this.pips.push(this.scene.add.image(0, 0, GTEX.px).setDepth(18).setTint(0xffd84a).setDisplaySize(6 * this.scale, 6 * this.scale));
    this.pips.forEach((pip, i) => {
      pip.setVisible(visible && i < count);
      if (i < count) pip.setPosition(this.barBack.x + (i - (count - 1) / 2) * 9 * this.scale, this.barBack.y - 8 * this.scale);
    });
  }

  /** Ugrás (újraéledés, áthelyezés) után: ne interpoláljon a régi helyről. */
  snap(tank: TankState): void {
    this.remember(tank);
  }

  private show(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    for (const part of [this.shadow, this.hull, this.turret, this.barBack, this.barFill]) part.setVisible(visible);
    this.aura?.setVisible(visible);
    this.power?.setVisible(visible);
    this.badge?.setVisible(visible);
    this.label?.setVisible(visible);
    this.hullDamage.setVisible(visible && this.stage > 0);
    this.turretDamage.setVisible(visible && this.stage > 0);
    this.flame.setVisible(visible && this.stage === 3);
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
    this.lastHull = hull;
    this.lastTurret = turret;
    // szintlépéskor a tank megnő; osztályváltáskor más típus lesz belőle
    const size = this.scale * tankSize(tank);
    if (tank.level !== this.level) {
      this.level = tank.level;
      this.shadow.setScale(size * (1 + 0.04 * tankTier(tank.level)));
      this.hull.setScale(size);
      this.turret.setScale(size);
      this.barWidth = BAR.width * size;
      this.barBack.setDisplaySize(this.barWidth + 2 * this.scale, (BAR.height + 2) * this.scale);
      const tier = Math.min(TANK_TIERS - 1, tankTier(tank.level));
      // az osztályon belüli szintlépéseket a csövön gyűrűk jelzik
      this.turret.setTexture(tankTex.turret(this.kind, tier, tank.level - LEVEL.tiers[tier]));
      if (tier !== this.tier) {
        this.tier = tier;
        this.hullFrames = Array.from({ length: TRACK_FRAMES }, (_, f) => tankTex.hull(this.kind, tier, f));
        this.frame = -1;
        if (AURA[tier] && !this.aura) this.aura = this.scene.add.image(0, 0, GTEX.light).setDepth(9).setBlendMode(Phaser.BlendModes.ADD);
        else if (!AURA[tier] && this.aura) {
          this.aura.destroy();
          this.aura = null;
        }
        this.aura?.setTint(AURA[tier]);
      }
      if (tank.level > 1) {
        this.badge ??= this.scene.add
          .text(0, 0, '', { fontFamily: 'Consolas, "Lucida Console", monospace', fontStyle: 'bold', fontSize: `${Math.round(15 * this.scale)}px`, color: '#ffd84a', stroke: '#101418', strokeThickness: Math.max(2, Math.round(4 * this.scale)) })
          .setOrigin(1, 0.5)
          .setDepth(18);
        this.badge.setText(`★${tank.level}`);
      } else if (this.badge) {
        this.badge.destroy();
        this.badge = null;
      }
    }
    if (this.aura) {
      // a titán fénye erős, az ostromtanké és a rombolóé halvány parázslás
      const strong = this.tier === TANK_TIERS - 1;
      const pulse = 0.5 + 0.5 * Math.sin(time * 3.2);
      this.aura.setPosition(x, y).setScale(size * (0.92 + 0.1 * pulse)).setAlpha(strong ? 0.3 + 0.16 * pulse : 0.14 + 0.1 * pulse);
    }
    // szupertárgy: amíg tart, a tank körül erős lila fény lüktet (mindenki látja)
    if (tank.effects.super > 0) {
      this.power ??= this.scene.add.image(0, 0, GTEX.light).setDepth(9.5).setTint(0xb45cff).setBlendMode(Phaser.BlendModes.ADD);
      const pulse = 0.5 + 0.5 * Math.sin(time * 11);
      this.power.setPosition(x, y).setScale(size * (1.15 + 0.2 * pulse)).setAlpha(0.6 + 0.3 * pulse);
    } else if (this.power) {
      this.power.destroy();
      this.power = null;
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

    // életerő és sérülések: minél kevesebb az életerő, annál roncsoltabb a tank
    const ratio = Math.max(0, Math.min(1, tank.hp / tankMaxHp(tank)));
    const stage = damageStage(ratio);
    const stageKey = `${this.tier}-${stage}`;
    if (stageKey !== this.stageKey) {
      this.stageKey = stageKey;
      this.stage = stage;
      this.hullDamage.setVisible(stage > 0);
      this.turretDamage.setVisible(stage > 0);
      this.flame.setVisible(stage === 3);
      if (stage > 0) {
        this.hullDamage.setTexture(tankTex.damageHull(this.tier, stage));
        this.turretDamage.setTexture(tankTex.damageTurret(this.tier, stage));
      }
    }
    if (stage > 0) {
      this.hullDamage.setPosition(x, y).setRotation(hull).setScale(size);
      this.turretDamage.setPosition(x, y).setRotation(turret).setScale(size);
    }
    if (stage === 3) {
      // láng a motortér fölött (a test hátulján), a tankkal együtt fordul
      const back = -15 * size;
      this.flame
        .setPosition(x + Math.cos(hull) * back, y + Math.sin(hull) * back)
        .setFrame(Math.floor(time * 14) % FIRE_FRAMES)
        .setScale(size * (0.5 + 0.35 * (1 - ratio / 0.25)));
    }

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
    const top = y - BAR.above * size;
    this.barBack.setPosition(x, top);
    this.badge?.setPosition(x - this.barWidth / 2 - 4 * this.scale, top);
    this.label?.setPosition(x, top - 6 * this.scale);
    this.barFill
      .setPosition(x - this.barWidth / 2, top)
      .setDisplaySize(Math.max(1, this.barWidth * ratio), BAR.height * this.scale)
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
    for (const part of [this.shadow, this.hull, this.turret, this.hullDamage, this.turretDamage, this.flame, this.ring, this.barBack, this.barFill, ...this.pips]) part.destroy();
    this.heatBack?.destroy();
    this.heatFill?.destroy();
    this.aura?.destroy();
    this.power?.destroy();
    this.badge?.destroy();
    this.label?.destroy();
    this.marker?.destroy();
  }
}
