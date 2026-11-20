// Szintetizált hangok a Web Audio API-val (nincs hangfájl).
// A böngészők csak felhasználói művelet után engednek hangot, ezért az
// AudioContext az első billentyű- vagy egérlenyomáskor jön létre.
//
// Minden hang két építőelemből áll: szűrt zajból (robbanás, csattanás, szél)
// és csúszó hangmagasságú hangjegyből (dörrenés, csengés). A hangok a
// közös hangerőn és egy kompresszoron mennek át: így hangosak lehetnek anélkül,
// hogy sok egyszerre megszólaló hang torzítana. A hangmagasság minden
// megszólaláskor kicsit más, hogy két egyforma esemény se szóljon gépiesen.

import type { PickupKind } from '../sim/pickups';
import type { Weather } from '../sim/world';

/** A teljes hangerő 100%-os beállításnál (a kompresszor előtt). */
const MASTER = 1.7;
/** Ennyi hang szólhat egyszerre; fölötte az újak kimaradnak (nagy csatában se akadjon a hang). */
const MAX_VOICES = 56;

interface NoiseOptions {
  type?: BiquadFilterType;
  q?: number;
  delay?: number;
  /** felfutás másodpercben (0: azonnal teljes hangerő) */
  attack?: number;
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
/** Véletlen eltérés a hangmagasságban (±amount arányban). */
const vary = (amount = 0.06): number => 1 + (Math.random() * 2 - 1) * amount;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private rattleGain: GainNode | null = null;
  private rattleFilter: BiquadFilterNode | null = null;
  private ambienceGain: GainNode | null = null;
  private weather: Weather = 'day';
  private voices = 0;
  private level = 0.8;
  muted = false;

  /** A hangerő 0 és 1 között (a beállításokból). */
  setVolume(volume: number): void {
    this.level = Math.max(0, Math.min(1, volume));
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(MASTER * this.level, this.ctx.currentTime, 0.03);
  }

  /** Felhasználói eseményből hívandó. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = MASTER * this.level;
    // a kompresszor fogja meg a csúcsokat: a hangok hangosak, de nem torzítanak
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 7;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    this.master.connect(comp).connect(ctx.destination);

    this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // motorhang: két egymásra hangolt rezgő (a mélyebb adja a dörmögést) és a lánctalp zörgése
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 42;
    this.engineSub = ctx.createOscillator();
    this.engineSub.type = 'square';
    this.engineSub.frequency.value = 21;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.55;
    this.engineOsc.connect(filter);
    this.engineSub.connect(subGain).connect(filter);
    filter.connect(this.engineGain).connect(this.master);
    this.engineOsc.start();
    this.engineSub.start();

    const rattle = ctx.createBufferSource();
    rattle.buffer = this.noiseBuffer;
    rattle.loop = true;
    this.rattleFilter = ctx.createBiquadFilter();
    this.rattleFilter.type = 'bandpass';
    this.rattleFilter.frequency.value = 900;
    this.rattleFilter.Q.value = 1.4;
    this.rattleGain = ctx.createGain();
    this.rattleGain.gain.value = 0;
    rattle.connect(this.rattleFilter).connect(this.rattleGain).connect(this.master);
    rattle.start();

    // háttérzaj (eső): az időjárás beállításakor szólal meg
    const ambience = ctx.createBufferSource();
    ambience.buffer = this.noiseBuffer;
    ambience.loop = true;
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'highpass';
    rainFilter.frequency.value = 1800;
    this.ambienceGain = ctx.createGain();
    this.ambienceGain.gain.value = 0;
    ambience.connect(rainFilter).connect(this.ambienceGain).connect(this.master);
    ambience.start();
    this.ambience(this.weather);
  }

  /** A pálya háttérhangja: esőben az eső zúgása. */
  ambience(weather: Weather): void {
    this.weather = weather;
    if (!this.ctx || !this.ambienceGain) return;
    this.ambienceGain.gain.setTargetAtTime(weather === 'rain' && !this.muted ? 0.035 : 0, this.ctx.currentTime, 0.6);
  }

