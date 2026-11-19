// Játékosfiókok: játékosnév és jelszó, e-mail nélkül. A fiókok a szerver egy
// JSON-fájljában vannak (alapértelmezés: data/accounts.json); a jelszónak csak a
// sózott, visszafejthetetlen lenyomata (scrypt) tárolódik, a belépve maradást
// szolgáló kulcsoknak pedig csak a lenyomata (SHA-256).

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ACCOUNT = {
  nameMin: 3,
  nameMax: 18,
  passwordMin: 6,
  passwordMax: 72,
  /** ennyi eszközön maradhat belépve egy fiók; fölötte a legrégebbi belépés érvényét veszti */
  tokensPerAccount: 5,
  maxAccounts: 5000,
} as const;

interface Account {
  name: string;
  salt: string;
  hash: string;
  /** a belépve maradást szolgáló kulcsok lenyomatai */
  tokens: string[];
  created: string;
}

export type AuthResult = { ok: true; name: string; token: string } | { ok: false; message: string };

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/** A név összehasonlításhoz: kis- és nagybetű, valamint az egyenértékű írásmódok nem számítanak. */
const keyOf = (name: string): string => name.normalize('NFKC').toLocaleLowerCase('hu');

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** A játékosnév megtisztítása; null, ha nem megengedett. */
export function cleanAccountName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.length < ACCOUNT.nameMin || name.length > ACCOUNT.nameMax) return null;
  // betűk (ékezetesek is), számok, szóköz, pont, kötőjel, aláhúzás
  return /^[\p{L}\p{N} ._-]+$/u.test(name) ? name : null;
}

export class Accounts {
  private readonly byKey = new Map<string, Account>();
  private readonly byToken = new Map<string, Account>();

  /** `file`: a fiókok fájlja; null esetén csak a memóriában élnek (tesztekhez). */
  constructor(private readonly file: string | null) {
    if (!file || !existsSync(file)) return;
    const list = JSON.parse(readFileSync(file, 'utf8')) as Account[];
    for (const account of list) {
      this.byKey.set(keyOf(account.name), account);
      for (const token of account.tokens) this.byToken.set(token, account);
    }
  }

  get count(): number {
    return this.byKey.size;
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    // előbb ideiglenes fájlba ír, aztán átnevezi: megszakadt írás nem rontja el a fiókokat
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.byKey.values()], null, 1));
    renameSync(tmp, this.file);
  }

  private issue(account: Account): string {
    const token = randomBytes(32).toString('hex');
    const print = sha256(token);
    account.tokens.push(print);
    this.byToken.set(print, account);
    while (account.tokens.length > ACCOUNT.tokensPerAccount) this.byToken.delete(account.tokens.shift()!);
    this.save();
    return token;
  }

  async register(rawName: unknown, password: unknown): Promise<AuthResult> {
    const name = cleanAccountName(rawName);
    if (!name) return { ok: false, message: `A név ${ACCOUNT.nameMin}–${ACCOUNT.nameMax} karakter lehet: betűk, számok, szóköz, pont, kötőjel.` };
    if (typeof password !== 'string' || password.length < ACCOUNT.passwordMin || password.length > ACCOUNT.passwordMax) {
      return { ok: false, message: `A jelszó legalább ${ACCOUNT.passwordMin} karakter legyen.` };
    }
    if (this.byKey.has(keyOf(name))) return { ok: false, message: 'Ez a név már foglalt – válassz másikat, vagy lépj be vele.' };
    if (this.byKey.size >= ACCOUNT.maxAccounts) return { ok: false, message: 'Most nem lehet új fiókot létrehozni.' };
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt)).toString('hex');
    // közben (a lenyomat számítása alatt) más is regisztrálhatta ugyanezt a nevet
    if (this.byKey.has(keyOf(name))) return { ok: false, message: 'Ez a név már foglalt – válassz másikat, vagy lépj be vele.' };
    const account: Account = { name, salt, hash, tokens: [], created: new Date().toISOString() };
    this.byKey.set(keyOf(name), account);
    return { ok: true, name, token: this.issue(account) };
  }

  async login(rawName: unknown, password: unknown): Promise<AuthResult> {
    const wrong: AuthResult = { ok: false, message: 'Hibás név vagy jelszó.' };
    const name = cleanAccountName(rawName);
    if (!name || typeof password !== 'string' || password.length > ACCOUNT.passwordMax) return wrong;
    const account = this.byKey.get(keyOf(name));
    // nem létező névnél is elvégezzük a számítást, hogy a válaszidő ne árulja el, van-e ilyen fiók
    const hash = await derive(password, account?.salt ?? 'nincs-ilyen-fiok');
    if (!account || !timingSafeEqual(hash, Buffer.from(account.hash, 'hex'))) return wrong;
    return { ok: true, name: account.name, token: this.issue(account) };
  }

  /** Belépés a böngészőben megőrzött kulccsal. */
  resume(token: unknown): AuthResult {
    const account = typeof token === 'string' && token.length < 200 ? this.byToken.get(sha256(token)) : undefined;
    if (!account) return { ok: false, message: 'A belépésed lejárt, lépj be újra.' };
    return { ok: true, name: account.name, token: token as string };
  }

  logout(token: unknown): void {
    if (typeof token !== 'string') return;
    const print = sha256(token);
    const account = this.byToken.get(print);
    if (!account) return;
    this.byToken.delete(print);
    account.tokens = account.tokens.filter((t) => t !== print);
    this.save();
  }
}
