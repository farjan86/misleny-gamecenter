// Tüzek a pályán: a találatot kapott háztetők, a lövéstől kidőlt fák és a
// kilőtt tankok egy ideig égnek. Csak megjelenítés – a szimulációra nincs
// hatása, a tűz nem sebez. A látómezőn kívüli tüzeknek nincs sprite-juk, a
// lángok és a füstpamacsok készletből újrahasznosulnak.

import Phaser from 'phaser';
import { FIRE_FRAMES, GTEX } from './gameTextures';

const FLAME_DEPTH = 15.2;
const GLOW_DEPTH = 15.1;
const SMOKE_DEPTH = 15.4;
/** Ennél több tűz egyszerre nem ég; a kameratól legtávolabbi alszik ki először. */
const MAX_FIRES = 160;
/** Ennél közelebb nem gyullad új tűz: a meglévő kap új erőre (m). */
const MERGE_DIST = 2.2;
/** A kialvás előtti utolsó másodpercekben a láng fokozatosan összemegy. */
const DYING = 4;

interface Fire {
  x: number;
  y: number;
  /** a láng fél szélessége méterben */
  size: number;
  /** ennyi ideig ég még (mp) */
  left: number;
  /** ennyi ideje ég (mp): az első másodpercekben kap lángra */
  age: number;
  /** a következő füstpamacsig hátralévő idő (mp) */
  puff: number;
  flame: Phaser.GameObjects.Sprite | null;
  glow: Phaser.GameObjects.Image | null;
}

