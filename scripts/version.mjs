// A játék verziószáma: a version.json tárolja, és automatikusan nő, ha a játék
// forrása megváltozott. Minden összeállítás előtt lefut (npm run build,
// szerver.bat, inditas.bat): kiszámolja a forrásfájlok ujjlenyomatát, és ha az
// eltér a legutóbb eltárolttól, eggyel növeli a verzió második számát
// (1.0 → 1.1 → … → 1.9 → 1.10). Ha a forrás nem változott, a verzió marad.
// A nagy (első) számot kézzel lehet átírni a version.json-ban.
//
// Használat: node scripts/version.mjs

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIRST_VERSION = '1.0';
/** Ami a játékot adja: ezek változása számít módosításnak (a leírásoké, a teszteké nem). */
const SOURCES = ['src', 'server', 'index.html', 'assets/maps/processed'];

/** A következő verzió: a második szám eggyel nő. Hibás bemenetre az első verzió. */
export function bump(version) {
  const match = /^(\d+)\.(\d+)$/.exec(String(version ?? ''));
  return match ? `${match[1]}.${Number(match[2]) + 1}` : FIRST_VERSION;
}

function listFiles(target, out) {
  if (!existsSync(target)) return;
  if (statSync(target).isDirectory()) {
    for (const name of readdirSync(target).sort()) listFiles(path.join(target, name), out);
  } else out.push(target);
}

/** A forrásfájlok ujjlenyomata; a sorvégek (CRLF / LF) különbsége nem számít. */
export function sourceHash(root) {
  const files = [];
  for (const source of SOURCES) listFiles(path.join(root, source), files);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 20);
}

/**
 * A verzió frissítése a megadott mappában: ha a forrás változott az eltárolt
 * ujjlenyomathoz képest, a verzió nő. Visszaadja a (régi és az) érvényes verziót.
 */
export function updateVersion(root) {
  const file = path.join(root, 'version.json');
  const hash = sourceHash(root);
  let stored = null;
  try {
    stored = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* még nincs verziófájl, vagy sérült: az első verzióval indulunk */
  }
  const previous = stored && /^\d+\.\d+$/.test(stored.version) ? stored.version : null;
  if (previous && stored.hash === hash) return { version: previous, previous, changed: false };
  const version = previous ? bump(previous) : FIRST_VERSION;
  writeFileSync(file, `${JSON.stringify({ version, hash }, null, 2)}\n`);
  return { version, previous, changed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = updateVersion(root);
  if (!result.changed) console.log(`TANK MISLENY ${result.version} (a forrás nem változott)`);
  else if (result.previous) console.log(`TANK MISLENY ${result.previous} -> ${result.version} (a forrás megváltozott)`);
  else console.log(`TANK MISLENY ${result.version} (első verzió)`);
}
