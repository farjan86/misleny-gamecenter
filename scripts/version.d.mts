export const FIRST_VERSION: string;
export function bump(version: unknown): string;
export function sourceHash(root: string): string;
export function updateVersion(root: string): { version: string; previous: string | null; changed: boolean };
