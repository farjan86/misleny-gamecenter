// Egyjátékos mód szerver nélkül: ugyanaz a szobakezelő és meccslogika fut a
// böngészőben, amely a szerveren – csak éppen egyetlen, helyi „kapcsolattal”.
// A játékjelenet így semmit nem vesz észre a különbségből: ugyanazokat az
// üzeneteket küldi és kapja, hálózat helyett közvetlenül.

import { Lobby } from '../../../server/lobby';
import type { MapData } from '../maps/types';
import type { MatchSettings } from '../sim/match';
import { encode, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from './protocol';

/** Amit a meccs tükre (ClientWorld) a kapcsolattól kér – a szerverkapcsolat és a helyi játék is tudja. */
export interface GameLink {
  send(message: ClientMessage): void;
  /** a válaszidő ezredmásodpercben */
  readonly ping: number;
}

export class LocalGame implements GameLink {
  readonly ping = 0;
  /** a helyi játékos azonosítója a meccsben */
  id = '';
  private readonly lobby: Lobby;
  private readonly session: { message(text: string): void; close(): void };
  private readonly handlers = new Set<(message: ServerMessage) => void>();
  private timer = 0;

  constructor(mapData: MapData, name: string) {
    // visszaszámlálás nélkül indul
    this.lobby = new Lobby(mapData, 0);
    this.session = this.lobby.connect({
      send: (text) => {
        const message = JSON.parse(text) as ServerMessage;
        if (message.t === 'welcome') this.id = message.id;
        for (const handler of this.handlers) handler(message);
      },
      close: () => undefined,
    });
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name });
  }

  on(handler: (message: ServerMessage) => void): void {
    this.handlers.add(handler);
  }

  send(message: ClientMessage): void {
    this.session.message(encode(message));
  }

  /** A játék indítása a megadott beállításokkal (egy játékos, azonnal indul). */
  start(settings: MatchSettings): void {
    this.send({ t: 'create', settings: { ...settings, maxPlayers: 1 } });
    // a szimuláció a ténylegesen eltelt idő szerint halad; háttérbe tett lapon a böngésző lassítja
    this.timer = window.setInterval(() => this.lobby.tick(performance.now()), 4);
    this.lobby.tick(performance.now());
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.session.close();
  }
}
