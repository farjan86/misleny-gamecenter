// A fő játékjelenet: bemenet → szimuláció (rögzített lépésköz) → megjelenítés.
// A jelenet csak TankInput-ot ad a World-nek, az állapotot nem írja közvetlenül –
// ugyanez a felosztás marad meg, ha a World később a szerveren fut.

import Phaser from 'phaser';
import { TankView } from '../entities/TankView';
import { createTextures, TEX } from '../entities/textures';
import { ChunkLayer } from '../maps/ChunkLayer';
import type { GameMap } from '../maps/GameMap';
import { RoadLabelLayer } from '../maps/RoadLabelLayer';
import { BASE_PPM, cycleQuality } from '../quality';
import { SIM_DT, World, type TankInput, type TankState, TANK } from '../sim/world';
import { Sfx } from '../systems/audio';
import { Hud, type HudFrame } from '../ui/Hud';

/** Ha a térkép ennyi idő alatt sem készül el, a töltőképernyő akkor is eltűnik. */
const LOADING_TIMEOUT_MS = 8000;

type Keys = Record<'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'SPACE', Phaser.Input.Keyboard.Key>;

export class GameScene extends Phaser.Scene {
  private map!: GameMap;
  /** világpixel / méter */
  private ppm = BASE_PPM;
  /** a sprite-ok méretaránya az alap részletességhez képest */
  private spriteScale = 1;
  private world!: World;
  private player!: TankState;
  private playerView!: TankView;
  private ground!: ChunkLayer;
  private roadLabels!: RoadLabelLayer;
  /** újrahasznált robbanás- és torkolattűz-sprite-ok */
  private readonly boomPool: Phaser.GameObjects.Sprite[] = [];
  private readonly flashPool: Phaser.GameObjects.Image[] = [];
  private hud!: Hud;
  private keys!: Keys;
  private readonly sfx = new Sfx();
  private readonly inputs = new Map<number, TankInput>();
  private readonly bulletViews = new Map<number, Phaser.GameObjects.Image>();
  // képkockánként újrahasznált objektumok (ne keletkezzen fölösleges szemét)
  private readonly input_: TankInput = { throttle: 0, turn: 0, aim: null, fire: false };
  private readonly view = new Phaser.Geom.Rectangle();
  private readonly hudFrame: HudFrame = {
    x: 0, y: 0, angle: 0, viewX: 0, viewY: 0, viewW: 0, viewH: 0, canvasLeft: 0, canvasTop: 0, canvasWidth: 1, canvasHeight: 1,
  };
  private canvasRectStale = true;
  private accumulator = 0;
  private pointerMoved = false;
  private ready = false;
  private startedAt = 0;

  constructor() {
    super('game');
  }

  init(data: { map: GameMap; ppm: number }): void {
    this.map = data.map;
    this.ppm = data.ppm;
    this.spriteScale = data.ppm / BASE_PPM;
  }

  create(): void {
    createTextures(this);
    this.cameras.main.setBounds(0, 0, this.map.width * this.ppm, this.map.height * this.ppm);
    this.cameras.main.setRoundPixels(true);

    this.ground = new ChunkLayer(this, this.map, this.ppm);
    this.hud = new Hud(this.map, this.ppm);
    this.hud.setQualityText(`${this.ppm} px/m`);
    this.roadLabels = new RoadLabelLayer(this, this.map, this.ppm);

    const kb = this.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE') as Keys;
    kb.on('keydown-R', () => this.restart());
    kb.on('keydown-M', () => this.hud.toggleMap());
    kb.on('keydown-H', () => this.hud.toggleHelp());
    kb.on('keydown-Q', () => cycleQuality(this.ppm));
    kb.on('keydown', () => this.sfx.unlock());
    this.input.on('pointerdown', () => this.sfx.unlock());
    this.input.on('pointermove', () => {
      this.pointerMoved = true;
    });
    this.input.mouse?.disableContextMenu();

    // a vászon helyét csak átméretezéskor olvassuk ki újra
    const stale = (): void => {
      this.canvasRectStale = true;
    };
    this.scale.on(Phaser.Scale.Events.RESIZE, stale);
    window.addEventListener('resize', stale);
    document.addEventListener('fullscreenchange', stale);

    this.startedAt = performance.now();
    this.restart();
  }

  /** Új kör: a tank visszakerül a hivatal melletti kezdőpontra. */
  private restart(): void {
    this.playerView?.destroy();
    for (const view of this.bulletViews.values()) view.destroy();
    this.bulletViews.clear();
    this.inputs.clear();
    this.accumulator = 0;

    this.world = new World(this.map);
    const spawn = this.map.spawnPoint();
    this.player = this.world.addTank(spawn.x, spawn.y, spawn.angle);
    this.playerView = new TankView(this, this.ppm, this.player);
    this.cameras.main.centerOn(this.playerView.px, this.playerView.py);
  }

  private readInput(): TankInput {
    const k = this.keys;
    const input = this.input_;
    input.throttle = (k.W.isDown || k.UP.isDown ? 1 : 0) - (k.S.isDown || k.DOWN.isDown ? 1 : 0);
    input.turn = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
    const pointer = this.input.activePointer;
    input.aim = null;
    if (this.pointerMoved) {
      pointer.updateWorldPoint(this.cameras.main);
      input.aim = Math.atan2(pointer.worldY - this.playerView.py, pointer.worldX - this.playerView.px);
    }
    input.fire = k.SPACE.isDown || pointer.leftButtonDown();
    return input;
  }

