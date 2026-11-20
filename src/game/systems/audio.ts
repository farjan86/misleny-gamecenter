// Egyszerű, szintetizált hangok a Web Audio API-val (nincs hangfájl).
// A böngészők csak felhasználói művelet után engednek hangot, ezért az
// AudioContext az első billentyű- vagy egérlenyomáskor jön létre.

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  muted = false;

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
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // motorhang: folyamatos, a sebességgel változó mély zúgás
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 42;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 260;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineOsc.connect(filter).connect(this.engineGain).connect(this.master);
    this.engineOsc.start();
  }

  /** ratio: 0 (áll) .. 1 (végsebesség) */
  engine(ratio: number): void {
    if (!this.ctx || !this.engineOsc || !this.engineGain) return;
    const now = this.ctx.currentTime;
    this.engineOsc.frequency.setTargetAtTime(42 + ratio * 46, now, 0.08);
    this.engineGain.gain.setTargetAtTime(this.muted ? 0 : 0.05 + ratio * 0.07, now, 0.08);
  }

  private burst(duration: number, freqFrom: number, freqTo: number, volume: number): void {
    if (!this.ctx || !this.master || !this.noise || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freqFrom, now);
    filter.frequency.exponentialRampToValueAtTime(freqTo, now + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(now, Math.random() * 0.5, duration);
  }

  /** volume: 0..1 – távoli lövés halkabb */
  shot(volume = 1): void {
    this.burst(0.18, 3200, 300, 0.7 * volume);
    if (!this.ctx || !this.master || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.14);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.25 * volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  /** volume: 0..1, a kamerától mért távolság szerint */
  explosion(volume = 1): void {
    this.burst(0.45, 1400, 80, 0.9 * volume);
  }

  bump(): void {
    this.burst(0.12, 500, 90, 0.5);
  }

  /** Egyszerű hangjegy: frekvencia-csúszás a megadott hullámformával. */
  private tone(type: OscillatorType, from: number, to: number, duration: number, volume: number, delay = 0): void {
    if (!this.ctx || !this.master || this.muted) return;
    const start = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    osc.frequency.exponentialRampToValueAtTime(to, start + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.connect(gain).connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  laser(volume = 1): void {
    this.tone('sawtooth', 1800, 320, 0.22, 0.22 * volume);
    this.tone('square', 2600, 900, 0.12, 0.1 * volume);
  }

  rocket(volume = 1): void {
    this.burst(0.5, 900, 2600, 0.5 * volume);
    this.tone('sawtooth', 110, 60, 0.4, 0.2 * volume);
  }

  /** tárgy felvétele: két emelkedő hang */
  pickup(): void {
    this.tone('triangle', 660, 680, 0.1, 0.3);
    this.tone('triangle', 990, 1020, 0.16, 0.3, 0.09);
  }

  /** új tanktípus: négy emelkedő hang */
  fanfare(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone('triangle', f, f * 1.01, i === 3 ? 0.34 : 0.13, 0.32, i * 0.11));
  }

  ricochet(volume = 1): void {
    this.tone('sine', 2400, 700, 0.18, 0.25 * volume);
  }

  /** kidőlő fa vagy oszlop reccsenése */
  crack(volume = 1): void {
    this.burst(0.22, 2600, 240, 0.5 * volume);
    this.tone('triangle', 240, 90, 0.2, 0.2 * volume);
  }

  /** a gyorsító túlmelegedett */
  overheat(): void {
    this.burst(0.6, 5000, 900, 0.3);
    this.tone('sawtooth', 520, 140, 0.45, 0.16);
  }

  /** autóduda: két rövid, kéthangú jelzés */
  honk(volume = 1): void {
    for (const delay of [0, 0.26]) {
      this.tone('square', 392, 388, 0.18, 0.11 * volume, delay);
      this.tone('square', 494, 490, 0.18, 0.09 * volume, delay);
    }
  }

  /** összelapuló jármű: recsegő fém */
  crunch(volume = 1): void {
    this.burst(0.3, 1800, 160, 0.7 * volume);
    this.tone('sawtooth', 160, 50, 0.25, 0.2 * volume);
  }

  /** megcsúszás az olajon */
  skid(): void {
    this.burst(0.7, 2200, 500, 0.45);
  }

  /** találat; absorbed: pajzs vagy sebezhetetlenség fogta fel */
  hit(absorbed: boolean): void {
    if (absorbed) this.tone('sine', 1500, 2200, 0.16, 0.3);
    else {
      this.burst(0.16, 1800, 200, 0.6);
      this.tone('square', 180, 70, 0.14, 0.25);
    }
  }
}