export class FireLayer {
  private readonly fires: Fire[] = [];
  private readonly flamePool: Phaser.GameObjects.Sprite[] = [];
  private readonly glowPool: Phaser.GameObjects.Image[] = [];
  private readonly smokePool: Phaser.GameObjects.Image[] = [];
  private seed = 1;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly ppm: number,
  ) {
    if (!scene.anims.exists('fire')) {
      scene.anims.create({
        key: 'fire',
        frames: Array.from({ length: FIRE_FRAMES }, (_, f) => ({ key: GTEX.fire, frame: f })),
        frameRate: 11,
        repeat: -1,
      });
    }
  }

  get count(): number {
    return this.fires.length;
  }

  /** Hány tűznek van éppen sprite-ja (diagnosztikához). */
  get visibleCount(): number {
    let n = 0;
    for (const fire of this.fires) if (fire.flame) n++;
    return n;
  }

  /** Tűz gyújtása a megadott helyen (méterben); `size`: a láng fél szélessége, `life`: az égés ideje (mp). */
  ignite(x: number, y: number, size: number, life: number): void {
    for (const fire of this.fires) {
      if (Math.abs(fire.x - x) < MERGE_DIST && Math.abs(fire.y - y) < MERGE_DIST) {
        // ugyanott újabb találat: a tűz nagyobb lesz és tovább ég
        fire.size = Math.min(4, Math.max(fire.size, size) + 0.3);
        fire.left = Math.max(fire.left, life);
        return;
      }
    }
    if (this.fires.length >= MAX_FIRES) this.dropFarthest();
    this.fires.push({ x, y, size, left: life, age: 0, puff: 0, flame: null, glow: null });
  }

  private dropFarthest(): void {
    const cam = this.scene.cameras.main;
    const cx = (cam.scrollX + cam.width / 2) / this.ppm;
    const cy = (cam.scrollY + cam.height / 2) / this.ppm;
    let worst = 0;
    let worstDist = -1;
    for (let i = 0; i < this.fires.length; i++) {
      const d = Math.hypot(this.fires[i].x - cx, this.fires[i].y - cy);
      if (d > worstDist) {
        worstDist = d;
        worst = i;
      }
    }
    this.release(this.fires[worst]);
    this.fires.splice(worst, 1);
  }

  private release(fire: Fire): void {
    if (fire.flame) {
      fire.flame.stop().setVisible(false);
      this.flamePool.push(fire.flame);
      fire.flame = null;
    }
    if (fire.glow) {
      fire.glow.setVisible(false);
      this.glowPool.push(fire.glow);
      fire.glow = null;
    }
  }

  /** Olcsó, determinisztikus véletlen a lángok változatosságához (a szimulációtól független). */
  private rnd(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  /** `view`: a látómező világpixelben; `dt`: az eltelt idő másodpercben. */
  update(view: Phaser.Geom.Rectangle, dt: number): void {
    const { fires, ppm } = this;
    if (fires.length === 0) return;
    const margin = 5 * ppm;
    for (let i = fires.length - 1; i >= 0; i--) {
      const fire = fires[i];
      fire.left -= dt;
      fire.age += dt;
      if (fire.left <= 0) {
        this.release(fire);
        fires.splice(i, 1);
        continue;
      }
      const px = fire.x * ppm;
      const py = fire.y * ppm;
      const visible = px > view.x - margin && px < view.right + margin && py > view.y - margin && py < view.bottom + margin;
      if (!visible) {
        this.release(fire);
        continue;
      }
      // lángra kap (2,5 mp alatt nő meg), a végén fokozatosan kialszik
      const strength = Math.min(1, fire.left / DYING, 0.35 + (fire.age / 2.5) * 0.65);
      const scale = (fire.size * 2 * ppm * (0.45 + 0.55 * strength)) / 48;
      if (!fire.flame) {
        fire.flame = this.flamePool.pop() ?? this.scene.add.sprite(0, 0, GTEX.fire, 0).setDepth(FLAME_DEPTH);
        fire.flame.setPosition(px, py).setRotation(this.rnd() * 6.283).setVisible(true);
        fire.flame.play({ key: 'fire', startFrame: Math.floor(this.rnd() * FIRE_FRAMES) });
        fire.glow = this.glowPool.pop() ?? this.scene.add.image(0, 0, GTEX.glow).setDepth(GLOW_DEPTH).setBlendMode(Phaser.BlendModes.ADD);
        fire.glow.setPosition(px, py).setVisible(true);
      }
      fire.flame.setScale(scale);
      fire.glow?.setScale(scale * 2.1).setAlpha(0.42 * strength + 0.1 * this.rnd());

      // sötét füst, amely a széllel (északkelet felé) sodródik és eloszlik
      fire.puff -= dt;
      if (fire.puff <= 0) {
        fire.puff = 0.16 + this.rnd() * 0.16;
        this.puff(px + (this.rnd() - 0.5) * fire.size * ppm, py + (this.rnd() - 0.5) * fire.size * ppm, fire.size * (0.7 + 0.5 * strength));
      }
    }
  }

  private puff(x: number, y: number, size: number): void {
    const puff = this.smokePool.pop() ?? this.scene.add.image(0, 0, GTEX.smoke).setDepth(SMOKE_DEPTH).setTint(0x3a3632);
    const s = (size * this.ppm) / 14;
    const drift = (3.5 + this.rnd() * 3.5) * this.ppm;
    puff.setPosition(x, y).setScale(s * 0.6).setAlpha(0.72).setVisible(true);
    this.scene.tweens.add({
      targets: puff,
      x: x + drift * 0.8,
      y: y - drift,
      alpha: 0,
      scale: s * 1.9,
      duration: 1700 + this.rnd() * 800,
      onComplete: () => {
        puff.setVisible(false);
        this.smokePool.push(puff);
      },
    });
  }

  /** Az égő tüzek bejárása (pl. az esti megvilágításhoz): hely méterben és a láng fél szélessége. */
  forEach(fn: (x: number, y: number, size: number) => void): void {
    for (const fire of this.fires) fn(fire.x, fire.y, fire.size * Math.min(1, fire.left / DYING));
  }

  /** Minden tűz kialszik (új kör). */
  clear(): void {
    for (const fire of this.fires) this.release(fire);
    this.fires.length = 0;
  }

}
