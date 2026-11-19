// A fő játékjelenet: bemenet → szimuláció (rögzített lépésköz) → megjelenítés.
// A jelenet csak TankInput-ot ad a World-nek (a botok „agya” ugyanígy), az
// állapotot nem írja közvetlenül – ugyanez a felosztás marad meg, ha a World
// később a szerveren fut.

import Phaser from 'phaser';
import { createGameTextures, GTEX, PICKUP_ICON_SIZE } from '../entities/gameTextures';
import { PICKUP_STYLE, pickupTexture } from '../entities/pickupStyle';
import { TankView } from '../entities/TankView';
import { createTextures, TEX } from '../entities/textures';
import { ChunkLayer } from '../maps/ChunkLayer';
import type { GameMap } from '../maps/GameMap';
import { RoadLabelLayer } from '../maps/RoadLabelLayer';
import { BASE_PPM, cycleQuality } from '../quality';
import { BOT_LIMITS, loadSettings, saveSettings, type Settings } from '../settings';
import { BotManager } from '../sim/bots';
import { OIL, PICKUP, TIMED_KINDS } from '../sim/pickups';
import { BOOSTER, SIM_DT, TANK, tankMaxHp, TEAM, World, type ShotKind, type SimEvent, type TankInput, type TankState } from '../sim/world';
import { Sfx } from '../systems/audio';
import { Hud, type HudFrame } from '../ui/Hud';

/** Ha a térkép ennyi idő alatt sem készül el, a töltőképernyő akkor is eltűnik. */
const LOADING_TIMEOUT_MS = 8000;
/** Ennyi felvehető tárgy van egyszerre a pályán; közülük néhány a kezdőpont közelében. */
const PICKUPS = { total: 350, nearStart: 24, nearRadius: 300 };
/** A robbanás mérete a találat fajtája szerint. */
const BLAST: Record<ShotKind, number> = { shell: 1, heavy: 1.7, rocket: 2.4, laser: 0.45 };
/** A maradandó lövésnyom sugara méterben, a találat fajtája szerint. */
const SCAR: Record<ShotKind, number> = { shell: 1.1, heavy: 1.8, rocket: 2.6, laser: 0.45 };
/** Ennél messzebbi események hangja nem hallatszik (m). */
const HEARING = 140;

type Keys = Record<'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'SPACE' | 'SHIFT', Phaser.Input.Keyboard.Key>;

export class GameScene extends Phaser.Scene {
  private map!: GameMap;
  /** világpixel / méter */
  private ppm = BASE_PPM;
  /** a sprite-ok méretaránya az alap részletességhez képest */
  private spriteScale = 1;
  private settings: Settings = loadSettings();
  private world!: World;
  private bots!: BotManager;
  private player!: TankState;
  private ground!: ChunkLayer;
  private roadLabels!: RoadLabelLayer;
  private hud!: Hud;
  private keys!: Keys;
  private readonly sfx = new Sfx();
  private readonly inputs = new Map<number, TankInput>();
  // a szimuláció elemeinek megjelenítői, azonosító szerint
  private readonly tankViews = new Map<number, TankView>();
  private readonly bulletViews = new Map<number, Phaser.GameObjects.Image>();
  private readonly pickupViews = new Map<number, Phaser.GameObjects.Image>();
  private readonly oilViews = new Map<number, Phaser.GameObjects.Image>();
  /** a roncsok képei: test és torony */
  private readonly wreckViews = new Map<number, Phaser.GameObjects.Image[]>();
  /** újrahasznált effekt-sprite-ok */
  private readonly boomPool: Phaser.GameObjects.Sprite[] = [];
  private readonly flashPool: Phaser.GameObjects.Image[] = [];
  private readonly beamPool: Phaser.GameObjects.Image[] = [];
  private readonly smokePool: Phaser.GameObjects.Image[] = [];
  // képkockánként újrahasznált objektumok (ne keletkezzen fölösleges szemét)
  private readonly input_: TankInput = { throttle: 0, turn: 0, aim: null, fire: false, drop: false, boost: false };
  private readonly view = new Phaser.Geom.Rectangle();
  private readonly hudFrame: HudFrame = {
    x: 0, y: 0, angle: 0, viewX: 0, viewY: 0, viewW: 0, viewH: 0, canvasLeft: 0, canvasTop: 0, canvasWidth: 1, canvasHeight: 1,
    tanks: [], pickups: null,
  };
  private readonly effectLines: string[] = [];
  private canvasRectStale = true;
  private accumulator = 0;
  private pointerMoved = false;
  private tankViewsDirty = false;
  /** az olajfolt lerakását kérő leütés, amíg a szimuláció fel nem dolgozza */
  private dropLatch = false;
  private ready = false;
  private startedAt = 0;
  private frame = 0;
  private camX = 0;
  private camY = 0;

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
    createGameTextures(this);
    this.cameras.main.setBounds(0, 0, this.map.width * this.ppm, this.map.height * this.ppm);
    this.cameras.main.setRoundPixels(true);