  /** ratio: 0 (áll) .. 1 (végsebesség); size: a tank mérete (a nagyobb tank motorja mélyebb és hangosabb) */
  engine(ratio: number, size = 1): void {
    if (!this.ctx || !this.engineOsc || !this.engineSub || !this.engineGain || !this.rattleGain || !this.rattleFilter) return;
    const now = this.ctx.currentTime;
    const base = (40 + ratio * 46) / Math.sqrt(size);
    this.engineOsc.frequency.setTargetAtTime(base, now, 0.08);
    this.engineSub.frequency.setTargetAtTime(base / 2, now, 0.08);
    this.engineGain.gain.setTargetAtTime(this.muted || ratio < 0 ? 0 : (0.07 + ratio * 0.1) * (0.85 + 0.15 * size), now, 0.08);
    // a lánctalp zörgése csak menet közben hallatszik
    this.rattleFilter.frequency.setTargetAtTime(600 + ratio * 900, now, 0.1);
    this.rattleGain.gain.setTargetAtTime(this.muted || ratio <= 0.02 ? 0 : ratio * 0.03 * size, now, 0.1);
  }

  private get ready(): boolean {
    return this.ctx !== null && this.master !== null && !this.muted && this.voices < MAX_VOICES;
  }

  /** Szűrt zaj: a szűrő frekvenciája `from`-ról `to`-ra csúszik, a hangerő lecseng. */
  private noise(duration: number, from: number, to: number, volume: number, options: NoiseOptions = {}): void {
    if (!this.ready || !this.noiseBuffer || volume <= 0.002) return;
    const ctx = this.ctx!;
    const start = ctx.currentTime + (options.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = options.type ?? 'lowpass';
    filter.Q.value = options.q ?? 0.7;
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
    const gain = ctx.createGain();
    const attack = options.attack ?? 0;
    if (attack > 0) {
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + attack);
    } else {
      gain.gain.setValueAtTime(volume, start);
    }
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    src.connect(filter).connect(gain).connect(this.master!);
    this.voices++;
    src.onended = () => this.voices--;
    src.start(start, Math.random() * 1.2, duration + 0.02);
  }

