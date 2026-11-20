// A játék verziószáma. A version.json-ból jön, amelyet az összeállítás előtt a
// scripts/version.mjs frissít: ha a forrás megváltozott, a szám magától nő.

import data from '../../version.json';

export const VERSION: string = data.version;
