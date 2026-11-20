// A hang tömörítése és ritkítása (a böngésző nélküli, tiszta számolás).

import { describe, expect, it } from 'vitest';
import { VOICE } from '../src/game/net/protocol';
import { decodeMulaw, Downsampler, encodeMulaw, fromBase64, toBase64 } from '../src/game/systems/voice';

describe('hang: tömörítés', () => {
  it('a μ-law tömörítés után a hang közel azonos marad (a halk részek is)', () => {
    const samples = new Float32Array(VOICE.frame);
    for (let i = 0; i < samples.length; i++) samples[i] = 0.6 * Math.sin((i / VOICE.rate) * 2 * Math.PI * 440) + 0.02 * Math.sin(i * 0.9);
    const bytes = encodeMulaw(samples);
    expect(bytes).toHaveLength(VOICE.frame);
    const back = decodeMulaw(bytes);
    let error = 0;
    let power = 0;
    for (let i = 0; i < samples.length; i++) {
      error += (samples[i] - back[i]) ** 2;
      power += samples[i] ** 2;
    }
    // a jel–zaj arány jóval 30 dB fölött van
    expect(10 * Math.log10(power / error)).toBeGreaterThan(30);
    // halk hang (a teljes hangerő 1%-a) sem vész el
    const quiet = decodeMulaw(encodeMulaw([0.01, -0.01, 0.005]));
    expect(quiet[0]).toBeGreaterThan(0.007);
    expect(quiet[1]).toBeLessThan(-0.007);
    expect(quiet[2]).toBeGreaterThan(0.003);
    // a határon túli érték levágódik
    expect(decodeMulaw(encodeMulaw([5, -5]))[0]).toBeCloseTo(1, 2);
    expect(decodeMulaw(encodeMulaw([5, -5]))[1]).toBeCloseTo(-1, 2);
  });

  it('a base64 kódolás oda-vissza ugyanazt adja, és egy darab belefér a szerver korlátjába', () => {
    const bytes = new Uint8Array(VOICE.frame).map((_, i) => (i * 37) % 256);
    const text = toBase64(bytes);
    expect(text).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(text.length).toBeLessThanOrEqual(VOICE.maxChars);
    expect([...fromBase64(text)]).toEqual([...bytes]);
    // egy darab 50 ezredmásodperc: másodpercenként húsz megy, ez a szerver korlátja alatt van
    expect(VOICE.rate / VOICE.frame).toBe(20);
    expect(VOICE.rate / VOICE.frame).toBeLessThan(VOICE.maxPerSecond);
  });

  it('a ritkítás a mikrofon mintavételéről 12 kHz-re visz, akármilyen darabokban érkezik a hang', () => {
    for (const rate of [48000, 44100, 16000]) {
      const down = new Downsampler(rate, VOICE.rate);
      const out: number[] = [];
      // egy másodpercnyi hang, egyenetlen darabokban
      let left = rate;
      while (left > 0) {
        const n = Math.min(left, 2048);
        down.push(new Float32Array(n).fill(0.5), out);
        left -= n;
      }
      expect(Math.abs(out.length - VOICE.rate)).toBeLessThanOrEqual(2);
      // az állandó jel átlagolva is állandó marad
      expect(out.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
    }
  });
});