  /** Hangjegy: frekvencia-csúszás a megadott hullámformával. */
  private tone(type: OscillatorType, from: number, to: number, duration: number, volume: number, delay = 0): void {
    if (!this.ready || volume <= 0.002) return;
    const ctx = this.ctx!;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(10, to), start + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.connect(gain).connect(this.master!);
    this.voices++;
    osc.onended = () => this.voices--;
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  /** Fémes csendülés: két elhangolt, gyorsan lecsengő hang. */
  private clang(pitch: number, volume: number, delay = 0, duration = 0.22): void {
    this.tone('triangle', pitch, pitch * 0.985, duration, volume, delay);
    this.tone('square', pitch * 1.52, pitch * 1.5, duration * 0.7, volume * 0.35, delay);
  }

  // --- lövések ---------------------------------------------------------------------

  /** volume: 0..1 – távoli lövés halkabb; size: a lövő tank mérete (a nagyobb ágyú mélyebben szól) */
  shot(volume = 1, size = 1): void {
    const k = vary(0.07) / Math.sqrt(size);
    this.noise(0.2 + 0.05 * size, 3400 * k, 260, 0.8 * volume);
    this.tone('square', 230 * k, 52 * k, 0.15, 0.3 * volume);
    this.tone('sine', 120 * k, 40 * k, 0.2 + 0.06 * size, 0.5 * volume);
  }

  /** nehéz lövedék: hosszabb, mély dörrenés */
  heavyShot(volume = 1, size = 1): void {
    const k = vary(0.05) / Math.sqrt(size);
    this.noise(0.42, 2400 * k, 110, 0.95 * volume);
    this.tone('sine', 95 * k, 30 * k, 0.4, 0.75 * volume);
    this.tone('sawtooth', 160 * k, 45 * k, 0.22, 0.25 * volume);
    this.noise(0.5, 900, 300, 0.2 * volume, { delay: 0.12 });
  }

  /** a telepített ágyú lövése: éles, száraz csattanás */
  turretShot(volume = 1): void {
    const k = vary(0.05);
    this.noise(0.11, 5200 * k, 700, 0.6 * volume, { type: 'bandpass', q: 0.9 });
    this.tone('square', 420 * k, 110 * k, 0.09, 0.26 * volume);
  }

  laser(volume = 1): void {
    const k = vary(0.05);
    this.tone('sawtooth', 1900 * k, 300 * k, 0.24, 0.26 * volume);
    this.tone('square', 2700 * k, 900 * k, 0.13, 0.12 * volume);
    this.noise(0.18, 6000, 2500, 0.12 * volume, { type: 'highpass' });
  }

  /** rakéta indítása: felsüvítő hajtómű */
  rocket(volume = 1): void {
    const k = vary(0.05);
    this.noise(0.6, 700 * k, 3200 * k, 0.6 * volume, { type: 'bandpass', q: 0.8, attack: 0.04 });
    this.tone('sawtooth', 120 * k, 55 * k, 0.45, 0.26 * volume);
    this.noise(0.12, 2600, 500, 0.4 * volume);
  }

  // --- becsapódás, robbanás ----------------------------------------------------------

  /** volume: 0..1, a kamerától mért távolság szerint; size: a robbanás mérete */
  explosion(volume = 1, size = 1): void {
    const k = vary(0.1);
    this.noise(0.4 + 0.12 * size, 1500 * k, 70, 0.95 * volume);
    this.tone('sine', (95 * k) / size, 28, 0.32 + 0.1 * size, 0.6 * volume);
    // szétszóródó törmelék
    for (let i = 0; i < 3; i++) this.noise(0.05, rand(2500, 5000), 1200, 0.18 * volume, { type: 'bandpass', q: 2, delay: 0.1 + i * rand(0.05, 0.11) });
  }

  /** a lövedék becsapódása: a sima lövedék rövid csattanás, a nehéz és a rakéta nagy robbanás */
  impact(kind: 'shell' | 'heavy' | 'rocket' | 'laser', volume = 1): void {
    if (kind === 'laser') {
      this.noise(0.12, 5000, 1500, 0.2 * volume, { type: 'highpass' });
      return;
    }
    if (kind === 'shell') {
      const k = vary(0.12);
      this.noise(0.26, 1900 * k, 120, 0.8 * volume);
      this.tone('sine', 130 * k, 45, 0.18, 0.4 * volume);
      this.noise(0.05, rand(2800, 4600), 1400, 0.16 * volume, { type: 'bandpass', q: 2, delay: rand(0.07, 0.14) });
    } else {
      this.explosion(volume * 1.15, kind === 'rocket' ? 1.6 : 1.3);
    }
  }

  /** kilőtt tank: nagy robbanás, szakadó fém, lehulló darabok */
  tankDestroyed(volume = 1): void {
    this.noise(1.0, 1300, 50, 1.1 * volume);
    this.tone('sine', 70, 24, 0.9, 0.9 * volume);
    this.tone('sawtooth', 190, 40, 0.5, 0.3 * volume);
    this.clang(310 * vary(0.1), 0.22 * volume, 0.12, 0.5);
    this.clang(205 * vary(0.1), 0.18 * volume, 0.3, 0.6);
    for (let i = 0; i < 6; i++) this.noise(0.06, rand(1800, 5200), 900, 0.22 * volume, { type: 'bandpass', q: 2.5, delay: 0.25 + i * rand(0.07, 0.15) });
  }

  /** felrobbanó jármű: robbanás és csörömpölő üveg */
  vehicleBlast(volume = 1, size = 1): void {
    this.explosion(volume * 1.2, size);
    this.noise(0.35, 7000, 3500, 0.3 * volume, { type: 'highpass', delay: 0.05 });
    for (let i = 0; i < 4; i++) this.tone('sine', rand(2600, 4800), rand(2000, 3000), 0.08, 0.07 * volume, 0.08 + i * rand(0.04, 0.09));
  }

  /** összedőlő épület: hosszú morajlás, lezuhanó falak, guruló törmelék */
  collapse(volume = 1): void {
    this.noise(1.7, 520, 45, 1.0 * volume, { attack: 0.08 });
    this.tone('sine', 62, 26, 1.3, 0.55 * volume);
    for (let i = 0; i < 5; i++) this.noise(rand(0.18, 0.34), rand(700, 1700), 130, 0.5 * volume, { delay: 0.1 + i * rand(0.14, 0.26) });
    for (let i = 0; i < 8; i++) this.noise(0.05, rand(1500, 4200), 800, 0.2 * volume, { type: 'bandpass', q: 3, delay: 0.5 + i * rand(0.08, 0.17) });
  }

  /** megsemmisülő telepített ágyú */
  turretDown(volume = 1): void {
    this.explosion(volume, 0.9);
    this.clang(420 * vary(0.1), 0.2 * volume, 0.08, 0.4);
  }

  ricochet(volume = 1): void {
    const k = vary(0.25);
    this.tone('sine', 2600 * k, 650 * k, 0.2, 0.28 * volume);
    this.noise(0.05, 6000, 3000, 0.15 * volume, { type: 'highpass' });
  }

  // --- a saját tankkal történtek -------------------------------------------------------

  /** találat a saját tankon; absorbed: pajzs vagy sebezhetetlenség fogta fel */
  hit(absorbed: boolean): void {
    if (absorbed) {
      this.tone('sine', 1500, 2300, 0.18, 0.32);
      this.tone('sine', 2250, 3000, 0.14, 0.14, 0.03);
      return;
    }
    const k = vary(0.1);
    this.noise(0.2, 2000 * k, 180, 0.75);
    this.tone('square', 190 * k, 64, 0.16, 0.3);
    this.clang(560 * k, 0.2, 0.01, 0.28);
  }

  /** a saját lövésem eltalált valakit: rövid, magas koppanás */
  hitMarker(absorbed: boolean): void {
    if (absorbed) this.tone('sine', 1700, 2100, 0.1, 0.16);
    else {
      this.tone('square', 1250, 880, 0.06, 0.16);
      this.noise(0.05, 4200, 1800, 0.14, { type: 'bandpass', q: 2 });
    }
  }

  /** kilőttem egy tankot: két fényes hang */
  kill(): void {
    this.tone('triangle', 880, 884, 0.12, 0.3, 0.12);
    this.tone('triangle', 1320, 1326, 0.3, 0.3, 0.24);
    this.tone('sine', 2640, 2650, 0.25, 0.08, 0.24);
  }

  /** kilőttek: lefelé csúszó, elhaló hang */
  death(): void {
    this.tone('sawtooth', 420, 70, 0.9, 0.22, 0.15);
    this.tone('square', 210, 35, 1.0, 0.16, 0.15);
  }

  /** újraéledés: felfelé söprő hang */
  respawn(): void {
    this.noise(0.45, 400, 4200, 0.22, { type: 'bandpass', q: 1.2, attack: 0.08 });
    this.tone('sine', 330, 990, 0.4, 0.22);
    this.tone('triangle', 660, 1320, 0.25, 0.16, 0.22);
  }

  /** kevés az életerő: három rövid figyelmeztető hang */
  lowHp(): void {
    for (let i = 0; i < 3; i++) this.tone('square', 760, 740, 0.09, 0.2, i * 0.16);
  }

  bump(): void {
    const k = vary(0.15);
    this.noise(0.14, 520 * k, 80, 0.6);
    this.tone('sine', 110 * k, 50, 0.12, 0.35);
  }

  /** megcsúszás az olajon */
  skid(): void {
    this.noise(0.75, 2400, 520, 0.5, { type: 'bandpass', q: 1.6 });
    this.tone('sawtooth', 900, 520, 0.6, 0.06);
  }

  /** a gyorsító bekapcsol: felpörgő turbina */
  boost(): void {
    this.noise(0.5, 500, 3000, 0.28, { type: 'bandpass', q: 1.5, attack: 0.06 });
    this.tone('sawtooth', 140, 330, 0.45, 0.12);
  }

  /** a gyorsító túlmelegedett: sziszegő gőz */
  overheat(): void {
    this.noise(0.9, 6000, 1400, 0.4, { type: 'highpass' });
    this.tone('sawtooth', 520, 130, 0.5, 0.2);
  }

  /** olajfolt lerakása: cuppanó, bugyogó hang */
  oilDrop(): void {
    this.tone('sine', 320, 70, 0.22, 0.4);
    this.tone('sine', 180, 260, 0.1, 0.25, 0.16);
    this.noise(0.2, 700, 120, 0.3);
  }

  /** ágyú telepítése: csörlő kattogása, majd a talp lecsapódik */
  deploy(): void {
    for (let i = 0; i < 4; i++) this.tone('square', 300 + i * 40, 280 + i * 40, 0.03, 0.14, i * 0.05);
    this.clang(260, 0.3, 0.24, 0.3);
    this.noise(0.14, 700, 90, 0.5, { delay: 0.24 });
  }

  // --- tárgyak, fejlődés ----------------------------------------------------------------

  /** tárgy felvétele: a fajtájától függő hang */
  pickup(kind: PickupKind): void {
    switch (kind) {
      case 'repair':
        // javítás: meleg, emelkedő hármashangzat és csavarkulcs kattanása
        [440, 554, 659, 880].forEach((f, i) => this.tone('sine', f, f * 1.005, 0.22, 0.26, i * 0.07));
        this.noise(0.04, 3000, 1500, 0.2, { type: 'bandpass', q: 3 });
        break;
      case 'heavy':
      case 'rocket':
      case 'laser':
        // fegyver: lőszer becsúszik, a zár kattan
        this.noise(0.12, 900, 2600, 0.3, { type: 'bandpass', q: 2 });
        this.clang(340, 0.3, 0.12, 0.2);
        this.tone('square', 150, 120, 0.06, 0.22, 0.2);
        break;
      case 'triple':
      case 'rapid':
      case 'ricochet':
        // lőszerfajta, tűzgyorsaság: három gyors kattanás
        for (let i = 0; i < 3; i++) this.clang(520 + i * 130, 0.2, i * 0.06, 0.1);
        break;
      case 'shield':
      case 'invulnerable':
        // védelem: felfelé csillogó hang
        this.tone('sine', 700, 1900, 0.4, 0.26);
        this.tone('sine', 1050, 2850, 0.4, 0.13, 0.04);
        this.noise(0.4, 3000, 7000, 0.1, { type: 'highpass', attack: 0.1 });
        break;
      case 'speed':
      case 'allTerrain':
        this.noise(0.4, 500, 3400, 0.3, { type: 'bandpass', q: 1.4, attack: 0.05 });
        this.tone('sawtooth', 180, 420, 0.32, 0.13);
        break;
      case 'radar':
        // szonárhang visszhanggal
        this.tone('sine', 1250, 1240, 0.3, 0.3);
        this.tone('sine', 1250, 1240, 0.3, 0.12, 0.28);
        this.tone('sine', 1250, 1240, 0.3, 0.05, 0.56);
        break;
      case 'oil':
        this.tone('sine', 260, 90, 0.2, 0.35);
        this.tone('sine', 150, 230, 0.1, 0.25, 0.15);
        break;
      case 'turret':
      case 'mine':
        this.clang(300, 0.28, 0, 0.18);
        this.clang(450, 0.24, 0.12, 0.22);
        break;
      case 'gun':
        // géppuska: a heveder becsúszik, a závár kétszer kattan
        this.noise(0.14, 1200, 3200, 0.3, { type: 'bandpass', q: 2 });
        this.clang(620, 0.24, 0.14, 0.08);
        this.clang(480, 0.26, 0.24, 0.1);
        break;
      case 'smoke':
        this.noise(0.45, 5000, 1800, 0.28, { type: 'highpass', attack: 0.05 });
        this.clang(380, 0.2, 0, 0.15);
        break;
      case 'super':
        // szupertárgy: felfelé futó, csillogó hangsor
        [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone('triangle', f, f * 1.01, i === 4 ? 0.5 : 0.1, 0.3, i * 0.07));
        this.noise(0.7, 3000, 9000, 0.14, { type: 'highpass', attack: 0.1 });
        this.tone('sine', 130, 260, 0.6, 0.2);
        break;
    }
  }

  /** szintlépés: három emelkedő hang */
  levelUp(): void {
    [587, 740, 880].forEach((f, i) => this.tone('triangle', f, f * 1.01, i === 2 ? 0.28 : 0.11, 0.3, i * 0.09));
    this.tone('sine', 1760, 1770, 0.3, 0.08, 0.18);
  }

  /** új tanktípus: harsonaszó */
  fanfare(): void {
    [523, 659, 784, 1047].forEach((f, i) => {
      this.tone('triangle', f, f * 1.01, i === 3 ? 0.5 : 0.14, 0.32, i * 0.12);
      this.tone('sawtooth', f / 2, f / 2, i === 3 ? 0.5 : 0.14, 0.1, i * 0.12);
    });
    this.noise(0.6, 2000, 8000, 0.1, { type: 'highpass', delay: 0.36, attack: 0.05 });
  }

  // --- a pálya hangjai ------------------------------------------------------------------

  /** kidőlő fa vagy oszlop reccsenése */
  crack(volume = 1): void {
    const k = vary(0.2);
    this.noise(0.24, 2800 * k, 240, 0.6 * volume);
    this.tone('triangle', 250 * k, 85, 0.22, 0.24 * volume);
    this.noise(0.05, 4000, 1500, 0.25 * volume, { type: 'bandpass', q: 3, delay: 0.08 });
    this.noise(0.3, 500, 100, 0.3 * volume, { delay: 0.2 });
  }

  /** autóduda: két rövid jelzés; a hangmagassága autónként más */
  honk(volume = 1): void {
    const k = [0.84, 1, 1.19][Math.floor(Math.random() * 3)];
    for (const delay of [0, 0.26]) {
      this.tone('square', 392 * k, 388 * k, 0.18, 0.13 * volume, delay);
      this.tone('square', 494 * k, 490 * k, 0.18, 0.11 * volume, delay);
    }
  }

  /** összelapuló jármű, recsegő fal: gyűrődő fém, törmelék */
  crunch(volume = 1): void {
    const k = vary(0.2);
    this.noise(0.32, 1900 * k, 150, 0.8 * volume);
    this.tone('sawtooth', 170 * k, 48, 0.26, 0.24 * volume);
    this.noise(0.06, rand(2400, 4400), 1000, 0.25 * volume, { type: 'bandpass', q: 3, delay: rand(0.06, 0.14) });
  }

  // --- akna, füst, tüzérség ---------------------------------------------------------------

  /** a kiegészítő géppuska egy lövése: rövid, száraz kattanás */
  mg(volume = 1): void {
    const k = vary(0.08);
    this.noise(0.05, 3800 * k, 900, 0.34 * volume, { type: 'bandpass', q: 1.2 });
    this.tone('square', 300 * k, 120 * k, 0.04, 0.12 * volume);
  }

  /** géppuskatalálat a saját tankon: apró koppanás a páncélon */
  ping(): void {
    this.tone('triangle', 1700 * vary(0.2), 900, 0.05, 0.12);
  }

  /** javítás a műhelyben: racsnis kulcs kattogása, egy-egy fémes koppanással */
  wrench(): void {
    for (let i = 0; i < 3; i++) this.tone('square', 900 + i * 60, 880 + i * 60, 0.025, 0.1, i * 0.05);
    this.clang(700 * vary(0.15), 0.12, 0.2, 0.12);
  }

  /** szintvesztés: lefelé lépő két hang */
  levelDown(): void {
    this.tone('triangle', 440, 436, 0.16, 0.22, 0.5);
    this.tone('triangle', 311, 306, 0.3, 0.22, 0.68);
  }

  /** akna lerakása: tompa koppanás, majd az élesítés két csipogása */
  mineLay(): void {
    this.noise(0.1, 600, 90, 0.5);
    this.tone('square', 1500, 1490, 0.05, 0.14, 0.5);
    this.tone('square', 1900, 1890, 0.07, 0.14, 0.62);
  }

  /** kiáramló füst sziszegése */
  smokeHiss(volume = 1): void {
    this.noise(1.3, 7000, 1500, 0.4 * volume, { type: 'highpass', attack: 0.06 });
    this.noise(0.12, 900, 150, 0.4 * volume);
  }

  /** tüzérségi csapás érkezik: süvítő, ereszkedő hang */
  incoming(volume = 1): void {
    this.tone('sawtooth', 1700, 380, 1.9, 0.16 * volume);
    this.tone('sine', 2300, 520, 1.9, 0.14 * volume, 0.08);
    this.noise(1.9, 4500, 700, 0.16 * volume, { type: 'bandpass', q: 3, attack: 0.3 });
  }

  /** a tüzérségi csapás kérése rádión: rövid sercegés és két hang */
  radio(): void {
    this.noise(0.16, 3000, 2600, 0.2, { type: 'bandpass', q: 5 });
    this.tone('square', 990, 985, 0.08, 0.16, 0.14);
    this.tone('square', 1320, 1315, 0.12, 0.16, 0.24);
  }

  /** kilövéssorozat: tüzérségi csapás jár */
  streak(): void {
    [392, 523, 659].forEach((f, i) => this.tone('sawtooth', f, f, 0.14, 0.18, i * 0.1));
    this.tone('triangle', 784, 790, 0.4, 0.3, 0.3);
    this.noise(0.25, 300, 90, 0.4, { delay: 0.3 });
  }

  /** álcázás be: lefelé hulló, elhalkuló zizegés; ki: ugyanez visszafelé */
  cloak(on: boolean): void {
    if (on) {
      this.tone('sine', 1400, 260, 0.5, 0.2);
      this.noise(0.55, 6000, 900, 0.2, { type: 'bandpass', q: 4, attack: 0.03 });
    } else {
      this.tone('sine', 300, 1100, 0.3, 0.16);
      this.noise(0.3, 900, 5000, 0.14, { type: 'bandpass', q: 4, attack: 0.05 });
    }
  }

  /** bejelentés: szupertárgy érkezik (mindenkinek szól) */
  announce(): void {
    this.tone('triangle', 784, 784, 0.14, 0.28);
    this.tone('triangle', 1047, 1047, 0.14, 0.28, 0.16);
    this.tone('triangle', 784, 784, 0.14, 0.28, 0.32);
    this.tone('triangle', 1047, 1047, 0.3, 0.28, 0.48);
  }

  /** bosszú: megjelölték, aki kilőtt */
  revenge(): void {
    this.tone('sawtooth', 220, 110, 0.35, 0.22);
    this.tone('square', 330, 165, 0.35, 0.14, 0.05);
  }

  // --- az óra ---------------------------------------------------------------------------

  /** az utolsó másodpercek kattogása; last: az utolsó három másodperc magasabban szól */
  tick(last: boolean): void {
    this.tone('square', last ? 1320 : 880, last ? 1300 : 870, 0.07, 0.2);
  }

  /** figyelmeztetés: fél perc (vagy egy perc) van hátra */
  warning(): void {
    this.tone('triangle', 660, 655, 0.16, 0.26);
    this.tone('triangle', 660, 655, 0.16, 0.26, 0.24);
  }

  /** lejárt az idő: hosszú kürtszó */
  finish(): void {
    this.tone('sawtooth', 196, 194, 1.1, 0.22);
    this.tone('sawtooth', 294, 291, 1.1, 0.16);
    this.tone('square', 98, 97, 1.1, 0.14);
  }
}
