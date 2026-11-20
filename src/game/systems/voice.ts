// Hangos beszélgetés gombnyomásra (adóvevő), a saját szerveren keresztül.
//
// A beszélő böngészője a gomb nyomva tartása alatt felveszi a mikrofont,
// 12 kHz-re ritkítja, 8 bites μ-law mintákká tömöríti, és 50 ezredmásodperces
// darabokban (base64-ben) elküldi a szervernek; az továbbadja a szobatársaknak.
// A hallgató oldalán a darabok kis késleltetéssel (a hálózat egyenetlenségeinek
// kiegyenlítésére) egymás után szólalnak meg, rádiószerű szűrővel.
// Nincs külső szolgáltatás, és a játékosok nem látják egymás hálózati címét.

import { VOICE } from '../net/protocol';

const MU = 255;
const LOG_MU = Math.log(1 + MU);

/** μ-law tömörítés: a −1..1 közötti minták 8 bitre (a halk részek finomabb felbontásával). */
export function encodeMulaw(samples: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    const y = (Math.sign(x) * Math.log(1 + MU * Math.abs(x))) / LOG_MU;
    out[i] = Math.round(((y + 1) / 2) * 255);
  }
  return out;
}

export function decodeMulaw(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const y = (bytes[i] / 255) * 2 - 1;
    out[i] = (Math.sign(y) * (Math.pow(1 + MU, Math.abs(y)) - 1)) / MU;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Mintavétel-csökkentés átlagolással (a bemenet tetszőleges darabokban érkezhet). */
export class Downsampler {
  private readonly ratio: number;
  private pos = 0;
  private sum = 0;
  private count = 0;

  constructor(fromRate: number, toRate: number) {
    this.ratio = Math.max(1, fromRate / toRate);
  }

  push(input: ArrayLike<number>, out: number[]): void {
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.pos++;
      if (this.pos >= this.ratio) {
        out.push(this.sum / this.count);
        this.pos -= this.ratio;
        this.sum = 0;
        this.count = 0;
      }
    }
  }
}

export type VoiceStart = 'ok' | 'denied' | 'unsupported';

interface Speaker {
  /** a következő darab kezdete a hangkimenet idővonalán (mp) */
  next: number;
  /** az utolsó darab érkezése (ms) */
  last: number;
}

/** Ennyi késleltetéssel indul a lejátszás, hogy az egyenetlenül érkező darabok ne akadjanak (mp). */
const JITTER = 0.11;
/** Ha a lejátszás ennyivel lemaradt, a darab kimarad, hogy a késés ne halmozódjon (mp). */
const MAX_LAG = 0.7;

export class Voice {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private stream: MediaStream | null = null;
  private asking: Promise<VoiceStart> | null = null;
  private down: Downsampler | null = null;
  private readonly pending: number[] = [];
  private readonly speakers = new Map<string, Speaker>();
  private level = 1;
  /** éppen beszélünk-e (a gomb nyomva van, és megy a felvétel) */
  talking = false;
  private wanted = false;

  constructor(private readonly send: (data: string) => void) {}

