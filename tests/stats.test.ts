// A játéknapló: egy szöveges fájl, látogatásonként egy sorral (ki, mikor, mennyit volt bent és mennyit játszott).

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Accounts } from '../server/accounts';
import { Gate } from '../server/gate';
import { Lobby } from '../server/lobby';
import { GUEST, HEADER, stamp, StatsLog } from '../server/stats';
import type { MapData } from '../src/game/maps/types';
import { encode, PROTOCOL_VERSION, type ServerMessage } from '../src/game/net/protocol';

const dir = mkdtempSync(path.join(tmpdir(), 'tank-stats-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const linesOf = (file: string): string[] => readFileSync(file, 'utf8').replace(/^﻿/, '').trimEnd().split('\r\n');

describe('játéknapló', () => {
  it('látogatásonként egy sort ír: kezdet, vég, név, bent töltött idő, többjátékos és egyjátékos idő', () => {
    let now = new Date(2026, 10, 21, 20, 15, 3);
    const file = path.join(dir, 'napló', 'statisztika.txt');
    const log = new StatsLog(file, () => now);
    const pista = log.begin();
    const guest = log.begin();
    pista.name = 'Pista';
    // Pista 60 mp-ig többjátékos meccsen van, a vendég közben egyedül játszik
    for (let i = 0; i < 12; i++) log.sample(5, [pista, guest], new Set(['Pista']));
    guest.solo = true;
    for (let i = 0; i < 6; i++) log.sample(5, [pista, guest], new Set());
    // amíg valaki bent van, nincs sora (és a fájl sem jön létre)
    expect(existsSync(file)).toBe(false);
    now = new Date(2026, 10, 21, 20, 17, 3);
    log.end(guest);
    now = new Date(2026, 10, 21, 20, 47, 10);
    log.end(pista);
    expect(linesOf(file)).toEqual([HEADER, `2026-11-21 20:15:03;2026-11-21 20:17:03;${GUEST};120;0;30`, '2026-11-21 20:15:03;2026-11-21 20:47:10;Pista;1927;60;0']);
    // a fájl elején ott az ékezetekhez kellő jelölés, a sorvég Windows-os
    expect(readFileSync(file, 'utf8').startsWith(`﻿${HEADER}\r\n`)).toBe(true);

    // új szerverindítás: ugyanabba a fájlba ír tovább, a fejléc nem ismétlődik
    const later = new StatsLog(file, () => now);
    const anna = later.begin();
    anna.name = 'An;na';
    anna.solo = true;
    later.sample(500, [anna], new Set());
    now = new Date(2026, 10, 21, 20, 48, 10);
    later.end(anna);
    const lines = linesOf(file);
    expect(lines).toHaveLength(4);
    // a pontosvessző a névben nem törheti el az oszlopokat; a játékidő nem lehet több a bent töltöttnél
    expect(lines[3]).toBe('2026-11-21 20:47:10;2026-11-21 20:48:10;An,na;60;0;60');
    // az egy másodpercnél rövidebb látogatás kimarad
    later.end(later.begin());
    expect(linesOf(file)).toHaveLength(4);
    expect(stamp(new Date(2026, 0, 5, 7, 8, 9))).toBe('2026-01-05 07:08:09');
  });

  it('a szerver kapuja vezeti a látogatásokat: vendég egyjátékos meccse, belépett játékos többjátékos meccse', async () => {
    const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;
    let now = new Date(2026, 10, 21, 21, 0, 0);
    const file = path.join(dir, 'kapu.txt');
    const lobby = new Lobby(data, 0);
    const gate = new Gate(lobby, new Accounts(path.join(dir, 'accounts.json')), new StatsLog(file, () => now));
    const connect = (): { inbox: ServerMessage[]; session: ReturnType<Gate['connect']> } => {
      const inbox: ServerMessage[] = [];
      return { inbox, session: gate.connect({ send: (text) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined }) };
    };
    const guest = connect();
    const anna = connect();
    const idle = connect();
    anna.session.message(encode({ t: 'register', v: PROTOCOL_VERSION, name: 'Anna', password: 'titkos-jelszo' }));
    for (let i = 0; i < 300 && !anna.inbox.some((m) => m.t === 'auth'); i++) await new Promise((done) => setTimeout(done, 10));
    expect(anna.inbox.some((m) => m.t === 'auth')).toBe(true);
    // a menüben töltött idő nem játékidő
    gate.sample(10);
    // a vendég belépés nélkül indít egyjátékos meccset; Anna egyfős játékot hoz létre a szerveren
    guest.session.message(encode({ t: 'solo' }));
    lobby.tick(0);
    anna.session.message(encode({ t: 'create', settings: { area: { minX: 500, minY: 500, maxX: 1000, maxY: 1000 }, bots: 0, pickups: 0, traffic: 0, minutes: 5, maxPlayers: 1 } }));
    for (let t = 1; t < 12000 && !anna.inbox.some((m) => m.t === 'start'); t += 100) lobby.tick(t);
    expect(lobby.playingNames()).toEqual(new Set(['Anna']));
    for (let i = 0; i < 6; i++) gate.sample(5);
    now = new Date(2026, 10, 21, 21, 0, 45);
    guest.session.close();
    anna.session.close();
    expect(linesOf(file)).toEqual([HEADER, `2026-11-21 21:00:00;2026-11-21 21:00:45;${GUEST};45;0;30`, '2026-11-21 21:00:00;2026-11-21 21:00:45;Anna;45;30;0']);
    // leálláskor a még bent lévő látogatása is kiíródik – de csak egyszer
    now = new Date(2026, 10, 21, 21, 1, 0);
    gate.flush();
    gate.flush();
    idle.session.close();
    const lines = linesOf(file);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe(`2026-11-21 21:00:00;2026-11-21 21:01:00;${GUEST};60;0;0`);
  });

  it('napló nélkül a kapu ugyanúgy működik', () => {
    const data = JSON.parse(readFileSync(new URL('../assets/maps/processed/misleny-kozpont.json', import.meta.url), 'utf8')) as MapData;
    const gate = new Gate(new Lobby(data, 0), new Accounts(path.join(dir, 'accounts2.json')));
    const session = gate.connect({ send: () => undefined, close: () => undefined });
    session.message(encode({ t: 'solo' }));
    gate.sample(5);
    session.close();
    gate.flush();
  });
});
