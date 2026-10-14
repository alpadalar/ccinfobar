import type * as Crypto from 'node:crypto';
import type * as Fs from 'node:fs';
import { createRequire } from 'node:module';

// a static ESM node:fs or node:crypto import costs ms at startup
const load = <T>(id: string): T =>
  (process.getBuiltinModule?.(id) as T | undefined) ?? (createRequire(import.meta.url)(id) as T);

export const fs: typeof Fs = load('node:fs');

export function randomHex(bytes: number): string {
  return load<typeof Crypto>('node:crypto').randomBytes(bytes).toString('hex');
}
