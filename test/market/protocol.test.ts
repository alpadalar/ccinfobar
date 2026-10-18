import { describe, expect, it } from 'vitest';
import { systemEntries } from '../../src/catalog/system.js';
import * as edit from '../../src/core/edit.js';
import { LAYOUT_KEYS as EDIT_LAYOUT_KEYS } from '../../src/core/edit.js';
import type { EntryKind } from '../../src/core/entry-keys.js';
import { APPEARANCE_KEYS, LAYOUT_KEYS, PERSONAL_KEYS } from '../../src/core/entry-keys.js';
import {
  adminActionPath,
  adminEntryPath,
  adminPendingPath,
  adminPublisherPath,
  adminReportsPath,
  adminResolvePath,
  authGithubPath,
  canonicalJson,
  contentProblems,
  ERROR_CODES,
  entriesPath,
  entryPath,
  ID_PART_RE,
  INDEX_PAGE,
  indexPath,
  isRemoteId,
  LIST_CAP,
  logoutPath,
  MARKET_LIMITS,
  MAX_PAGES,
  mePath,
  metaPath,
  PROTOCOL_VERSION,
  parseErrorBody,
  parseIndex,
  parseMe,
  parseMeta,
  parsePending,
  parsePublishPayload,
  parseRemoteEntry,
  parseRemoteVersion,
  parseReports,
  parseReview,
  parseSignIn,
  parseVersionPayload,
  publishersPath,
  REPORT_REASON_MAX,
  reportPath,
  versionPath,
  versionPutPath,
  versionsPath,
  withdrawPath,
} from '../../src/market/protocol.js';

const H = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

const summary = (over: Record<string, unknown> = {}) => ({
  id: 'alp/nord-cockpit',
  kind: 'bundle',
  name: 'Nord cockpit',
  description: 'Cool colors',
  author: 'Alp',
  publisher: 'alp',
  version: 2,
  updatedAt: '2026-10-16T08:00:00.000Z',
  hash: H,
  ...over,
});

const layout = (items: unknown[]) => ({ lines: [items] });

