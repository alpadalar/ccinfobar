import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_KEYS,
  appendVersion,
  type CatalogEntry,
  ENTRY_ID_RE,
  ENTRY_LIMITS,
  type EntryContent,
  LAYOUT_KEYS,
  latest,
  markError,
  marketSlug,
  markPublished,
  markWithdrawn,
  mergeRaw,
  newEntry,
  overwriteVersion,
  parseEntry,
  pick,
  type RemoteRef,
  restoreVersion,
  type ShareState,
  setShare,
  shareView,
  slug,
  splitContent,
  stripPersonal,
} from '../../src/catalog/model.js';
import { defaultConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/types.js';

const T0 = '2026-10-16T10:00:00.000Z';
const T1 = '2026-10-16T11:00:00.000Z';
const T2 = '2026-10-16T12:00:00.000Z';
const ID = 'u-0123456789ab';
const MARKET_PART = /^[a-z0-9][a-z0-9-]{0,38}$/;

const config = (): Config => ({
  ...defaultConfig(),
  lines: [[{ id: 'm', type: 'model' }]],
  align: 'center',
  theme: 'nord',
  style: 'powerline',
  separator: ' | ',
  budget: { daily: 5 },
  profiles: { builtIn: false },
  language: 'tr',
  update: 'off',
  charset: 'text',
});

const content = (n: number): EntryContent => ({ layout: { lines: [[{ id: `w${n}`, type: 'model' }]] } });

const entry = (share = true): CatalogEntry =>
  newEntry({
    id: ID,
    kind: 'preset',
    name: '  Nord cockpit  ',
    description: ' Mine ',
    author: ' Ada ',
    content: content(1),
    share,
    now: T0,
  });

const remote = (hash = 'a'): RemoteRef => ({
  endpoint: 'https://market.example.com',
  id: 'ada/nord-cockpit',
  version: 1,
  hash,
  publishedAt: T1,
});

const withState = (e: CatalogEntry, state: ShareState, wanted = true): CatalogEntry => ({
  ...e,
  share: { ...e.share, state, wanted, remote: state === 'local' || state === 'pending' ? null : remote() },
});

describe('catalog model', () => {
  it('splitContent keeps only LAYOUT_KEYS for preset', () => {
    const c = splitContent(config(), 'preset');
    expect(c.appearance).toBeUndefined();
    expect(Object.keys(c.layout!).every((k) => (LAYOUT_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(c.layout!.lines).toEqual([[{ id: 'm', type: 'model' }]]);
    expect(c.layout!.align).toBe('center');
  });

  it('splitContent keeps only APPEARANCE_KEYS for theme', () => {
    const c = splitContent(config(), 'theme');
    expect(c.layout).toBeUndefined();
    expect(Object.keys(c.appearance!).every((k) => (APPEARANCE_KEYS as readonly string[]).includes(k))).toBe(
      true,
    );
    expect(c.appearance).toMatchObject({ theme: 'nord', style: 'powerline', separator: ' | ' });
    const b = splitContent(config(), 'bundle');
    expect(b.layout!.lines).toBeDefined();
    expect(b.appearance!.theme).toBe('nord');
    expect(b.theme).toBeUndefined();
  });

  it('splitContent and pick copy values deeply and skip undefined', () => {
    const c = config();
    const s = splitContent(c, 'preset');
    s.layout!.lines![0]![0]!.type = 'cost';
    expect(c.lines[0]![0]!.type).toBe('model');
    expect('padding' in pick(c, ['padding', 'theme'])).toBe(false);
  });

  it('stripPersonal drops budget, profiles, language, update, charset', () => {
    const out = stripPersonal({ ...config(), extra: 1 } as Partial<Config>);
    for (const k of ['budget', 'profiles', 'language', 'update', 'charset', 'version', 'extra'])
      expect(k in out, k).toBe(false);
    expect(out.lines).toBeDefined();
    expect(out.theme).toBe('nord');
  });

  it('newEntry starts at version 1 with share pending when share is on (D-08)', () => {
    const e = entry();
    expect(e).toMatchObject({
      schema: 1,
      id: ID,
      rev: 0,
      kind: 'preset',
      slug: 'nord-cockpit',
      name: 'Nord cockpit',
      description: 'Mine',
      author: 'Ada',
      createdAt: T0,
      updatedAt: T0,
      version: 1,
    });
    expect(e.versions).toEqual([{ version: 1, at: T0, note: '', content: content(1) }]);
    expect(e.share).toEqual({ wanted: true, state: 'pending', remote: null, lastError: null });
    expect(entry(false).share.state).toBe('local');
    expect(entry(false).share.wanted).toBe(false);
  });

  it('newEntry cuts long text to the limits', () => {
    const e = newEntry({
      id: ID,
      kind: 'theme',
      name: 'n'.repeat(100),
      description: 'd'.repeat(300),
      author: 'a'.repeat(100),
      content: {},
      note: 'x'.repeat(300),
      share: false,
      now: T0,
    });
    expect(e.name).toHaveLength(ENTRY_LIMITS.name);
    expect(e.description).toHaveLength(ENTRY_LIMITS.description);
    expect(e.author).toHaveLength(ENTRY_LIMITS.author);
    expect(e.versions[0]!.note).toHaveLength(ENTRY_LIMITS.note);
    expect(newEntry({ ...e, content: {}, share: false, now: T0, name: '***' }).slug).toBe('entry');
  });

  it('appendVersion adds version n+1 and keeps history (D-06)', () => {
    const c2 = content(2);
    const e = appendVersion(appendVersion(entry(), c2, 'two', T1), content(3), 'three', T2);
    expect(e.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(e.version).toBe(3);
    expect(e.updatedAt).toBe(T2);
    expect(e.versions[1]).toMatchObject({ version: 2, at: T1, note: 'two', content: c2 });
    c2.layout!.lines![0]![0]!.type = 'cost';
    expect(e.versions[1]!.content.layout!.lines![0]![0]!.type).toBe('model');
    expect(latest(e).version).toBe(3);
  });

  it('version ops do not mutate their input', () => {
    const e = entry();
    const before = structuredClone(e);
    appendVersion(e, content(2), '', T1);
    overwriteVersion(e, content(2), '', T1);
    restoreVersion(e, 1, '', T1);
    setShare(e, false);
    markPublished(e, remote());
    expect(e).toEqual(before);
  });

  it('overwriteVersion keeps the version number (D-06)', () => {
    const e3 = appendVersion(appendVersion(entry(), content(2), '', T1), content(3), '', T1);
    const e = overwriteVersion(e3, content(9), 'fix', T2);
    expect(e.version).toBe(3);
    expect(e.versions).toHaveLength(3);
    expect(latest(e).content).toEqual(content(9));
    expect(latest(e).overwrittenAt).toBe(T2);
    expect(latest(e).note).toBe('fix');
    expect(e.versions[1]!.content).toEqual(content(2));
  });

  it('restoreVersion appends a copy with restoredFrom (D-06)', () => {
    const e2 = appendVersion(entry(), content(2), '', T1);
    const e = restoreVersion(e2, 1, 'restored v1', T2)!;
    expect(e.version).toBe(3);
    expect(latest(e)).toEqual({
      version: 3,
      at: T2,
      note: 'restored v1',
      content: content(1),
      restoredFrom: 1,
    });
    expect(restoreVersion(e2, 99, '', T2)).toBeNull();
  });

  it('setShare moves local↔pending and published→withdraw-pending (D-08)', () => {
    const e = entry(false);
    expect(setShare(e, true).share).toMatchObject({ state: 'pending', wanted: true });
    expect(setShare(entry(), false).share).toMatchObject({ state: 'local', wanted: false });
    expect(setShare(withState(e, 'published'), false).share.state).toBe('withdraw-pending');
    expect(setShare(withState(e, 'outdated'), false).share.state).toBe('withdraw-pending');
    expect(setShare(withState(e, 'withdraw-pending', false), true).share.state).toBe('published');
    expect(setShare(withState(e, 'withdrawn', false), true).share.state).toBe('pending');
    const same = setShare(withState(e, 'published'), true);
    expect(same.share).toMatchObject({ state: 'published', wanted: true });
    expect(setShare(e, false).share).toMatchObject({ state: 'local', wanted: false });
  });

  it('marks published, withdrawn and errors', () => {
    const p = markPublished(markError(entry(), 'network'), remote('h'));
    expect(p.share).toEqual({ wanted: true, state: 'published', remote: remote('h'), lastError: null });
    const w = markWithdrawn(p);
    expect(w.share).toMatchObject({ wanted: false, state: 'withdrawn', remote: remote('h') });
    expect(markError(entry(), 'too-large').share.lastError).toBe('too-large');
  });

  it('shareView reports outdated when the latest hash differs', () => {
    const p = markPublished(entry(), remote('a'));
    expect(shareView(p, 'b')).toBe('outdated');
    expect(shareView(p, 'a')).toBe('published');
    expect(shareView(entry(), 'b')).toBe('pending');
  });

  it('mergeRaw keeps unknown top-level and per-version keys (D-04)', () => {
    const e = entry();
    const raw = { ...structuredClone(e), futureKey: 1, versions: [{ ...e.versions[0]!, extra: true }] };
    const next = appendVersion(e, content(2), '', T1);
    const out = mergeRaw(raw as unknown as Record<string, unknown>, next);
    expect(out.futureKey).toBe(1);
    const versions = out.versions as Record<string, unknown>[];
    expect(versions).toHaveLength(2);
    expect(versions[0]!.extra).toBe(true);
    expect(versions[1]!.extra).toBeUndefined();
    expect(out.version).toBe(2);
  });

  it('mergeRaw drops own __proto__ keys from hand-edited files', () => {
    const e = entry();
    const raw = JSON.parse(
      `{"__proto__":{"polluted":true},"futureKey":1,"versions":[{"__proto__":{"x":1},"version":1,"extra":true}]}`,
    ) as Record<string, unknown>;
    const out = mergeRaw(raw, appendVersion(e, content(2), '', T1));
    expect(Object.hasOwn(out, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.futureKey).toBe(1);
    const v0 = (out.versions as Record<string, unknown>[])[0]!;
    expect(Object.hasOwn(v0, '__proto__')).toBe(false);
    expect(v0.extra).toBe(true);
    expect(JSON.stringify(out)).not.toContain('polluted');
  });

  it('parseEntry keeps a valid entry and rejects bad shapes', () => {
    const e = appendVersion(entry(), content(2), 'two', T1);
    expect(parseEntry(JSON.parse(JSON.stringify(e)))).toEqual(e);
    const raw = () => JSON.parse(JSON.stringify(e));
    expect(parseEntry(null)).toBeNull();
    expect(parseEntry([])).toBeNull();
    expect(parseEntry({ ...raw(), id: 'x-1' })).toBeNull();
    expect(parseEntry({ ...raw(), id: 'u-0123456789AB' })).toBeNull();
    expect(parseEntry({ ...raw(), kind: 'widget' })).toBeNull();
    expect(parseEntry({ ...raw(), schema: 2 })).toBeNull();
    expect(parseEntry({ ...raw(), version: 1.5 })).toBeNull();
    const bad = raw();
    bad.versions[1].version = 1.5;
    expect(parseEntry(bad)).toBeNull();
    const order = raw();
    order.versions.reverse();
    expect(parseEntry(order)).toBeNull();
    expect(parseEntry({ ...raw(), versions: [] })).toBeNull();
  });

  it('parseEntry maps an unknown share state to local and copies typed fields only', () => {
    const r = JSON.parse(JSON.stringify(entry()));
    r.share.state = 'exploded';
    r.futureKey = 1;
    r.versions[0].extra = true;
    const p = parseEntry(r)!;
    expect(p.share.state).toBe('local');
    expect('futureKey' in p).toBe(false);
    expect('extra' in p.versions[0]!).toBe(false);
    const noShare = JSON.parse(JSON.stringify(entry()));
    delete noShare.share;
    expect(parseEntry(noShare)!.share).toEqual({
      wanted: false,
      state: 'local',
      remote: null,
      lastError: null,
    });
  });

  it('slug keeps the existing output; marketSlug matches the protocol id rule (D-26)', () => {
    expect(slug('Çalışma Alanı')).toBe('calisma-alani');
    expect(slug('  dev.v2_final  ')).toBe('dev.v2_final');
    for (const name of ['My.Theme_v2!', 'Çalışma Alanı', '..__x', 'a'.repeat(80), '-x-', 'A_._B'])
      expect(marketSlug(name), name).toMatch(MARKET_PART);
    expect(marketSlug('My.Theme_v2!')).toBe('my-theme-v2');
    expect(marketSlug('')).toBe('entry');
    expect(marketSlug('._')).toBe('entry');
    expect(marketSlug(`${'a'.repeat(38)}.b`)).toBe('a'.repeat(38));
    expect(ENTRY_ID_RE.test(ID)).toBe(true);
  });
});