  update(_time: number, deltaMs: number): void {
    this.inputs.set(this.player.id, this.readInput());

    // rögzített lépésközű szimuláció; lemaradásnál legfeljebb 5 lépés képkockánként
    this.accumulator = Math.min(this.accumulator + deltaMs / 1000, SIM_DT * 5);
    while (this.accumulator >= SIM_DT) {
      this.playerView.remember(this.player);
      this.world.step(this.inputs);
      this.handleEvents();
      this.accumulator -= SIM_DT;
    }

    this.playerView.render(this.player, this.accumulator / SIM_DT);
    this.playerView.setCovered(this.map.underCanopy(this.player.x, this.player.y));
    this.syncBullets();
    this.sfx.engine(Math.abs(this.player.speed) / TANK.maxSpeed);

    const cam = this.cameras.main;
    cam.centerOn(this.playerView.px, this.playerView.py);
    const view = this.view.setTo(cam.scrollX, cam.scrollY, cam.width, cam.height);
    // amíg a töltőképernyő látszik, a kész darabok átvétele több időt kaphat
    this.ground.update(view, this.ready ? 3 : 12);
    this.roadLabels.update(view);

    if (!this.ready && (this.ground.isReady(view) || performance.now() - this.startedAt > LOADING_TIMEOUT_MS)) {
      this.ready = true;
      this.hud.hideLoading();
    }

    const f = this.hudFrame;
    if (this.canvasRectStale) {
      const rect = this.game.canvas.getBoundingClientRect();
      f.canvasLeft = rect.left;
      f.canvasTop = rect.top;
      f.canvasWidth = rect.width;
      f.canvasHeight = rect.height;
      this.canvasRectStale = rect.width === 0; // amíg a vászon nincs elrendezve, újra próbáljuk
    }
    f.x = this.player.x;
    f.y = this.player.y;
    f.angle = this.player.hullAngle;
    f.viewX = view.x;
    f.viewY = view.y;
    f.viewW = view.width;
    f.viewH = view.height;
    this.hud.update(f);
  }

  private handleEvents(): void {
    for (const ev of this.world.events) {
      if (ev.type === 'shot') {
        this.sfx.shot();
        const flash = this.flashPool.pop() ?? this.add.image(0, 0, TEX.flash).setOrigin(0.15, 0.5).setScale(this.spriteScale).setDepth(12);
        flash.setPosition(ev.x * this.ppm, ev.y * this.ppm).setRotation(ev.angle).setVisible(true);
        this.time.delayedCall(70, () => {
          flash.setVisible(false);
          this.flashPool.push(flash);
        });
        this.cameras.main.shake(70, 0.0018);
      } else if (ev.type === 'impact') {
        const dist = Math.hypot(ev.x - this.player.x, ev.y - this.player.y);
        this.sfx.explosion(Math.max(0.15, 1 - dist / 90));
        let boom = this.boomPool.pop();
        if (!boom) {
          const created = this.add.sprite(0, 0, TEX.explosion, 0).setScale(this.spriteScale).setDepth(15);
          // az animáció végén a sprite elrejtődik (hideOnComplete) és visszakerül a készletbe
          created.on(Phaser.Animations.Events.ANIMATION_COMPLETE, () => this.boomPool.push(created));
          boom = created;
        }
        boom.setPosition(ev.x * this.ppm, ev.y * this.ppm).setVisible(true).play('boom');
      } else if (ev.type === 'bump') {
        this.sfx.bump();
        this.cameras.main.shake(90, 0.002);
      }
    }
  }

  private syncBullets(): void {
    const { bullets } = this.world;
    if (bullets.length === 0 && this.bulletViews.size === 0) return;
    for (const b of bullets) {
      let view = this.bulletViews.get(b.id);
      if (!view) {
        view = this.add
          .image(0, 0, TEX.bullet)
          .setOrigin(0.85, 0.5)
          .setScale(this.spriteScale)
          .setDepth(12)
          .setRotation(Math.atan2(b.vy, b.vx));
        this.bulletViews.set(b.id, view);
      }
      view.setPosition(b.x * this.ppm, b.y * this.ppm);
    }
    if (this.bulletViews.size !== bullets.length) {
      for (const [id, view] of this.bulletViews) {
        if (!bullets.some((b) => b.id === id)) {
          view.destroy();
          this.bulletViews.delete(id);
        }
      }
    }
  }

  /** Diagnosztika (automata tesztekhez és hibakereséshez). */
  debugState(): Record<string, number | boolean> {
    return {
      x: this.player.x,
      y: this.player.y,
      angle: this.player.hullAngle,
      speed: this.player.speed,
      tick: this.world.tick,
      ready: this.ready,
      ppm: this.ppm,
      walls: this.map.walls.segmentCount,
      chunks: this.ground.chunkCount,
      chunksPending: this.ground.pendingCount,
      workers: this.ground.workerCount,
      chunkMs: Math.round(this.ground.lastRenderMs * 10) / 10,
      roadLabels: this.roadLabels.count,
    };
  }
}
