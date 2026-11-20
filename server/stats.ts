// Nagyon egyszerű játéknapló: egy szöveges fájl (logs/statisztika.txt), amelybe a szerver
// soronként beírja, ki mikor és mennyi ideig volt bent, és ebből mennyit játszott.
// Statisztikát ebből később lehet készíteni (a fájl Jegyzettömbbel és Excellel is megnyílik).
//
// Egy sor = egy látogatás (az oldal megnyitásától a bezárásáig vagy újratöltéséig; egy meccs
// után az oldal újratöltődik, ezért egy játékosnak egy estére több sora is lehet):
//
//   kezdet;vege;jatekos;bent_mp;tobbjatekos_mp;egyjatekos_mp
//   2026-11-21 20:15:03;2026-11-21 20:47:10;Pista;1927;1200;312
//
// Aki nem lépett be (a belépőképernyőn van, vagy onnan egyjátékos meccset indított), annak a
// neve helyén „(nincs belépve)” áll. A fájlban csak név és idő van: IP-cím, jelszó nincs.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const HEADER = 'kezdet;vege;jatekos;bent_mp;tobbjatekos_mp;egyjatekos_mp';
export const GUEST = '(nincs belépve)';

/** Egy élő látogatás: a kapu vezeti, a napló a végén írja ki. */
export interface Visit {
  /** a belépett játékos neve; üres, amíg nincs belépve */
  name: string;
  /** egyjátékos meccset játszik (a böngésző jelzi, hogy elindult) */
  solo: boolean;
  start: Date;
  /** többjátékos, illetve egyjátékos meccsen töltött idő (mp) */
  multiSeconds: number;
  soloSeconds: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** Helyi idő: ÉÉÉÉ-HH-NN ÓÓ:PP:MM. */
export const stamp = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export class StatsLog {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Új látogatás kezdődik (valaki megnyitotta az oldalt). */
  begin(): Visit {
    return { name: '', solo: false, start: this.now(), multiSeconds: 0, soloSeconds: 0 };
  }

  /** Mintavétel: az előző óta `seconds` telt el; aki éppen meccsen van, annak ez játékidő. */
  sample(seconds: number, visits: Iterable<Visit>, playing: ReadonlySet<string>): void {
    if (seconds <= 0) return;
    for (const visit of visits) {
      if (visit.name && playing.has(visit.name)) visit.multiSeconds += seconds;
      else if (visit.solo) visit.soloSeconds += seconds;
    }
  }

  /** A látogatás véget ért: egy sor kerül a napló végére. Az egy másodpercnél rövidebb látogatás kimarad. */
  end(visit: Visit): void {
    const end = this.now();
    const online = Math.round((end.getTime() - visit.start.getTime()) / 1000);
    if (online < 1) return;
    // a játékidő nem lehet több a bent töltött időnél (a mintavétel pár másodpercet tévedhet)
    const multi = Math.min(online, Math.round(visit.multiSeconds));
    const solo = Math.min(online - multi, Math.round(visit.soloSeconds));
    const name = (visit.name || GUEST).replace(/[;\r\n]/g, ',');
    const line = [stamp(visit.start), stamp(end), name, online, multi, solo].join(';');
    try {
      if (!existsSync(this.file)) {
        mkdirSync(path.dirname(this.file), { recursive: true });
        // a fájl elején jelölés az ékezetes betűkhöz (Excel), utána a fejléc
        appendFileSync(this.file, `﻿${HEADER}\r\n`);
      }
      appendFileSync(this.file, `${line}\r\n`);
    } catch (error) {
      console.error('A statisztika naplójába nem sikerült írni:', error);
    }
  }
}
