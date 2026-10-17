import { TOKEN_RE } from '../rules.js';
import type { D1Database } from './env.js';
import { tokenPublisher } from './store.js';

export interface Publisher {
  handle: string;
  githubId: number;
  trusted: boolean;
  banned: boolean;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

export function randomToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

// only the digest is stored or looked up
export async function authPublisher(db: D1Database, req: Request): Promise<Publisher | null> {
  const m = TOKEN_RE.exec(req.headers.get('authorization') ?? '');
  if (!m) return null;
  return tokenPublisher(db, await sha256Hex(m[1]!));
}
