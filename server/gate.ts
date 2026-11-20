// A szerver „kapuja”: egy kapcsolat csak belépés (regisztráció, név + jelszó
// vagy megőrzött kulcs) után érheti el a szobalistát és a meccseket. A belépett
// játékos neve a fiókjából jön, a kliens nem adhat meg mást.

import { encode, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/game/net/protocol';
import type { Accounts, AuthResult } from './accounts';
import type { Link, Lobby } from './lobby';
import type { StatsLog, Visit } from './stats';

/** Ennyi sikertelen belépési kísérlet után a kapcsolat megszakad. */
const MAX_FAILURES = 6;
/** Egy címről óránként legfeljebb ennyi új fiók regisztrálható (tömeges fiókgyártás ellen; egy LAN-partinak is elég). */
const REGISTER_PER_HOUR = 30;
/** Egy címről ennyi sikertelen belépés után 15 percig nem lehet jelszóval belépni (jelszótalálgatás ellen). */
const LOGIN_FAILURES_PER_ADDRESS = 30;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
/** Egy fiókra ennyi sikertelen belépés után 15 percig nem lehet jelszóval belépni (bárhonnan); a megőrzött kulcsos belépés megy. */
const LOGIN_FAILURES_PER_ACCOUNT = 20;

interface Session {
  message(text: string): void;
  close(): void;
}

export class Gate {
  /** a belépett fiókok élő kapcsolata (egy fiókkal egyszerre egy helyről lehet játszani) */
  private readonly online = new Map<string, Link>();
  /** minden élő látogatás (a be nem lépetteké is) – a statisztika naplójához */
  private readonly present = new Set<Visit>();
  /** címenként: az utóbbi órában regisztrált fiókok ideje, és a sikertelen belépések száma, ideje */
  private readonly registrations = new Map<string, number[]>();
  private readonly loginFailures = new Map<string, { count: number; at: number }>();
  private readonly accountFailures = new Map<string, { count: number; at: number }>();

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

  /** `address`: a kapcsolat küldőjének címe (a regisztrációs és a belépési korláthoz). */
  connect(link: Link, address = '?'): Session {
    let inner: Session | null = null;
    let account = '';
    let token = '';
    let failures = 0;
    /** a folyamatban lévő jelszavas belépés fiókja (a fiókonkénti korláthoz) */
    let pendingAccount = '';
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
        const entry = this.loginFailures.get(address) ?? { count: 0, at: 0 };
        this.loginFailures.set(address, { count: entry.count + 1, at: Date.now() });
        if (pendingAccount) {
          const prev = this.accountFailures.get(pendingAccount) ?? { count: 0, at: 0 };
          this.accountFailures.set(pendingAccount, { count: prev.count + 1, at: Date.now() });
          // a táblázat ne nőhessen korlátlanul (sok különböző név kipróbálásával)
          if (this.accountFailures.size > 10000) this.accountFailures.clear();
        }
        pendingAccount = '';
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
      send({ t: 'auth', name: result.name, token: result.token, ...(this.lobby.isAdmin(result.name) ? { admin: true } : {}) });
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
          const now = Date.now();
          if (msg.t === 'register') {
            const recent = (this.registrations.get(address) ?? []).filter((at) => now - at < 3600000);
            if (recent.length >= REGISTER_PER_HOUR) {
              send({ t: 'authError', message: 'Erről a címről most túl sok új fiókot hoztak létre – próbáld később.' });
              return;
            }
            recent.push(now);
            this.registrations.set(address, recent);
          } else {
            const failed = this.loginFailures.get(address);
            if (failed && now - failed.at > LOGIN_LOCK_MS) this.loginFailures.delete(address);
            else if (failed && failed.count >= LOGIN_FAILURES_PER_ADDRESS) {
              send({ t: 'authError', message: 'Túl sok sikertelen belépés erről a címről – próbáld 15 perc múlva.' });
              return;
            }
            // ugyanarra a fiókra sok helyről sem lehet sokáig találgatni
            const who = typeof msg.name === 'string' ? msg.name.normalize('NFKC').trim().toLocaleLowerCase('hu').slice(0, 40) : '';
            const byAccount = this.accountFailures.get(who);
            if (byAccount && now - byAccount.at > LOGIN_LOCK_MS) this.accountFailures.delete(who);
            else if (byAccount && byAccount.count >= LOGIN_FAILURES_PER_ACCOUNT) {
              send({ t: 'authError', message: 'Erre a fiókra túl sok sikertelen belépés volt – próbáld 15 perc múlva.' });
              return;
            }
            pendingAccount = who;
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