describe('market protocol', () => {
  it('canonicalJson sorts keys and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    );
    expect(canonicalJson({ a: undefined, b: 'x y', c: null, d: true })).toBe('{"b":"x y","c":null,"d":true}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
    expect(canonicalJson('ç\n')).toBe(JSON.stringify('ç\n'));
    const a = canonicalJson({ x: 1, y: [1, 2] });
    expect(canonicalJson({ y: [1, 2], x: 1 })).toBe(a);
    expect(canonicalJson(JSON.parse('{"__proto__":{"p":1},"a":1}'))).toBe('{"__proto__":{"p":1},"a":1}');
  });

  it('paths are static .json GETs under /v1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(metaPath()).toBe('/v1/meta.json');
    expect(indexPath()).toBe('/v1/index.json');
    expect(indexPath(1)).toBe('/v1/index.json');
    expect(indexPath(2)).toBe('/v1/index-2.json');
    expect(entryPath('alp/nord-cockpit')).toBe('/v1/entries/alp/nord-cockpit.json');
    expect(versionPath('alp/x', 3)).toBe('/v1/entries/alp/x/3.json');
    expect(versionPath('alp/x', 3).endsWith('/x/3.json')).toBe(true);
    expect(entriesPath()).toBe('/v1/entries');
    expect(versionsPath('alp/x')).toBe('/v1/entries/alp/x/versions');
    expect(versionPutPath('alp/x', 2)).toBe('/v1/entries/alp/x/versions/2');
    expect(withdrawPath('alp/x')).toBe('/v1/entries/alp/x');
    expect(publishersPath()).toBe('/v1/publishers');
    for (const bad of ['../x', 'Alp/X', 'alp', 'alp/x/y', 'alp/../x', 'alp/x.json', '', 'alp/%2e']) {
      expect(() => entryPath(bad), bad).toThrow();
      expect(() => versionPath(bad, 1), bad).toThrow();
      expect(() => versionsPath(bad), bad).toThrow();
      expect(() => versionPutPath(bad, 1), bad).toThrow();
      expect(() => withdrawPath(bad), bad).toThrow();
    }
    for (const n of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => versionPath('alp/x', n), String(n)).toThrow();
      expect(() => versionPutPath('alp/x', n), String(n)).toThrow();
    }
  });

  it('ids match <publisher>/<slug> with the part regex (D-26)', () => {
    expect(ID_PART_RE.test('a')).toBe(true);
    expect(ID_PART_RE.test(`a${'x'.repeat(38)}`)).toBe(true);
    expect(ID_PART_RE.test(`a${'x'.repeat(39)}`)).toBe(false);
    expect(isRemoteId('a/b')).toBe(true);
    expect(isRemoteId('alp/nord-cockpit')).toBe(true);
    expect(isRemoteId('0-a/9')).toBe(true);
    for (const bad of ['a', 'a/b/c', '-a/b', `a/${'x'.repeat(40)}`, 'A/b', 'a/b_', 'a/ b', '/b', 'a/']) {
      expect(isRemoteId(bad), bad).toBe(false);
    }
    expect(isRemoteId(42 as unknown as string)).toBe(false);
  });

  it('exports limits and error codes', () => {
    expect(MARKET_LIMITS).toEqual({
      maxEntryBytes: 256 * 1024,
      maxBodyBytes: 1024 * 1024,
      name: 64,
      description: 200,
      author: 64,
      note: 200,
      displayName: 64,
    });
    expect(ERROR_CODES).toContain('stale');
    expect(ERROR_CODES).toContain('unauthorized');
    expect(ERROR_CODES).toContain('over-quota');
    expect(ERROR_CODES).toContain('version-dropped');
    expect(ERROR_CODES).toHaveLength(17);
  });

  it('parsers whitelist fields and sanitize text', () => {
    const raw = {
      generatedAt: '2026-10-16T08:00:00.000Z',
      extra: 1,
      entries: [
        summary({
          name: '\u001b[31mNord\u001b[0m ‮cockpit',
          description: 'd'.repeat(500),
          secret: 'x',
        }),
      ],
    };
    const idx = parseIndex(raw)!;
    expect(idx).not.toBeNull();
    expect(Object.keys(idx).sort()).toEqual(['entries', 'generatedAt']);
    const e = idx.entries[0]!;
    expect(e.name).toBe('Nord cockpit');
    expect(e.description).toHaveLength(200);
    expect('secret' in e).toBe(false);
    expect(Object.keys(e).sort()).toEqual(
      ['author', 'description', 'hash', 'id', 'kind', 'name', 'publisher', 'updatedAt', 'version'].sort(),
    );
    expect(parseIndex({ entries: {} })).toBeNull();
    expect(parseIndex({ entries: 'x' })).toBeNull();
    expect(parseIndex(null)).toBeNull();
    expect(parseIndex([])).toBeNull();
  });

  it('a summary may have an empty name only when withdrawn (WR-08)', () => {
    const tomb = { ...summary({ name: '', description: '', author: '' }), withdrawn: true };
    expect(parseIndex({ entries: [tomb] })!.entries).toHaveLength(1);
    expect(parseIndex({ entries: [{ ...tomb, withdrawn: false }] })!.entries).toEqual([]);
  });

  it('parseIndex keeps a next link only to the following page, up to the last page (CR-03)', () => {
    const next = (link: unknown, page?: number) => parseIndex({ entries: [], next: link }, page)?.next;
    expect(next('index-2.json')).toBe('index-2.json');
    expect(next('index-4.json', 3)).toBe('index-4.json');
    expect(next('index-3.json')).toBeUndefined();
    expect(next('index.json')).toBeUndefined();
    expect(next('../index-2.json')).toBeUndefined();
    expect(next('https://evil.example/index-2.json')).toBeUndefined();
    expect(next(2)).toBeUndefined();
    expect(next('index-11.json', MAX_PAGES)).toBeUndefined();
    expect(MAX_PAGES * INDEX_PAGE).toBe(5000);
  });

  it('parseIndex drops bad summaries and caps the list', () => {
    const bad = [
      summary({ id: '../x' }),
      summary({ kind: 'script' }),
      summary({ version: 0 }),
      summary({ version: 1.5 }),
      summary({ hash: 'nope' }),
      summary({ name: 5 }),
      summary({ name: '\u001b[0m' }),
      summary({ publisher: 'mallory' }),
      'x',
      null,
    ];
    const idx = parseIndex({ generatedAt: 'now', entries: [...bad, summary({ withdrawn: true })] })!;
    expect(idx.entries).toHaveLength(1);
    expect(idx.entries[0]!.withdrawn).toBe(true);
    const many = Array.from({ length: 5100 }, (_, i) => summary({ id: `alp/e${i}` }));
    expect(parseIndex({ generatedAt: 'now', entries: many })!.entries).toHaveLength(5000);
    const noPub = summary();
    delete (noPub as Record<string, unknown>).publisher;
    expect(parseIndex({ entries: [noPub] })!.entries[0]!.publisher).toBe('alp');
    expect(parseIndex({ entries: [] })!.generatedAt).toBe('');
  });

  it('parseMeta keeps typed capabilities, auth and limits', () => {
    const m = parseMeta({
      protocol: 1,
      name: 'Test \u001b[1mmarket',
      capabilities: { write: true, overwrite: 'yes', withdraw: true, submit: 'api', run: true },
      auth: ['token', 'BAD KIND', 7, 'github-device'],
      limits: { maxEntryBytes: 1000, name: -1, note: 1.5, evil: 3 },
      submitUrl: 'https://example.com/submit',
      other: 1,
    })!;
    expect(m).toEqual({
      protocol: 1,
      name: 'Test market',
      capabilities: { write: true, overwrite: false, withdraw: true, submit: 'api' },
      auth: ['token', 'github-device'],
      limits: { maxEntryBytes: 1000 },
      submitUrl: 'https://example.com/submit',
    });
    const s = parseMeta({ protocol: 1, name: 'x', capabilities: {}, submitUrl: 'javascript:alert(1)' })!;
    expect(s.capabilities).toEqual({
      write: false,
      overwrite: false,
      withdraw: false,
      submit: 'pull-request',
    });
    expect(s.auth).toEqual([]);
    expect(s.limits).toEqual({});
    expect('submitUrl' in s).toBe(false);
    const submit = (u: string) =>
      parseMeta({ protocol: 1, name: 'x', capabilities: {}, submitUrl: u })!.submitUrl;
    expect(submit('http://example.com/submit')).toBeUndefined();
    expect(submit('https://example.com/submit')).toBe('https://example.com/submit');
    expect(submit('http://127.0.0.1:4000/submit')).toBe('http://127.0.0.1:4000/submit');
    expect(submit('http://[::1]:4000/s')).toBe('http://[::1]:4000/s');
    expect(submit('http://localhost/s')).toBe('http://localhost/s');
    expect(submit('file:///etc/passwd')).toBeUndefined();
    expect(parseMeta({ protocol: 2, name: 'x', capabilities: {} })).toBeNull();
    expect(parseMeta({ protocol: 1, capabilities: {} })).toBeNull();
    expect(parseMeta({ protocol: 1, name: 'x' })).toBeNull();
    expect(parseMeta('x')).toBeNull();
  });

  it('parseRemoteEntry keeps an ascending version history', () => {
    const raw = {
      ...summary(),
      versions: [
        { version: 1, at: '2026-10-01T00:00:00.000Z', note: 'first\u0007', hash: H2, x: 1 },
        { version: 2, at: '2026-10-16T08:00:00.000Z', note: 'n'.repeat(300), hash: H },
      ],
    };
    const e = parseRemoteEntry(raw)!;
    expect(e.versions).toEqual([
      { version: 1, at: '2026-10-01T00:00:00.000Z', note: 'first', hash: H2 },
      { version: 2, at: '2026-10-16T08:00:00.000Z', note: 'n'.repeat(200), hash: H },
    ]);
    expect(e.id).toBe('alp/nord-cockpit');
    expect(parseRemoteEntry({ ...raw, versions: [] })).toBeNull();
    expect(parseRemoteEntry({ ...raw, versions: [raw.versions[1], raw.versions[0]] })).toBeNull();
    expect(parseRemoteEntry({ ...raw, version: 3 })).toBeNull();
    expect(parseRemoteEntry({ ...raw, versions: 'x' })).toBeNull();
    expect(
      parseRemoteEntry({ ...raw, versions: [{ ...raw.versions[0], hash: 'x' }, raw.versions[1]] }),
    ).toBeNull();
    expect(parseRemoteEntry({ ...raw, id: 'Alp/x' })).toBeNull();
  });

  it('parseRemoteVersion keeps known content sections only', () => {
    const v = parseRemoteVersion({
      version: 2,
      hash: H,
      extra: true,
      content: {
        layout: { lines: [[{ id: 'a', type: 'model', label: '\u001b[31mM' }]] },
        appearance: { theme: 'nord' },
        script: 'rm -rf /',
      },
    })!;
    expect(v).toEqual({
      version: 2,
      hash: H,
      content: {
        layout: { lines: [[{ id: 'a', type: 'model', label: 'M' }]] },
        appearance: { theme: 'nord' },
      },
    });
    expect(parseRemoteVersion({ version: 2, hash: H, content: [] })).toBeNull();
    expect(parseRemoteVersion({ version: 2, hash: H, content: { layout: 'x' } })).toBeNull();
    expect(parseRemoteVersion({ version: 0, hash: H, content: {} })).toBeNull();
    expect(parseRemoteVersion({ version: 1, hash: 'z', content: {} })).toBeNull();
  });

  it('parsePublishPayload and parseVersionPayload validate writes', () => {
    const content = { layout: layout([{ id: 'a', type: 'model' }]) };
    const p = parsePublishPayload({
      kind: 'preset',
      slug: 'my-preset',
      name: '  My ‮preset  ',
      description: 'd',
      author: 'a'.repeat(100),
      content,
      note: 'first',
      publisher: 'mallory',
    })!;
    expect(p).toEqual({
      kind: 'preset',
      slug: 'my-preset',
      name: 'My preset',
      description: 'd',
      author: 'a'.repeat(64),
      content,
      note: 'first',
    });
    expect(parsePublishPayload({ ...p, slug: 'Bad_Slug' })).toBeNull();
    expect(parsePublishPayload({ ...p, kind: 'command' })).toBeNull();
    expect(parsePublishPayload({ ...p, name: '   ' })).toBeNull();
    expect(parsePublishPayload({ ...p, content: null })).toBeNull();
    const d = parsePublishPayload({ kind: 'preset', slug: 's', name: 'n', content })!;
    expect(d.description).toBe('');
    expect(d.author).toBe('');
    expect(d.note).toBe('');

    expect(parseVersionPayload({ content, note: 'v2', other: 1 })).toEqual({ content, note: 'v2' });
    expect(parseVersionPayload({ content, note: 'v2', name: 'New', description: 'D' })).toEqual({
      content,
      note: 'v2',
      name: 'New',
      description: 'D',
    });
    expect(parseVersionPayload({ content, name: ' ' })).toBeNull();
    expect(parseVersionPayload({ note: 'x' })).toBeNull();
    expect(parseVersionPayload({ content })!.note).toBe('');
  });

  it('parseErrorBody keeps only known codes', () => {
    expect(parseErrorBody({ error: { code: 'stale', message: 'x' } })).toBe('stale');
    expect(parseErrorBody({ error: { code: 'pwned', message: 'x' } })).toBeNull();
    expect(parseErrorBody({ error: 'stale' })).toBeNull();
    expect(parseErrorBody({ error: { code: 'toString' } })).toBeNull();
    expect(parseErrorBody(null)).toBeNull();
    for (const c of ERROR_CODES) expect(parseErrorBody({ error: { code: c } })).toBe(c);
  });

  it('never lets __proto__ keys reach parser output', () => {
    const evil = '{"__proto__":{"polluted":1},"x":1}';
    const content = JSON.parse(
      `{"__proto__":{"polluted":1},"layout":{"__proto__":{"polluted":1},"lines":[[{"id":"a","type":"model","options":${evil}}]]}}`,
    );
    const outputs = [
      parseIndex(
        JSON.parse(
          `{"__proto__":{"polluted":1},"entries":[${JSON.stringify(summary()).replace('{', '{"__proto__":{"polluted":1},')}]}`,
        ),
      ),
      parseMeta(
        JSON.parse(
          '{"__proto__":{"polluted":1},"protocol":1,"name":"x","capabilities":{"__proto__":{"polluted":1}},"limits":{"__proto__":{"polluted":1}}}',
        ),
      ),
      parseRemoteVersion({ version: 1, hash: H, content }),
      parsePublishPayload({ kind: 'preset', slug: 's', name: 'n', content }),
      parseVersionPayload({ content }),
    ];
    const walk = (v: unknown): void => {
      if (!v || typeof v !== 'object') return;
      expect(Object.hasOwn(v, '__proto__')).toBe(false);
      expect((v as Record<string, unknown>).polluted).toBeUndefined();
      for (const x of Object.values(v)) walk(x);
    };
    for (const o of outputs) {
      expect(o).not.toBeNull();
      walk(o);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('content policy rejects command, http and env widgets and unsafe links', () => {
    const bundle = (items: unknown[]) => ({ layout: layout(items), appearance: { theme: 'nord' } });
    expect(
      contentProblems('bundle', bundle([{ id: 'c', type: 'command', options: { command: 'id' } }])),
    ).toContain('command-widget');
    expect(contentProblems('bundle', bundle([{ id: 'c', type: 'command' }]))).toContain('command-widget');
    expect(
      contentProblems('bundle', bundle([{ id: 'h', type: 'http', options: { url: 'https://example.com' } }])),
    ).toContain('http-widget');
    expect(
      contentProblems('bundle', bundle([{ id: 'l', type: 'link', options: { url: 'javascript:alert(1)' } }])),
    ).toContain('unsafe-link');
    expect(
      contentProblems('bundle', bundle([{ id: 'l', type: 'link', options: { url: 'data:text/html,x' } }])),
    ).toContain('unsafe-link');
    for (const url of [
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'mailto:a@example.com',
      'ftp://example.com/x',
    ]) {
      expect(contentProblems('bundle', bundle([{ id: 'l', type: 'link', options: { url } }]))).toContain(
        'unsafe-link',
      );
    }
    expect(
      contentProblems('bundle', bundle([{ id: 'e', type: 'env', options: { name: 'GITHUB_TOKEN' } }])),
    ).toContain('env-widget');
    expect(contentProblems('preset', { layout: layout([{ id: 'e', type: 'env' }]) })).toContain('env-widget');
    expect(
      contentProblems(
        'bundle',
        bundle([{ id: 'l', type: 'link', options: { url: 'http://example.com/a' } }]),
      ),
    ).toEqual([]);
    expect(
      contentProblems(
        'bundle',
        bundle([{ id: 'l', type: 'link', options: { url: 'https://example.com/a' } }]),
      ),
    ).toEqual([]);
    expect(contentProblems('preset', { layout: { lines: 'x' } })).toContain('bad-lines');
    expect(contentProblems('preset', { layout: { lines: [[null]] } })).toContain('bad-lines');
    expect(contentProblems('preset', { layout: {} })).toContain('bad-lines');
  });

  it('PERSONAL keys are a policy problem', () => {
    const lines = [[{ id: 'm', type: 'model' }]];
    expect(contentProblems('preset', { layout: { lines, budget: { daily: 5 } } })).toContain(
      'personal-key:budget',
    );
    expect(
      contentProblems('bundle', { layout: { lines }, appearance: { theme: 'x', language: 'tr' } }),
    ).toContain('personal-key:language');
    expect(contentProblems('preset', { layout: { lines, theme: 'nord' } })).toContain('unknown-key:theme');
    expect(contentProblems('preset', { layout: { lines, wat: 1 } })).toContain('unknown-key:wat');
    expect(contentProblems('preset', { layout: { lines }, appearance: { theme: 'x' } })).toContain(
      'unknown-key:appearance',
    );
    expect(
      contentProblems('theme', { appearance: { theme: 'x' }, theme: { colors: {}, run: 'x' } }),
    ).toContain('unknown-key:theme.run');
    expect(contentProblems('theme', { appearance: { theme: 'x' }, theme: 'x' })).toContain('bad-theme');
  });

  it('reports missing sections, non-objects and oversize content', () => {
    expect(contentProblems('preset', null)).toEqual(['not-object']);
    expect(contentProblems('preset', [])).toEqual(['not-object']);
    expect(contentProblems('preset', {})).toContain('layout-missing');
    expect(contentProblems('bundle', { layout: { lines: [] } })).toContain('appearance-missing');
    expect(contentProblems('theme', {})).toContain('appearance-missing');
    expect(contentProblems('theme', { theme: { colors: {} } })).toEqual([]);
    const big = {
      layout: { lines: [[{ id: 'a', type: 'text', options: { text: 'x'.repeat(300 * 1024) } }]] },
    };
    expect(contentProblems('preset', big)).toContain('too-large');
  });

  it('clean system content passes the policy', () => {
    const all = [...systemEntries({ gsd: true }), ...systemEntries({ gsd: false })];
    expect(all.some((e) => e.kind === 'bundle')).toBe(true);
    for (const e of all) expect(contentProblems(e.kind, e.content), e.ref).toEqual([]);
  });

  it('contentProblems gives the same result with a precomputed canonical string', () => {
    const lines = [[{ id: 'm', type: 'model' }]];
    const bundle = (items: unknown[]) => ({ layout: layout(items), appearance: { theme: 'nord' } });
    const fixtures: [EntryKind, unknown][] = [
      ['bundle', bundle([{ id: 'c', type: 'command', options: { command: 'id' } }])],
      ['bundle', bundle([{ id: 'h', type: 'http', options: { url: 'https://example.com' } }])],
      ['bundle', bundle([{ id: 'l', type: 'link', options: { url: 'javascript:alert(1)' } }])],
      ['bundle', bundle([{ id: 'l', type: 'link', options: { url: 'https://example.com/a' } }])],
      ['bundle', bundle([{ id: 'e', type: 'env', options: { name: 'GITHUB_TOKEN' } }])],
      ['preset', { layout: { lines: 'x' } }],
      ['preset', { layout: { lines: [[null]] } }],
      ['preset', { layout: {} }],
      ['preset', { layout: { lines, budget: { daily: 5 } } }],
      ['bundle', { layout: { lines }, appearance: { theme: 'x', language: 'tr' } }],
      ['preset', { layout: { lines, wat: 1 } }],
      ['theme', { appearance: { theme: 'x' }, theme: { colors: {}, run: 'x' } }],
      ['theme', { appearance: { theme: 'x' }, theme: 'x' }],
      ['preset', null],
      ['preset', []],
      ['preset', {}],
      ['bundle', { layout: { lines: [] } }],
      ['theme', {}],
      ['theme', { theme: { colors: {} } }],
      [
        'preset',
        { layout: { lines: [[{ id: 'a', type: 'text', options: { text: 'x'.repeat(300 * 1024) } }]] } },
      ],
      ...[...systemEntries({ gsd: true }), ...systemEntries({ gsd: false })].map(
        (e) => [e.kind, e.content] as [EntryKind, unknown],
      ),
    ];
    for (const [kind, c] of fixtures) {
      expect(contentProblems(kind, c, canonicalJson(c))).toEqual(contentProblems(kind, c));
    }
  });

  it('contentProblems uses the precomputed canonical string for the size check', () => {
    const c = { layout: layout([{ id: 'm', type: 'model' }]) };
    expect(contentProblems('preset', c)).toEqual([]);
    expect(contentProblems('preset', c, 'x'.repeat(MARKET_LIMITS.maxEntryBytes + 1))).toEqual(['too-large']);
    expect(contentProblems('preset', c, 'x'.repeat(MARKET_LIMITS.maxEntryBytes))).toEqual([]);
  });

  it('edit.ts re-exports the entry key lists from entry-keys.ts', () => {
    expect(EDIT_LAYOUT_KEYS).toBe(LAYOUT_KEYS);
    expect(edit.APPEARANCE_KEYS).toBe(APPEARANCE_KEYS);
    expect(edit.PERSONAL_KEYS).toBe(PERSONAL_KEYS);
  });
});

describe('market protocol: sign-in, accounts, reports and moderation', () => {
  const TOKEN = 'c'.repeat(64);
  const meta = (over: Record<string, unknown> = {}) =>
    parseMeta({ protocol: 1, name: 'x', capabilities: { write: true, submit: 'api' }, ...over });

  it('parseMeta keeps old results and adds github, review, report and quota', () => {
    const old = meta()!;
    expect(old).toEqual({
      protocol: 1,
      name: 'x',
      capabilities: { write: true, overwrite: false, withdraw: false, submit: 'api' },
      auth: [],
      limits: {},
    });
    expect(Object.keys(old).sort()).toEqual(['auth', 'capabilities', 'limits', 'name', 'protocol']);
    expect(Object.keys(old.capabilities).sort()).toEqual(['overwrite', 'submit', 'withdraw', 'write']);
    const m = meta({
      capabilities: { write: true, submit: 'api', review: true, report: true },
      auth: ['github-device'],
      github: { clientId: 'Ov23liVCN9Nf6VlLv3St', secret: 'x' },
      quota: { publisherBytes: 20_971_520, other: 1 },
    })!;
    expect(m.capabilities.review).toBe(true);
    expect(m.capabilities.report).toBe(true);
    expect(m.github).toEqual({ clientId: 'Ov23liVCN9Nf6VlLv3St' });
    expect(m.quota).toEqual({ publisherBytes: 20_971_520 });
    const caps = (c: Record<string, unknown>) => meta({ capabilities: { write: true, ...c } })!.capabilities;
    for (const v of ['true', 1, {}, false, null]) {
      expect('review' in caps({ review: v }), String(v)).toBe(false);
      expect('report' in caps({ report: v }), String(v)).toBe(false);
    }
    const id = (v: unknown) => meta({ github: { clientId: v } })!.github;
    expect(id('Iv1.abc_DEF-9')).toEqual({ clientId: 'Iv1.abc_DEF-9' });
    expect(id('Ov23 liVC')).toBeUndefined();
    expect(id('a'.repeat(200))).toBeUndefined();
    expect(id('a'.repeat(64))).toEqual({ clientId: 'a'.repeat(64) });
    expect(id('abc')).toBeUndefined();
    expect(id(42)).toBeUndefined();
    expect(meta({ github: 'Ov23liVCN9Nf6VlLv3St' })!.github).toBeUndefined();
    for (const q of [
      { publisherBytes: -1 },
      { publisherBytes: 1.5 },
      { publisherBytes: '9' },
      {},
      'x',
      null,
    ]) {
      expect('quota' in meta({ quota: q })!, JSON.stringify(q)).toBe(false);
    }
  });

  it('builds the new route paths', () => {
    expect(authGithubPath()).toBe('/v1/auth/github');
    expect(logoutPath()).toBe('/v1/auth/logout');
    expect(mePath()).toBe('/v1/me');
    expect(reportPath('alp/nord')).toBe('/v1/entries/alp/nord/reports');
    expect(adminPendingPath()).toBe('/v1/admin/pending');
    expect(adminReportsPath()).toBe('/v1/admin/reports');
    expect(adminEntryPath('alp/nord')).toBe('/v1/admin/entries/alp/nord');
    for (const a of ['approve', 'reject', 'remove'] as const) {
      expect(adminActionPath('alp/nord', a)).toBe(`/v1/admin/entries/alp/nord/${a}`);
    }
    expect(adminPublisherPath('alp', 'ban')).toBe('/v1/admin/publishers/alp/ban');
    expect(adminPublisherPath('alp-2', 'unban')).toBe('/v1/admin/publishers/alp-2/unban');
    expect(adminResolvePath(7)).toBe('/v1/admin/reports/7/resolve');
  });

  it('new route paths refuse bad ids, handles, actions and report ids', () => {
    for (const bad of ['A/b', '../x', 'alp', 'alp/../x', 'alp/Nord', '']) {
      expect(() => reportPath(bad), bad).toThrow();
      expect(() => adminEntryPath(bad), bad).toThrow();
      expect(() => adminActionPath(bad, 'approve'), bad).toThrow();
    }
    expect(() => adminActionPath('alp/nord', 'delete' as never)).toThrow();
    for (const bad of ['Alp', '../x', 'a/b', '', '-x', 'a'.repeat(40)]) {
      expect(() => adminPublisherPath(bad, 'ban'), bad).toThrow();
    }
    expect(() => adminPublisherPath('alp', 'kick' as never)).toThrow();
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53, '3' as never]) {
      expect(() => adminResolvePath(bad), String(bad)).toThrow();
    }
  });

  it('parseSignIn needs a handle and a 64-hex token', () => {
    const ok = { handle: 'octo-cat', token: TOKEN, displayName: 'Octo \u001b[1mCat', admin: true, extra: 1 };
    expect(parseSignIn(ok)).toEqual({
      handle: 'octo-cat',
      token: TOKEN,
      displayName: 'Octo Cat',
      admin: true,
    });
    expect(parseSignIn({ ...ok, admin: 'yes' })!.admin).toBe(false);
    expect(parseSignIn({ handle: 'a', token: TOKEN })).toEqual({
      handle: 'a',
      token: TOKEN,
      displayName: '',
      admin: false,
    });
    expect(parseSignIn({ ...ok, displayName: 'x'.repeat(500) })!.displayName).toHaveLength(
      MARKET_LIMITS.displayName,
    );
    for (const token of ['C'.repeat(64), 'c'.repeat(63), 'c'.repeat(65), 'gho_abc', 7, undefined]) {
      expect(parseSignIn({ ...ok, token }), String(token)).toBeNull();
    }
    for (const handle of ['Octo', '../x', '', 5]) expect(parseSignIn({ ...ok, handle })).toBeNull();
    expect(parseSignIn({ ...ok, displayName: 5 })).toBeNull();
    expect(parseSignIn(null)).toBeNull();
    expect(parseSignIn([ok])).toBeNull();
  });

  it('parseMe keeps valid entries only and caps the list', () => {
    const base = {
      handle: 'alp',
      displayName: 'Alp',
      login: 'AlpAdalar',
      admin: true,
      trusted: false,
      entries: [
        { id: 'alp/one', state: 'pending', version: 1 },
        { id: 'alp/two', state: 'live', version: 3 },
        { id: 'alp/Bad', state: 'live', version: 1 },
        { id: 'alp/three', state: 'withdrawn', version: 1 },
        { id: 'alp/four', state: 'live', version: 0 },
        { id: 'alp/one', state: 'live', version: 2 },
        'x',
      ],
    };
    expect(parseMe(base)).toEqual({
      handle: 'alp',
      displayName: 'Alp',
      login: 'AlpAdalar',
      admin: true,
      trusted: false,
      entries: [
        { id: 'alp/one', state: 'pending', version: 1 },
        { id: 'alp/two', state: 'live', version: 3 },
      ],
    });
    const many = Array.from({ length: LIST_CAP + 50 }, (_, i) => ({
      id: `alp/e${i}`,
      state: 'live',
      version: 1,
    }));
    expect(parseMe({ ...base, entries: many })!.entries).toHaveLength(LIST_CAP);
    expect(LIST_CAP).toBe(200);
    expect(parseMe({ ...base, trusted: 1, admin: 'true' })).toMatchObject({ admin: false, trusted: false });
    for (const bad of [
      { ...base, handle: 'Alp' },
      { ...base, login: 'bad login' },
      { ...base, login: '-x' },
      { ...base, entries: 'x' },
      { ...base, displayName: [] },
    ]) {
      expect(parseMe(bad)).toBeNull();
    }
    expect(parseMe({ ...base, entries: undefined })!.entries).toEqual([]);
    expect(parseMe('x')).toBeNull();
  });

  it('parsePending keeps summaries with a createdAt', () => {
    const at = '2026-10-17T10:00:00.000Z';
    const p = parsePending({
      entries: [
        { ...summary(), createdAt: at },
        { ...summary({ id: 'alp/no-stamp' }) },
        { ...summary({ id: 'alp/x', hash: 'nope' }), createdAt: at },
        { ...summary(), createdAt: at },
        { ...summary({ id: 'bob/y', publisher: 'bob', name: 'Y \u0007' }), createdAt: at },
      ],
    })!;
    expect(p.entries.map((e) => e.id)).toEqual(['alp/nord-cockpit', 'bob/y']);
    expect(p.entries[0]).toEqual({ ...summary(), createdAt: at });
    expect(p.entries[1]!.name).toBe('Y');
    const many = Array.from({ length: 250 }, (_, i) => ({ ...summary({ id: `alp/e${i}` }), createdAt: at }));
    expect(parsePending({ entries: many })!.entries).toHaveLength(LIST_CAP);
    expect(parsePending({ entries: 'x' })).toBeNull();
    expect(parsePending(null)).toBeNull();
  });

  it('parseReports keeps bounded, sanitized reports', () => {
    const at = '2026-10-17T10:00:00.000Z';
    const r = { id: 3, entry: 'alp/nord', reporter: 'bob', reason: 'Spam \u001b[31mlink', createdAt: at };
    const p = parseReports({
      reports: [
        r,
        { ...r, id: 0 },
        { ...r, id: 4, entry: 'Alp/x' },
        { ...r, id: 5, reporter: 'B' },
        { ...r, id: 6, reason: '   ' },
        { ...r, id: 7, reason: 'x'.repeat(900) },
        { ...r, id: 3 },
        { ...r, id: 8, createdAt: 5 },
      ],
    })!;
    expect(p.reports.map((x) => x.id)).toEqual([3, 7]);
    expect(p.reports[0]).toEqual({ ...r, reason: 'Spam link' });
    expect(p.reports[1]!.reason).toHaveLength(REPORT_REASON_MAX);
    const many = Array.from({ length: 250 }, (_, i) => ({ ...r, id: i + 1 }));
    expect(parseReports({ reports: many })!.reports).toHaveLength(LIST_CAP);
    expect(parseReports({ reports: {} })).toBeNull();
    expect(parseReports(7)).toBeNull();
  });

  it('parseReview returns the entry with its state, the content and the hash', () => {
    const entry = { ...summary({ version: 1 }), versions: [{ version: 1, at: 'x', note: '', hash: H }] };
    const content = { layout: layout([{ id: 'm', type: 'model' }]) };
    const v = parseReview({ entry: { ...entry, state: 'pending' }, content, hash: H })!;
    expect(v.entry.state).toBe('pending');
    expect(v.entry.id).toBe('alp/nord-cockpit');
    expect(v.entry.versions).toHaveLength(1);
    expect(v.content).toEqual(content);
    expect(v.hash).toBe(H);
    for (const s of ['live', 'withdrawn', 'removed']) {
      expect(parseReview({ entry: { ...entry, state: s }, content, hash: H })!.entry.state).toBe(s);
    }
    expect(parseReview({ entry: { ...entry, state: 'deleted' }, content, hash: H })).toBeNull();
    expect(parseReview({ entry: { ...entry, state: 'live' }, content, hash: 'x' })).toBeNull();
    expect(parseReview({ entry: { ...entry, state: 'live' }, content: [], hash: H })).toBeNull();
    expect(parseReview({ entry: { ...entry, versions: [], state: 'live' }, content, hash: H })).toBeNull();
    expect(parseReview(null)).toBeNull();
  });

  it('parseErrorBody accepts the new wire codes', () => {
    for (const c of ['banned', 'not-admin', 'upstream', 'unavailable']) {
      expect(ERROR_CODES).toContain(c);
      expect(parseErrorBody({ error: { code: c, message: 'x' } })).toBe(c);
    }
  });

  it('new parsers never let __proto__ keys through', () => {
    const p = (s: string) => JSON.parse(s);
    const outputs = [
      parseSignIn(p(`{"__proto__":{"polluted":1},"handle":"a","token":"${TOKEN}"}`)),
      parseMe(
        p(
          '{"__proto__":{"polluted":1},"handle":"a","login":"a","entries":[{"__proto__":{"polluted":1},"id":"a/b","state":"live","version":1}]}',
        ),
      ),
      parseMeta(
        p(
          '{"protocol":1,"name":"x","capabilities":{},"github":{"__proto__":{"polluted":1},"clientId":"abcd"},"quota":{"__proto__":{"polluted":1},"publisherBytes":5}}',
        ),
      ),
    ];
    const walk = (v: unknown): void => {
      if (!v || typeof v !== 'object') return;
      expect(Object.hasOwn(v, '__proto__')).toBe(false);
      expect((v as Record<string, unknown>).polluted).toBeUndefined();
      for (const x of Object.values(v)) walk(x);
    };
    for (const o of outputs) {
      expect(o).not.toBeNull();
      walk(o);
    }
  });
});
