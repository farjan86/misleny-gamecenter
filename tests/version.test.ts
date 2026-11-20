// A verziószám: 1.0-ról indul, és csak akkor nő, ha a játék forrása megváltozott.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bump, FIRST_VERSION, sourceHash, updateVersion } from '../scripts/version.mjs';
import { VERSION } from '../src/game/version';

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tank-version-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'server'));
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'server', 'main.ts'), 'console.log(1);\n');
  writeFileSync(path.join(root, 'index.html'), '<html></html>\n');
  writeFileSync(path.join(root, 'docs', 'leiras.md'), 'szöveg\n');
  return root;
}

describe('verziószám', () => {
  it('a második szám nő eggyel; 1.9 után 1.10 jön', () => {
    expect(FIRST_VERSION).toBe('1.0');
    expect(bump('1.0')).toBe('1.1');
    expect(bump('1.9')).toBe('1.10');
    expect(bump('1.10')).toBe('1.11');
    expect(bump('2.41')).toBe('2.42');
    expect(bump('valami')).toBe('1.0');
    expect(bump(undefined)).toBe('1.0');
  });

  it('1.0-ról indul, a forrás változásakor nő, különben marad', () => {
    const root = project();
    try {
      expect(updateVersion(root)).toEqual({ version: '1.0', previous: null, changed: true });
      // változatlan forrással akárhányszor futhat
      expect(updateVersion(root)).toEqual({ version: '1.0', previous: '1.0', changed: false });
      expect(updateVersion(root).version).toBe('1.0');
      // a játék forrása megváltozik
      writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
      expect(updateVersion(root)).toEqual({ version: '1.1', previous: '1.0', changed: true });
      expect(updateVersion(root).changed).toBe(false);
      // új fájl a szerverben, illetve az oldal változása is módosítás
      writeFileSync(path.join(root, 'server', 'uj.ts'), 'export {};\n');
      expect(updateVersion(root).version).toBe('1.2');
      writeFileSync(path.join(root, 'index.html'), '<html><body></body></html>\n');
      expect(updateVersion(root).version).toBe('1.3');
      expect(JSON.parse(readFileSync(path.join(root, 'version.json'), 'utf8'))).toMatchObject({ version: '1.3' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a leírások és a sorvégek változása nem számít módosításnak; a kézzel átírt nagy szám megmarad', () => {
    const root = project();
    try {
      updateVersion(root);
      const hash = sourceHash(root);
      writeFileSync(path.join(root, 'docs', 'leiras.md'), 'másik szöveg\n');
      writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\r\n');
      expect(sourceHash(root)).toBe(hash);
      expect(updateVersion(root)).toMatchObject({ version: '1.0', changed: false });
      // a nagy szám kézzel átírható: onnan számol tovább
      writeFileSync(path.join(root, 'version.json'), JSON.stringify({ version: '2.0', hash }));
      expect(updateVersion(root).version).toBe('2.0');
      writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 3;\n');
      expect(updateVersion(root).version).toBe('2.1');
      // sérült verziófájlnál az első verzióval indul újra
      writeFileSync(path.join(root, 'version.json'), '{ hibás');
      expect(updateVersion(root).version).toBe('1.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a játékba a version.json verziója kerül', () => {
    expect(VERSION).toMatch(/^\d+\.\d+$/);
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8')).version);
  });
});
