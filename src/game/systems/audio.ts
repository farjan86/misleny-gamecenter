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

  shot(): void {
    this.burst(0.18, 3200, 300, 0.7);
    if (!this.ctx || !this.master || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.14);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.25, now);
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
}
