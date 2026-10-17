import { describe, expect, it } from 'vitest';
import { type MarketEntry, type MarketSummary, RESPONSE_CAPS } from '../../src/market/protocol.js';
import {
  fits,
  isJsonType,
  limited,
  MarketHttpError,
  MESSAGES,
  order,
  part,
  personal,
  retryAfterSeconds,
  tombOf,
  toSummary,
  versionNo,
  WINDOW_MS,
  windowOf,
} from '../../src/market/rules.js';
import { fixedWindow } from '../../src/market/server.js';

const H = 'a'.repeat(64);

const entry = (over: Partial<MarketEntry> = {}): MarketEntry => ({
  id: 'alice/dark',
  kind: 'theme',
  name: 'Dark',
  description: 'A dark theme',
  author: 'Alice',
  publisher: 'alice',
  version: 2,
  updatedAt: '2026-10-01T00:00:00.000Z',
  hash: H,
  versions: [
    { version: 1, at: '2026-09-01T00:00:00.000Z', note: 'first', hash: H },
    { version: 2, at: '2026-10-01T00:00:00.000Z', note: 'second', hash: H },
  ],
  ...over,
});

const thrown = (f: () => unknown): MarketHttpError => {
  try {
    f();
  } catch (e) {
    if (e instanceof MarketHttpError) return e;
    throw e;
  }
  throw new Error('did not throw');
};

describe('market rules', () => {
  it('part decodes and checks ids', () => {
    for (const raw of ['..', '%2e%2e', '%zz', 'A', '', '-a', 'a/b', '%2F']) {
      const e = thrown(() => part(raw));
      expect([e.status, e.code, e.message], raw).toEqual([400, 'invalid', 'invalid id']);
    }
    expect(part('alice')).toBe('alice');
    expect(part('a%2Db')).toBe('a-b');
  });

  it('versionNo accepts safe positive integers only', () => {
    expect(versionNo('1')).toBe(1);
    expect(versionNo('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    for (const raw of ['0', '01', '-1', '1.5', 'x', '9007199254740992', '1'.repeat(17)]) {
      const e = thrown(() => versionNo(raw));
      expect([e.status, e.code, e.message], raw).toEqual([400, 'invalid', 'invalid version']);
    }
  });

  it('tombOf keeps ids, versions and hashes only', () => {
    const t = tombOf(entry(), '2026-10-02T00:00:00.000Z');
    expect(t).toEqual({
      id: 'alice/dark',
      kind: 'theme',
      name: '',
      description: '',
      author: '',
      publisher: 'alice',
      version: 2,
      updatedAt: '2026-10-02T00:00:00.000Z',
      hash: H,
      versions: [
        { version: 1, at: '2026-09-01T00:00:00.000Z', note: '', hash: H },
        { version: 2, at: '2026-10-01T00:00:00.000Z', note: '', hash: H },
      ],
      withdrawn: true,
      withdrawnAt: '2026-10-02T00:00:00.000Z',
    });
    expect(personal(t)).toBe(false);
    expect(personal(entry())).toBe(true);
    expect(personal(entry({ name: '', description: '', author: '' }))).toBe(true);
  });

  it('toSummary drops personal data of withdrawn entries', () => {
    const live = toSummary(entry());
    expect(live).toEqual({
      id: 'alice/dark',
      kind: 'theme',
      name: 'Dark',
      description: 'A dark theme',
      author: 'Alice',
      publisher: 'alice',
      version: 2,
      updatedAt: '2026-10-01T00:00:00.000Z',
      hash: H,
    });
    expect('withdrawn' in live).toBe(false);
    const gone = toSummary(entry({ withdrawn: true }));
    expect([gone.name, gone.description, gone.author, gone.withdrawn]).toEqual(['', '', '', true]);
    expect('versions' in gone).toBe(false);
  });

  it('order sorts by publisher, then slug, by code unit', () => {
    const ids = ['b/a', 'a0/a', 'a/b', 'a-x/a', 'a/a', 'a/a-b', 'a/a0'];
    const sorted = ids.map((id) => ({ id }) as MarketSummary).sort(order);
    expect(sorted.map((s) => s.id)).toEqual(['a/a', 'a/a-b', 'a/a0', 'a/b', 'a-x/a', 'a0/a', 'b/a']);
    expect(order({ id: 'a/a' } as MarketSummary, { id: 'a/a' } as MarketSummary)).toBe(0);
  });

  it('fits measures UTF-8 bytes like Buffer.byteLength', () => {
    const base = entry({ description: '' });
    const room = RESPONSE_CAPS.document - 1 - Buffer.byteLength(JSON.stringify(base));
    const multi = 'ğ'.repeat(Math.floor(room / 4));
    const pad = 'a'.repeat(room - Buffer.byteLength(multi));
    const edge = entry({ description: multi + pad });
    expect(Buffer.byteLength(JSON.stringify(edge)) + 1).toBe(RESPONSE_CAPS.document);
    expect(() => fits(edge)).not.toThrow();
    const over = entry({ description: `${multi + pad}a` });
    const e = thrown(() => fits(over));
    expect([e.status, e.code, e.message]).toEqual([413, 'over-quota', 'version history too large']);
    // fewer UTF-16 units than the cap, more bytes
    const wide = entry({ description: 'ğ'.repeat(Math.ceil(RESPONSE_CAPS.document / 2)) });
    expect(JSON.stringify(wide).length).toBeLessThan(RESPONSE_CAPS.document);
    expect(thrown(() => fits(wide)).status).toBe(413);
  });

  it('window math matches fixedWindow', () => {
    for (const t of [0, 1, 999, 1000, 59_000, 59_999, 60_000, 61_234, 1_760_000_123_456]) {
      const w = windowOf(t);
      expect(w % WINDOW_MS).toBe(0);
      expect(t - w).toBeLessThan(WINDOW_MS);
      const take = fixedWindow(1, () => t);
      expect(take('k')).toBeNull();
      expect(take('k'), String(t)).toBe(retryAfterSeconds(w, t));
    }
    expect(retryAfterSeconds(0, 59_999)).toBe(1);
    expect(retryAfterSeconds(0, 0)).toBe(60);
    expect(retryAfterSeconds(0, 500)).toBe(60);
  });

  it('errors use fixed English messages', () => {
    for (const [code, m] of Object.entries(MESSAGES)) {
      expect(m, code).toMatch(/^[a-z][a-z /-]*[a-z]$/);
      expect(new MarketHttpError(400, code).message).toBe(m);
    }
    expect(new MarketHttpError(400, 'nope').message).toBe('nope');
    expect(new MarketHttpError(400, 'invalid', 'invalid id').message).toBe('invalid id');
    expect(new MarketHttpError(400, 'invalid').retryAfter).toBeNull();
    const l = limited(7);
    expect([l.status, l.code, l.message, l.retryAfter]).toEqual([
      429,
      'rate-limited',
      'too many requests',
      7,
    ]);
  });

  it('isJsonType accepts application/json with parameters only', () => {
    expect(isJsonType('application/json')).toBe(true);
    expect(isJsonType(' Application/JSON ; charset=utf-8')).toBe(true);
    expect(isJsonType('text/json')).toBe(false);
    expect(isJsonType('application/json5')).toBe(false);
    expect(isJsonType(undefined)).toBe(false);
  });
});
