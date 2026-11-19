// Kapcsolat a játékszerverrel (WebSocket). A szerver ugyanarról a címről érhető
// el, ahonnan a játék oldala betöltődött (/ws) – fejlesztés közben a Vite
// továbbítja a kérést a helyben futó szervernek.

import { encode, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from './protocol';

export type NetStatus = 'connecting' | 'online' | 'offline';

type Handler = (message: ServerMessage) => void;

export function serverUrl(): string {
  const override = new URLSearchParams(window.location.search).get('server');
  if (override) return override;
  const secure = window.location.protocol === 'https:';
  return `${secure ? 'wss' : 'ws'}://${window.location.host}/ws`;
}

export class NetClient {
  private socket: WebSocket | null = null;
  private readonly handlers = new Set<Handler>();
  private readonly statusHandlers = new Set<(status: NetStatus) => void>();
  status: NetStatus = 'offline';
  /** a szervertől kapott azonosító */
  id = '';
  /** a legutóbb mért válaszidő ezredmásodpercben */
  ping = 0;
  private pingTimer = 0;

  constructor(private readonly url = serverUrl()) {}

  /** a belépett fiók neve és a belépve maradás kulcsa (üres, amíg nincs belépve) */
  name = '';
  token = '';
  private pendingAuth: ClientMessage | null = null;

  get authed(): boolean {
    return this.name !== '';
  }

  login(name: string, password: string): void {
    this.authenticate({ t: 'login', v: PROTOCOL_VERSION, name, password });
  }

  register(name: string, password: string): void {
    this.authenticate({ t: 'register', v: PROTOCOL_VERSION, name, password });
  }

  /** Belépés a böngészőben megőrzött kulccsal. */
  resume(token: string): void {
    this.authenticate({ t: 'resume', v: PROTOCOL_VERSION, token });
  }

  logout(): void {
    this.send({ t: 'logout' });
    this.name = '';
    this.token = '';
  }

  private authenticate(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send(message);
      return;
    }
    this.pendingAuth = message;
    this.connect();
  }

  /** Csatlakozás a szerverhez; ha már él a kapcsolat, nem tesz semmit. */
  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.setStatus('offline');
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.setStatus('online');
      if (this.pendingAuth) this.send(this.pendingAuth);
      this.pendingAuth = null;
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: Math.round(performance.now()) }), 2000);
    };
    socket.onmessage = (ev) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.t === 'welcome') this.id = message.id;
      else if (message.t === 'auth') {
        this.name = message.name;
        this.token = message.token;
      }
      else if (message.t === 'pong') {
        this.ping = Math.max(0, Math.round(performance.now() - message.c));
        return;
      }
      for (const handler of this.handlers) handler(message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.name = '';
      window.clearInterval(this.pingTimer);
      this.setStatus('offline');
    };
    socket.onerror = () => socket.close();
  }

  private setStatus(status: NetStatus): void {
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encode(message));
  }

  /** Feliratkozás a szerver üzeneteire; a visszaadott függvény leiratkozik. */
  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler: (status: NetStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  close(): void {
    this.socket?.close();
  }
}
