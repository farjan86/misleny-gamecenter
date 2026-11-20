// A kilövések szövegei: ki és mivel lőtt ki kit.

import type { KillCause } from '../sim/world';

/** A kilövési értesítőben: mivel történt. */
export const CAUSE_LABEL: Record<KillCause, string> = {
  shell: 'ágyú',
  heavy: 'nehéz lövedék',
  rocket: 'rakéta',
  laser: 'lézer',
  flame: 'lángszóró',
  gun: 'géppuska',
  turret: 'löveg',
  mine: 'akna',
  strike: 'tüzérség',
  barrel: 'gázpalack',
  vehicle: 'robbanó jármű',
};

/** „…-val/-vel”: mivel lőtték ki. */
const CAUSE_WITH: Record<KillCause, string> = {
  shell: 'ágyúval',
  heavy: 'nehéz lövedékkel',
  rocket: 'rakétával',
  laser: 'lézerrel',
  flame: 'lángszóróval',
  gun: 'géppuskával',
  turret: 'telepített löveggel',
  mine: 'aknával',
  strike: 'tüzérségi csapással',
  barrel: 'felrobbantott gázpalackkal',
  vehicle: 'felrobbantott járművel',
};

export const causeWith = (cause: KillCause): string => CAUSE_WITH[cause];

/**
 * Amit a kilőtt játékos lát. `killer`: a kilövő neve ('Bot' a botoknál), vagy null,
 * ha senkinek nem jár a kilövés; `self`: a saját maga okozta robbanásban halt meg.
 */
export function deathText(cause: KillCause, killer: string | null, self = false): string {
  if (killer) return `${killer === 'Bot' ? 'Egy bot' : killer} lőtt ki – ${CAUSE_WITH[cause]}.`;
  if (self) {
    if (cause === 'barrel') return 'Az általad felrobbantott gázpalack végzett veled.';
    if (cause === 'vehicle') return 'Az általad felrobbantott jármű végzett veled.';
    return 'A saját robbanásod végzett veled.';
  }
  if (cause === 'barrel') return 'Felrobbant melletted egy gázpalack.';
  if (cause === 'vehicle') return 'Felrobbant melletted egy jármű.';
  if (cause === 'mine') return 'Aknára futottál.';
  return 'Felrobbantál.';
}