  /** A hanghoz mikrofon és biztonságos (https vagy localhost) kapcsolat kell. */
  get supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
  }

  setVolume(volume: number): void {
    this.level = Math.max(0, Math.min(1, volume));
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(this.level * 1.6, this.ctx.currentTime, 0.03);
  }

  private audio(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    this.ctx = ctx;
    // rádiószerű hang: a beszéd sávja megy át (ez a tömörítés zaját is tompítja)
    this.out = ctx.createGain();
    this.out.gain.value = this.level * 1.6;
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 260;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 3800;
    this.out.connect(high).connect(low).connect(ctx.destination);
    return ctx;
  }

  /** Rövid rádiójel: jelzi, hogy valaki beszélni kezdett, illetve befejezte. */
  private blip(from: number, to: number): void {
    const ctx = this.audio();
    if (!ctx || !this.out) return;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(from, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + 0.07);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.07, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.connect(gain).connect(this.out);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
  }

  /** A mikrofon megnyitása (az első gombnyomáskor a böngésző engedélyt kér); utána nyitva marad a meccs végéig. */
  private open(): Promise<VoiceStart> {
    if (this.stream) return Promise.resolve('ok');
    if (!this.supported) return Promise.resolve('unsupported');
    this.asking ??= navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
      .then((stream): VoiceStart => {
        const ctx = this.audio();
        if (!ctx) return 'unsupported';
        this.stream = stream;
        this.down = new Downsampler(ctx.sampleRate, VOICE.rate);
        const source = ctx.createMediaStreamSource(stream);
        const tap = ctx.createScriptProcessor(2048, 1, 1);
        tap.onaudioprocess = (ev) => {
          if (this.talking) this.capture(ev.inputBuffer.getChannelData(0));
        };
        // a feldolgozó csak akkor fut, ha a kimenetre van kötve: némítva kötjük be
        const mute = ctx.createGain();
        mute.gain.value = 0;
        source.connect(tap);
        tap.connect(mute).connect(ctx.destination);
        return 'ok';
      })
      .catch((): VoiceStart => 'denied')
      .finally(() => {
        this.asking = null;
      });
    return this.asking;
  }

  /** A beszéd kezdete (a gomb lenyomása). */
  async start(): Promise<VoiceStart> {
    this.wanted = true;
    const result = await this.open();
    // ha közben elengedték a gombot (pl. az engedélykérés alatt), nem indul felvétel
    if (result !== 'ok' || !this.wanted || this.talking) return result;
    this.pending.length = 0;
    this.talking = true;
    this.blip(1150, 1500);
    return result;
  }

  /** A beszéd vége (a gomb elengedése): a maradék hang is elmegy. */
  stop(): void {
    this.wanted = false;
    if (!this.talking) return;
    this.talking = false;
    if (this.pending.length > 60) this.flush(this.pending.length);
    this.pending.length = 0;
    this.blip(1300, 900);
  }

  private capture(input: Float32Array): void {
    if (!this.down) return;
    this.down.push(input, this.pending);
    while (this.pending.length >= VOICE.frame) this.flush(VOICE.frame);
  }

  private flush(count: number): void {
    const samples = this.pending.splice(0, count);
    // enyhe erősítés: a mikrofonok többsége halk
    for (let i = 0; i < samples.length; i++) samples[i] *= 1.6;
    this.send(toBase64(encodeMulaw(samples)));
  }

  /** Egy szobatárs hangdarabja: a sorban következő helyre kerül a lejátszásban. */
  receive(from: string, data: string): void {
    const ctx = this.audio();
    if (!ctx || !this.out) return;
    let samples: Float32Array;
    try {
      samples = decodeMulaw(fromBase64(data));
    } catch {
      return;
    }
    if (samples.length === 0 || samples.length > VOICE.frame * 4) return;
    const now = ctx.currentTime;
    let speaker = this.speakers.get(from);
    if (!speaker) {
      speaker = { next: 0, last: -Infinity };
      this.speakers.set(from, speaker);
    }
    if (performance.now() - speaker.last > VOICE.quiet) this.blip(950, 1250);
    speaker.last = performance.now();
    // új megszólalás (vagy kifogyott a sor): kis késleltetéssel indul; ha nagyon lemaradt, a darab kimarad
    if (speaker.next < now + 0.02) speaker.next = now + JITTER;
    else if (speaker.next > now + MAX_LAG) return;
    const buffer = ctx.createBuffer(1, samples.length, VOICE.rate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.out);
    source.start(speaker.next);
    speaker.next += buffer.duration;
  }

  /** Akik éppen beszélnek (az utolsó darabjuk nemrég érkezett). */
  active(): string[] {
    const now = performance.now();
    const names: string[] = [];
    for (const [name, speaker] of this.speakers) if (now - speaker.last < VOICE.quiet + 250) names.push(name);
    return names;
  }

  /** A mikrofon elengedése (a meccs végén). */
  close(): void {
    this.stop();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }
}
