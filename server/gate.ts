// A szerver „kapuja”: egy kapcsolat csak belépés (regisztráció, név + jelszó
// vagy megőrzött kulcs) után érheti el a szobalistát és a meccseket. A belépett
// játékos neve a fiókjából jön, a kliens nem adhat meg mást.

import { encode, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/game/net/protocol';
import type { Accounts, AuthResult } from './accounts';
import type { Link, Lobby } from './lobby';
import type { StatsLog, Visit } from './stats';

/** Ennyi sikertelen belépési kísérlet után a kapcsolat megszakad. */
const MAX_FAILURES = 6;

interface Session {
  message(text: string): void;
  close(): void;
}

export class Gate {
  /** a belépett fiókok élő kapcsolata (egy fiókkal egyszerre egy helyről lehet játszani) */
  private readonly online = new Map<string, Link>();
  /** minden élő látogatás (a be nem lépetteké is) – a statisztika naplójához */
  private readonly present = new Set<Visit>();

  constructor(
    private readonly lobby: Lobby,
    private readonly accounts: Accounts,
    /** a játéknapló (lásd stats.ts); nélküle nincs naplózás */
    private readonly stats: StatsLog | null = null,
  ) {}

  /** A statisztika mintavétele: az előző óta `seconds` telt el. */
  sample(seconds: number): void {
    this.stats?.sample(seconds, this.present, this.lobby.playingNames());
  }

  /** Leálláskor: a még bent lévők látogatása is bekerül a naplóba. */
  flush(): void {
    for (const visit of this.present) this.stats?.end(visit);
    this.present.clear();
  }

  connect(link: Link): Session {
    let inner: Session | null = null;
    let account = '';
    let token = '';
    let failures = 0;
    let busy = false;
    let closed = false;
    const here: Visit = this.stats?.begin() ?? { name: '', solo: false, start: new Date(), multiSeconds: 0, soloSeconds: 0 };
    this.present.add(here);
    const send = (message: ServerMessage): void => link.send(encode(message));

    const accept = (result: AuthResult): void => {
      busy = false;
      if (closed) return;
      if (!result.ok) {
        send({ t: 'authError', message: result.message });
        if (++failures >= MAX_FAILURES) link.close();
        return;
      }
      // ha ugyanezzel a fiókkal máshonnan már játszanak, a régi kapcsolat megszakad
      const previous = this.online.get(result.name);
      if (previous && previous !== link) {
        previous.send(encode({ t: 'authError', message: 'Ezzel a fiókkal máshol léptek be, ezért itt megszakadt a kapcsolat.' }));
        previous.close();
      }
      account = result.name;
      here.name = account;
      token = result.token;
      this.online.set(account, link);
      send({ t: 'auth', name: result.name, token: result.token });
      inner = this.lobby.connect(link);
      inner.message(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: result.name }));
    };

    return {
      message: (text) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(text) as ClientMessage;
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'register' || msg.t === 'login' || msg.t === 'resume') {
          if (inner || busy) return;
          if (msg.v !== PROTOCOL_VERSION) {
            send({ t: 'error', message: 'A játék frissült – töltsd újra az oldalt (Ctrl+F5).' });
            return;
          }
          if (msg.t === 'resume') {
            accept(this.accounts.resume(msg.token));
            return;
          }
          busy = true;
          const work = msg.t === 'register' ? this.accounts.register(msg.name, msg.password) : this.accounts.login(msg.name, msg.password);
          work.then(accept, () => accept({ ok: false, message: 'Szerverhiba, próbáld újra.' }));
          return;
        }
        if (msg.t === 'logout') {
          this.accounts.logout(token);
          link.close();
          return;
        }
        // egyjátékos meccs indult a böngészőben: csak a statisztika jegyzi (belépés nélkül is)
        if (msg.t === 'solo') {
          here.solo = true;
          return;
        }
        // a nevet a fiók adja: a kliens nem jelentkezhet be maga
        if (msg.t === 'hello') return;
        inner?.message(text);
      },
      close: () => {
        closed = true;
        if (this.present.delete(here)) this.stats?.end(here);
        if (account && this.online.get(account) === link) this.online.delete(account);
        inner?.close();
      },
    };
  }
}