    this.ground = new ChunkLayer(this, this.map, this.ppm);
    this.hud = new Hud(this.map, this.ppm);
    this.hud.setQualityText(`${this.ppm} px/m`);
    this.hud.onBotChange((delta) => this.changeBots(delta));
    this.roadLabels = new RoadLabelLayer(this, this.map, this.ppm);

    const kb = this.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,SHIFT') as Keys;
    // Az egyszeri parancsokat közvetlenül a böngésző billentyűeseményéből vesszük
    // (ismétlés nélkül), így minden leütés pontosan egyszer számít. A folyamatosan
    // nyomva tartott gombokat (mozgás, lövés) a fenti Key objektumok adják.
    window.addEventListener('keydown', (ev) => {
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
      // a botok száma a + és − billentyűvel állítható (bármelyik kiosztáson);
      // nyomva tartva gyorsan változik
      if (ev.key === '+' || ev.key === '-') {
        this.changeBots(ev.key === '+' ? 1 : -1);
        return;
      }
      if (ev.repeat) return;
      this.sfx.unlock();
      if (ev.code === 'KeyR') this.startRound();
      else if (ev.code === 'KeyM') this.hud.toggleMap();
      else if (ev.code === 'KeyH') this.hud.toggleHelp();
      else if (ev.code === 'KeyQ') cycleQuality(this.ppm);
      else if (ev.code === 'KeyE') this.dropLatch = true;
    });
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
    this.startRound();
  }

  /** Új kör: tiszta pálya, a tank a hivatal melletti kezdőpontra kerül, a botok és a tárgyak újra szétszóródnak. */
  private startRound(): void {
    for (const views of [this.tankViews, this.bulletViews, this.pickupViews, this.oilViews]) {
      for (const view of views.values()) view.destroy();
      views.clear();
    }
    for (const parts of this.wreckViews.values()) for (const part of parts) part.destroy();
    this.wreckViews.clear();
    // a pálya sérülései (kidőlt fák, lövésnyomok) is eltűnnek
    this.map.resetDamage();
    this.ground.reset();
    this.inputs.clear();
    this.accumulator = 0;

    this.world = new World(this.map, (Date.now() % 2147483647) + 1);
    const spawn = this.map.spawnPoint();
    this.player = this.world.addTank(spawn.x, spawn.y, spawn.angle, { team: TEAM.player });
    this.bots = new BotManager(this.world);
    this.bots.setCount(this.settings.bots, TEAM.bots, TEAM.player);
    this.world.scatterPickups(PICKUPS.total, { x: spawn.x, y: spawn.y, radius: PICKUPS.nearRadius, count: PICKUPS.nearStart });
    this.hud.setBotCount(this.bots.count);

    this.camX = spawn.x * this.ppm;
    this.camY = spawn.y * this.ppm;
    this.cameras.main.centerOn(this.camX, this.camY);
  }

  private changeBots(delta: number): void {
    const wanted = Math.max(BOT_LIMITS.min, Math.min(BOT_LIMITS.max, this.settings.bots + delta));
    if (wanted === this.settings.bots) return;
    this.settings = saveSettings({ ...this.settings, bots: wanted });
    this.bots.setCount(wanted, TEAM.bots, TEAM.player);
    this.tankViewsDirty = true;
    this.hud.setBotCount(this.bots.count);
    this.hud.toast(wanted === 0 ? 'Nincs ellenfél a pályán' : `Ellenfelek száma: ${wanted}`);
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
      input.aim = Math.atan2(pointer.worldY - this.player.y * this.ppm, pointer.worldX - this.player.x * this.ppm);
    }
    input.fire = k.SPACE.isDown || pointer.leftButtonDown();
    input.boost = k.SHIFT.isDown;
    // az E egyetlen rövid leütése is számít: a következő szimulációs lépésig megjegyezzük
    input.drop = this.dropLatch || pointer.rightButtonDown();
    return input;
  }

  update(time: number, deltaMs: number): void {
    this.frame++;
    this.inputs.set(this.player.id, this.readInput());

    // rögzített lépésközű szimuláció; lemaradásnál legfeljebb 5 lépés képkockánként
    this.accumulator = Math.min(this.accumulator + deltaMs / 1000, SIM_DT * 5);
    while (this.accumulator >= SIM_DT) {
      for (const tank of this.world.tanks) this.tankViews.get(tank.id)?.remember(tank);
      this.bots.update(this.inputs, SIM_DT);
      this.world.step(this.inputs);
      this.handleEvents();
      this.accumulator -= SIM_DT;
      this.dropLatch = false;
      this.input_.drop = this.input.activePointer.rightButtonDown();
    }

    const seconds = time / 1000;
    this.syncTanks(this.accumulator / SIM_DT, seconds, this.view);
    this.syncBullets();
    this.syncOils();
    this.syncWrecks(this.view);
    this.sfx.engine(this.player.alive ? (Math.abs(this.player.speed) / TANK.maxSpeed) * (this.player.boosting ? 1.15 : 1) : 0);

    // a kamera a saját tankot követi; ha kilőtték, ott marad, ahol történt
    const playerView = this.tankViews.get(this.player.id);
    if (playerView && this.player.alive) {
      this.camX = playerView.px;
      this.camY = playerView.py;
      playerView.setCovered(this.map.underCanopy(this.player.x, this.player.y));
    }
    const cam = this.cameras.main;
    cam.centerOn(this.camX, this.camY);
    const view = this.view.setTo(cam.scrollX, cam.scrollY, cam.width, cam.height);
    // amíg a töltőképernyő látszik, a kész darabok átvétele több időt kaphat
    this.ground.update(view, this.ready ? 3 : 12);
    this.roadLabels.update(view);
    this.syncPickups(view, seconds);

    if (!this.ready && (this.ground.isReady(view) || performance.now() - this.startedAt > LOADING_TIMEOUT_MS)) {
      this.ready = true;
      this.hud.hideLoading();
    }
    this.updateHud(view);
  }

  private updateHud(view: Phaser.Geom.Rectangle): void {
    const f = this.hudFrame;
    if (this.canvasRectStale) {
      const rect = this.game.canvas.getBoundingClientRect();
      f.canvasLeft = rect.left;
      f.canvasTop = rect.top;
      f.canvasWidth = rect.width;
      f.canvasHeight = rect.height;
      this.canvasRectStale = rect.width === 0; // amíg a vászon nincs elrendezve, újra próbáljuk
    }
    const p = this.player;
    f.x = p.x;
    f.y = p.y;
    f.angle = p.hullAngle;
    f.viewX = view.x;
    f.viewY = view.y;
    f.viewW = view.width;
    f.viewH = view.height;
    f.tanks = this.world.tanks;
    f.pickups = p.effects.radar > 0 ? this.world.pickups : null;
    this.hud.update(f);

    if (this.frame % 6 !== 0) return;
    this.hud.setStatus(p.hp, tankMaxHp(p), p.level, p.kills, p.deaths, p.alive ? 0 : Math.max(0, p.respawn));
    this.hud.setBoost(p.heat / BOOSTER.duration, p.overheated, p.boosting);
    // az aktív bónuszok listája
    const lines = this.effectLines;
    lines.length = 0;
    for (const kind of TIMED_KINDS) {
      if (p.effects[kind] > 0) lines.push(`${PICKUP_STYLE[kind].label} · ${Math.ceil(p.effects[kind])} mp`);
    }
    if (p.shield > 0) lines.push(`${PICKUP_STYLE.shield.label} ×${p.shield}`);
    if (p.oil > 0) lines.push(`${PICKUP_STYLE.oil.label} ×${p.oil} (E)`);
    this.hud.setEffects(lines);
  }

  /** A hang ereje a játékostól mért távolság szerint (0 = nem hallatszik). */
  private loudness(x: number, y: number): number {
    const dist = Math.hypot(x - this.player.x, y - this.player.y);
    return dist >= HEARING ? 0 : 1 - dist / HEARING;
  }

  private handleEvents(): void {
    for (const ev of this.world.events) this.handleEvent(ev);
  }

  private handleEvent(ev: SimEvent): void {
    const ppm = this.ppm;
    const mine = 'tank' in ev && ev.tank === this.player.id;
    switch (ev.type) {
      case 'shot': {
        const volume = mine ? 1 : this.loudness(ev.x, ev.y) * 0.7;
        if (volume > 0) {
          if (ev.kind === 'laser') this.sfx.laser(volume);
          else if (ev.kind === 'rocket') this.sfx.rocket(volume);
          else this.sfx.shot(volume);
        }
        if (ev.kind !== 'laser') {
          const flash = this.flashPool.pop() ?? this.add.image(0, 0, TEX.flash).setOrigin(0.15, 0.5).setScale(this.spriteScale).setDepth(12);
          flash.setPosition(ev.x * ppm, ev.y * ppm).setRotation(ev.angle).setVisible(true);
          this.time.delayedCall(70, () => {
            flash.setVisible(false);
            this.flashPool.push(flash);
          });
        }
        if (mine) this.cameras.main.shake(70, ev.kind === 'rocket' ? 0.003 : 0.0018);
        break;
      }
      case 'impact': {
        const volume = this.loudness(ev.x, ev.y);
        if (volume > 0 && ev.kind !== 'laser') this.sfx.explosion(Math.max(0.15, volume) * (ev.kind === 'shell' ? 1 : 1.3));
        this.boom(ev.x, ev.y, BLAST[ev.kind]);
        this.scar(ev.x, ev.y, SCAR[ev.kind]);
        break;
      }
      case 'laser':
        this.beam(ev.x1, ev.y1, ev.x2, ev.y2);
        break;
      case 'ricochet':
        if (this.loudness(ev.x, ev.y) > 0) this.sfx.ricochet(this.loudness(ev.x, ev.y));
        this.boom(ev.x, ev.y, 0.3);
        break;
      case 'pickup':
        if (mine) {
          const style = PICKUP_STYLE[ev.kind];
          this.sfx.pickup();
          this.hud.toast(`${style.label} – ${style.hint}`);
        }
        break;
      case 'oil':
        if (mine) this.sfx.bump();
        break;
      case 'slip':
        if (mine) {
          this.sfx.skid();
          this.hud.toast('Megcsúsztál az olajon!');
        }
        break;
      case 'bump':
        if (mine) {
          this.sfx.bump();
          this.cameras.main.shake(90, 0.002);
        }
        break;
      case 'hit':
        if (mine) {
          this.sfx.hit(ev.absorbed !== null);
          this.cameras.main.shake(140, ev.absorbed ? 0.002 : 0.005);
        } else if (ev.by === this.player.id) {
          this.sfx.hit(ev.absorbed !== null);
        }
        break;
      case 'destroyed':
        this.boom(ev.x, ev.y, 3.2);
        this.scar(ev.x, ev.y, 3);
        this.sfx.explosion(Math.max(0.4, this.loudness(ev.x, ev.y)) * 1.6);
        if (mine) {
          this.cameras.main.shake(400, 0.009);
          this.hud.toast('Kilőttek! Mindjárt újraéledsz…');
        } else if (ev.by === this.player.id) {
          this.hud.toast('Ellenfél kilőve!');
        }
        break;
      case 'felled': {
        // a változást a háttérszálak is megkapják, az érintett térképdarabok újrarajzolódnak
        this.ground.notify({ type: 'felled', index: ev.index, angle: ev.angle });
        const reach = (this.map.trees[ev.index]?.r ?? 2.5) * 2.6 + 3;
        this.ground.invalidate(ev.x - reach, ev.y - reach, ev.x + reach, ev.y + reach);
        const volume = this.loudness(ev.x, ev.y);
        if (volume > 0) this.sfx.crack(volume);
        break;
      }
      case 'overheat':
        if (mine) {
          this.sfx.overheat();
          this.hud.toast('Túlmelegedett a gyorsító – le kell hűlnie');
        }
        break;
      case 'levelup':
        if (mine) {
          this.sfx.pickup();
          this.hud.toast(`${ev.level}. szint: nagyobb, szívósabb tank, erősebb lövedék!`);
        }
        break;
      case 'respawn':
        this.tankViews.get(ev.tank)?.snap(this.world.tank(ev.tank)!);
        break;
    }
  }

  /** Maradandó lövésnyom: bekerül a pálya állapotába, és a térkép érintett része újrarajzolódik. */
  private scar(x: number, y: number, r: number): void {
    this.ground.notify({ type: 'scar', x, y, r });
    if (!this.map.addScar(x, y, r)) return;
    const reach = r * 1.3 + 0.5;
    this.ground.invalidate(x - reach, y - reach, x + reach, y + reach);
  }

  /** A kilőtt tankok roncsai: kiégett test és torony; a frissek füstölnek. */
  private syncWrecks(view: Phaser.Geom.Rectangle): void {
    const { wrecks } = this.world;
    if (wrecks.length === 0 && this.wreckViews.size === 0) return;
    const margin = 6 * this.ppm;
    for (const w of wrecks) {
      const x = w.x * this.ppm;
      const y = w.y * this.ppm;
      let parts = this.wreckViews.get(w.id);
      if (!parts) {
        parts = [
          this.add.image(x, y, GTEX.wreckHull).setRotation(w.hullAngle).setScale(this.spriteScale).setDepth(5),
          this.add.image(x, y, GTEX.wreckTurret).setOrigin(0.25, 0.5).setRotation(w.turretAngle + 0.5).setScale(this.spriteScale).setDepth(6),
        ];
        this.wreckViews.set(w.id, parts);
      }
      const visible = x > view.x - margin && x < view.right + margin && y > view.y - margin && y < view.bottom + margin;
      if (parts[0].visible !== visible) for (const part of parts) part.setVisible(visible);
      // a friss roncs még füstöl
      if (visible && w.age < 25 && (this.frame + w.id) % 14 === 0) this.smoke(x + (w.id % 5) - 2, y - 4);
    }
    if (this.wreckViews.size !== wrecks.length) {
      for (const [id, parts] of this.wreckViews) {
        if (!wrecks.some((w) => w.id === id)) {
          for (const part of parts) part.destroy();
          this.wreckViews.delete(id);
        }
      }
    }
  }

  /** Robbanás a megadott helyen, a megadott méretszorzóval. */
  private boom(x: number, y: number, size: number): void {
    let boom = this.boomPool.pop();
    if (!boom) {
      const created = this.add.sprite(0, 0, TEX.explosion, 0).setDepth(19);
      // az animáció végén a sprite elrejtődik (hideOnComplete) és visszakerül a készletbe
      created.on(Phaser.Animations.Events.ANIMATION_COMPLETE, () => this.boomPool.push(created));
      boom = created;
    }
    boom
      .setPosition(x * this.ppm, y * this.ppm)
      .setScale(this.spriteScale * size)
      .setVisible(true)
      .play('boom');
  }

  /** Lézersugár: fényes vonal, amely gyorsan elhalványul. */
  private beam(x1: number, y1: number, x2: number, y2: number): void {
    const ppm = this.ppm;
    const length = Math.hypot(x2 - x1, y2 - y1) * ppm;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    for (const [width, tint, alpha] of [[9, 0xff4a8a, 0.45], [3, 0xffffff, 0.95]] as const) {
      const beam = this.beamPool.pop() ?? this.add.image(0, 0, GTEX.px).setOrigin(0, 0.5).setDepth(13);
      beam
        .setPosition(x1 * ppm, y1 * ppm)
        .setRotation(angle)
        .setDisplaySize(length, width * this.spriteScale)
        .setTint(tint)
        .setAlpha(alpha)
        .setVisible(true);
      this.tweens.add({
        targets: beam,
        alpha: 0,
        duration: 240,
        onComplete: () => {
          beam.setVisible(false);
          this.beamPool.push(beam);
        },
      });
    }
  }

  private smoke(x: number, y: number): void {
    const puff = this.smokePool.pop() ?? this.add.image(0, 0, GTEX.smoke).setDepth(12);
    puff.setPosition(x, y).setScale(this.spriteScale * 0.6).setAlpha(0.7).setVisible(true);
    this.tweens.add({
      targets: puff,
      alpha: 0,
      scale: this.spriteScale * 1.6,
      duration: 420,
      onComplete: () => {
        puff.setVisible(false);
        this.smokePool.push(puff);
      },
    });
  }

  /** `visible`: az előző képkocka látómezeje – a rajta kívüli tankok megjelenítője pihen. */
  private syncTanks(alpha: number, seconds: number, visible: Phaser.Geom.Rectangle): void {
    const { tanks } = this.world;
    const margin = 6 * this.ppm;
    for (const tank of tanks) {
      const x = tank.x * this.ppm;
      const y = tank.y * this.ppm;
      const onScreen = tank === this.player || (x > visible.x - margin && x < visible.right + margin && y > visible.y - margin && y < visible.bottom + margin);
      let view = this.tankViews.get(tank.id);
      if (!view) {
        // megjelenítő csak akkor készül, amikor a tank először a kép közelébe kerül
        if (!onScreen) continue;
        view = new TankView(this, this.ppm, tank, tank.team !== this.player.team);
        this.tankViews.set(tank.id, view);
      }
      if (onScreen) view.render(tank, alpha, seconds);
      else view.hide();
    }
    // az eltávolított tankok megjelenítőinek törlése (ritkán kell: csak ha csökkent a botok száma)
    if (this.tankViewsDirty) {
      this.tankViewsDirty = false;
      for (const [id, view] of this.tankViews) {
        if (!this.world.tank(id)) {
          view.destroy();
          this.tankViews.delete(id);
        }
      }
    }
  }

  private syncBullets(): void {
    const { bullets } = this.world;
    if (bullets.length === 0 && this.bulletViews.size === 0) return;
    for (const b of bullets) {
      let view = this.bulletViews.get(b.id);
      if (!view) {
        const rocket = b.kind === 'rocket';
        view = this.add
          .image(0, 0, rocket ? GTEX.rocket : TEX.bullet)
          .setOrigin(rocket ? 0.7 : 0.85, 0.5)
          .setScale(this.spriteScale * (b.kind === 'heavy' ? 1.6 : 1))
          .setDepth(12);
        if (b.kind === 'heavy') view.setTint(0xffb0a0);
        this.bulletViews.set(b.id, view);
      }
      // a pattanó lövedék iránya menet közben változhat
      view.setPosition(b.x * this.ppm, b.y * this.ppm).setRotation(Math.atan2(b.vy, b.vx));
      if (b.kind === 'rocket' && this.frame % 2 === 0) this.smoke(b.x * this.ppm, b.y * this.ppm);
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

  private syncPickups(view: Phaser.Geom.Rectangle, seconds: number): void {
    const { pickups } = this.world;
    const size = PICKUP.radius * 2 * this.ppm;
    const base = size / PICKUP_ICON_SIZE;
    for (const p of pickups) {
      let icon = this.pickupViews.get(p.id);
      if (!icon) {
        // a lombréteg fölött, hogy fa alatt is látsszon
        icon = this.add.image(p.x * this.ppm, p.y * this.ppm, pickupTexture(p.kind)).setDepth(15);
        this.pickupViews.set(p.id, icon);
      }
      const visible = icon.x > view.x - size && icon.x < view.right + size && icon.y > view.y - size && icon.y < view.bottom + size;
      if (icon.visible !== visible) icon.setVisible(visible);
      // finom lüktetés, hogy feltűnjön
      if (visible) icon.setScale(base * (1 + 0.09 * Math.sin(seconds * 4 + p.id)));
    }
    if (this.pickupViews.size !== pickups.length) {
      for (const [id, icon] of this.pickupViews) {
        if (!pickups.some((p) => p.id === id)) {
          icon.destroy();
          this.pickupViews.delete(id);
        }
      }
    }
  }

  private syncOils(): void {
    const { oils } = this.world;
    if (oils.length === 0 && this.oilViews.size === 0) return;
    const scale = (OIL.radius * 2 * this.ppm) / 80; // a textúrán a folt kb. 80 pixel átmérőjű
    for (const oil of oils) {
      let view = this.oilViews.get(oil.id);
      if (!view) {
        view = this.add.image(oil.x * this.ppm, oil.y * this.ppm, GTEX.oil).setDepth(2).setScale(scale).setRotation((oil.id * 1.7) % 6.28);
        this.oilViews.set(oil.id, view);
      }
      // az utolsó másodpercekben elhalványul
      view.setAlpha(Math.min(0.88, oil.life / 4));
    }
    if (this.oilViews.size !== oils.length) {
      for (const [id, view] of this.oilViews) {
        if (!oils.some((o) => o.id === id)) {
          view.destroy();
          this.oilViews.delete(id);
        }
      }
    }
  }

  /** Diagnosztika (automata tesztekhez és hibakereséshez). */
  debugState(): Record<string, number | boolean> {
    const p = this.player;
    return {
      x: p.x,
      y: p.y,
      angle: p.hullAngle,
      speed: p.speed,
      hp: p.hp,
      alive: p.alive,
      kills: p.kills,
      deaths: p.deaths,
      tick: this.world.tick,
      ready: this.ready,
      ppm: this.ppm,
      bots: this.bots.count,
      pickups: this.world.pickups.length,
      oils: this.world.oils.length,
      level: p.level,
      heat: p.heat,
      overheated: p.overheated,
      boosting: p.boosting,
      wrecks: this.world.wrecks.length,
      scars: this.map.scars.length / 3,
      fallen: this.map.fellables.fallen.reduce((n, f) => n + f, 0),
      walls: this.map.walls.segmentCount,
      chunks: this.ground.chunkCount,
      chunksPending: this.ground.pendingCount,
      workers: this.ground.workerCount,
      chunkMs: Math.round(this.ground.lastRenderMs * 10) / 10,
      roadLabels: this.roadLabels.count,
    };
  }
}
