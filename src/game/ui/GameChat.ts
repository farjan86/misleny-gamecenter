// Játék közbeni üzenetek és a gombnyomásra menő hang felülete: az üzenetek a bal
// alsó sarokban jelennek meg és néhány másodperc múlva elhalványulnak; az Enter
// (a beállított billentyű) beviteli mezőt nyit, a beszéd gombja nyomva tartva
// adja a hangot. Csak többjátékos meccsen van.

import type { KeyBindings } from '../settings';
import { keysText } from '../settings';
import { CHAT } from '../net/protocol';
import type { Voice } from '../systems/voice';

/** Ezzel az eseménnyel kérjük a játékjelenetet, hogy engedje el a lenyomva tartott billentyűket (gépelés közben a tank ne menjen tovább). */
export const RELEASE_KEYS = 'tank:release-keys';

const LINE_LIFE = 9000;
const MAX_LINES = 7;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Hiányzó elem: #${id}`);
  return node as T;
}

export class GameChat {
  private readonly box = el<HTMLDivElement>('hud-chat');
  private readonly log = el<HTMLDivElement>('hud-chat-log');
  private readonly input = el<HTMLInputElement>('hud-chat-input');
  private readonly voiceBox = el<HTMLDivElement>('hud-voice');
  private voiceKey = '';
  private timer = 0;
  private talkDown = false;

  constructor(
    private readonly keys: KeyBindings,
    private readonly send: (text: string) => void,
    private readonly voice: Voice,
  ) {
    this.box.classList.remove('hidden');
    this.input.maxLength = CHAT.maxLength;
    this.input.placeholder = 'Üzenet a többieknek – Enter: küldés, Esc: mégsem';
    this.system(`${keysText(keys, 'chat')}: üzenet írása · ${keysText(keys, 'talk')} nyomva tartva: beszéd`);
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.release);
    this.input.addEventListener('blur', () => this.close());
    this.timer = window.setInterval(() => this.showVoice(), 150);
  }

  private get typing(): boolean {
    return document.activeElement === this.input;
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (this.typing) {
      // gépelés közben a billentyűk a mezőé: a játék nem kapja meg őket
      ev.stopPropagation();
      if (ev.code === 'Enter' || ev.code === 'NumpadEnter') {
        ev.preventDefault();
        const text = this.input.value.trim();
        if (text) this.send(text);
        this.close();
      } else if (ev.code === 'Escape') {
        ev.preventDefault();
        this.close();
      }
      return;
    }
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (this.keys.chat.includes(ev.code)) {
      ev.preventDefault();
      ev.stopPropagation();
      this.open();
    } else if (this.keys.talk.includes(ev.code) && !ev.repeat && !this.talkDown) {
      this.talkDown = true;
      void this.voice.start().then((result) => {
        if (result === 'denied') this.system('A mikrofon nincs engedélyezve – a böngésző címsoránál tudod engedélyezni.');
        else if (result === 'unsupported') this.system('A hangos beszélgetéshez mikrofon és biztonságos (https) kapcsolat kell.');
      });
    }
  };

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    if (this.keys.talk.includes(ev.code)) this.release();
  };

  /** A beszéd gombjának elengedése (az ablak elhagyásakor is). */
  private readonly release = (): void => {
    if (!this.talkDown) return;
    this.talkDown = false;
    this.voice.stop();
  };

  private open(): void {
    this.release();
    // gépelés közben a tank ne menjen tovább a lenyomva maradt gombok szerint
    window.dispatchEvent(new Event(RELEASE_KEYS));
    this.input.value = '';
    this.input.classList.remove('hidden');
    this.box.classList.add('typing');
    this.input.focus();
  }

  private close(): void {
    if (this.input.classList.contains('hidden')) return;
    this.input.classList.add('hidden');
    this.box.classList.remove('typing');
    this.input.blur();
  }

  private line(html: string, cls: string): void {
    const item = document.createElement('div');
    item.className = `chat-line ${cls}`;
    item.innerHTML = html;
    this.log.appendChild(item);
    while (this.log.children.length > MAX_LINES) this.log.firstElementChild?.remove();
    window.setTimeout(() => item.classList.add('old'), LINE_LIFE);
  }

  /** Egy játékos üzenete. */
  add(from: string, text: string, me: boolean): void {
    const esc = (value: string): string => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    this.line(`<b>${esc(from)}:</b> ${esc(text)}`, me ? 'me' : '');
  }

  /** A játék saját közlése (pl. a mikrofon nincs engedélyezve). */
  system(text: string): void {
    const item = document.createElement('span');
    item.textContent = text;
    this.line(item.outerHTML, 'system');
  }

  /** Ki beszél éppen: mi magunk, illetve a szobatársak. */
  private showVoice(): void {
    const parts: string[] = [];
    if (this.voice.talking) parts.push('🎙 Beszélsz…');
    const names = this.voice.active();
    if (names.length) parts.push(`🔊 ${names.join(', ')}`);
    const key = parts.join(' · ');
    if (key === this.voiceKey) return;
    this.voiceKey = key;
    this.voiceBox.textContent = key;
    this.voiceBox.classList.toggle('hidden', key === '');
    this.voiceBox.classList.toggle('talking', this.voice.talking);
  }

  dispose(): void {
    window.clearInterval(this.timer);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.release);
    this.voice.close();
  }
}
