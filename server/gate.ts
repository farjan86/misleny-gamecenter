// A szerver „kapuja”: egy kapcsolat csak belépés (regisztráció, név + jelszó
// vagy megőrzött kulcs) után érheti el a szobalistát és a meccseket. A belépett
// játékos neve a fiókjából jön, a kliens nem adhat meg mást.

import { encode, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/game/net/protocol';
import type { Accounts, AuthResult } from './accounts';
import type { Link, Lobby } from './lobby';

/** Ennyi sikertelen belépési kísérlet után a kapcsolat megszakad. */
const MAX_FAILURES = 6;

interface Session {
  message(text: string): void;
  close(): void;
}

export class Gate {
  /** a belépett fiókok élő kapcsolata (egy fiókkal egyszerre egy helyről lehet játszani) */
  private readonly online = new Map<string, Link>();

  constructor(
    private readonly lobby: Lobby,
    private readonly accounts: Accounts,
  ) {}

  connect(link: Link): Session {
    let inner: Session | null = null;
    let account = '';
    let token = '';
    let failures = 0;
    let busy = false;
    let closed = false;
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
        // a nevet a fiók adja: a kliens nem jelentkezhet be maga
        if (msg.t === 'hello') return;
        inner?.message(text);
      },
      close: () => {
        closed = true;
        if (account && this.online.get(account) === link) this.online.delete(account);
        inner?.close();
      },
    };
  }
}
