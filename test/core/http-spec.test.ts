import { describe, expect, it } from 'vitest';
import { describeHeaders, externalTargets, redactUrl } from '../../src/core/http-report.js';
import {
  envRule,
  ghTokenNames,
  httpItemError,
  httpRefusal,
  NEEDS_TLS,
  normalizeHeaderSpec,
  parseHeaderSpec,
  parseUrlTemplate,
  resolveUrl,
} from '../../src/core/http-spec.js';
import type { WidgetItem } from '../../src/core/types.js';

describe('parseHeaderSpec', () => {
  it('parses env references with and without a scheme', () => {
    expect(parseHeaderSpec('Authorization=Bearer $RELAY_TOKEN, X-Api-Key=${PACKY_KEY}')).toEqual({
      headers: [
        { name: 'Authorization', scheme: 'Bearer', env: 'RELAY_TOKEN' },
        { name: 'X-Api-Key', env: 'PACKY_KEY' },
      ],
      errors: [],
    });
  });

  it('splits on newlines too', () => {
    const r = parseHeaderSpec('A=$X\r\nB=Token ${Y}\n\n');
    expect(r.errors).toEqual([]);
    expect(r.headers.map((h) => h.env)).toEqual(['X', 'Y']);
  });

  it('treats an empty spec as no headers', () => {
    expect(parseHeaderSpec('')).toEqual({ headers: [], errors: [] });
    expect(parseHeaderSpec('  ,\n ')).toEqual({ headers: [], errors: [] });
  });

  it('rejects literal values without echoing them', () => {
    const r = parseHeaderSpec('Authorization=Bearer abc123');
    expect(r.headers).toEqual([]);
    expect(r.errors.join()).toContain('literal');
    expect(r.errors.join()).not.toContain('abc123');
    expect(parseHeaderSpec('X=abc$TOKEN').errors.join()).not.toContain('abc');
  });

  it('rejects bad env names and bad entries', () => {
    expect(parseHeaderSpec('X=$1BAD').errors).toHaveLength(1);
    expect(parseHeaderSpec('X=${A-B}').errors).toHaveLength(1);
    expect(parseHeaderSpec(`X=$${'A'.repeat(65)}`).errors).toHaveLength(1);
    expect(parseHeaderSpec('X=Bearer Token $A').errors).toHaveLength(1);
    expect(parseHeaderSpec('sk-secret-value').errors.join()).not.toContain('secret');
    expect(parseHeaderSpec('Bad Name=$A').errors).toHaveLength(1);
    expect(parseHeaderSpec('=$A').errors).toHaveLength(1);
  });

  it.each(['Host=$H', 'content-length=$L', 'Connection=$C', 'Transfer-Encoding=$T', 'COOKIE=$C'])(
    'rejects the forbidden header %s',
    (spec) => {
      const r = parseHeaderSpec(spec);
      expect(r.headers).toEqual([]);
      expect(r.errors.join()).toContain('not allowed');
    },
  );

  it('rejects repeated names', () => {
    const r = parseHeaderSpec('A=$X, a=$Y');
    expect(r.headers).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
  });

  it('keeps at most 10 entries', () => {
    const spec = Array.from({ length: 11 }, (_, i) => `H${i}=$V${i}`).join(',');
    const r = parseHeaderSpec(spec);
    expect(r.headers).toHaveLength(10);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('10');
  });

  it('tolerates non-string input', () => {
    expect(parseHeaderSpec(undefined as any)).toEqual({ headers: [], errors: [] });
  });
});

describe('normalizeHeaderSpec', () => {
  it('is canonical across spacing and separators', () => {
    const a = normalizeHeaderSpec(parseHeaderSpec('A=$X,B=$Y').headers);
    expect(a).toBe(normalizeHeaderSpec(parseHeaderSpec(' A=$X ,\nB=$Y ').headers));
    expect(a).toBe('A=$X, B=$Y');
    expect(normalizeHeaderSpec(parseHeaderSpec('Authorization=Bearer ${T}').headers)).toBe(
      'Authorization=Bearer $T',
    );
    expect(normalizeHeaderSpec([])).toBe('');
  });
});

describe('parseUrlTemplate', () => {
  it('accepts placeholders in query values', () => {
    expect(parseUrlTemplate('https://api.example.com/v1/balance?key=${API_KEY}')).toEqual({
      ok: true,
      vars: ['API_KEY'],
      plain: false,
      hostname: 'api.example.com',
    });
    expect(parseUrlTemplate('http://localhost:8080/x?a=${A}&b=1&c=${B}&d=${A}#top')).toEqual({
      ok: true,
      vars: ['A', 'B'],
      plain: false,
      hostname: 'localhost',
    });
    expect(parseUrlTemplate('https://x.com/p?q=pre-${A}-post')).toMatchObject({ ok: true, vars: ['A'] });
    expect(parseUrlTemplate('https://x.com/')).toMatchObject({ ok: true, vars: [] });
    expect(parseUrlTemplate('https://x.com/?$top=5')).toMatchObject({ ok: true, vars: [] });
    expect(parseUrlTemplate('http://X.com/')).toEqual({ ok: true, vars: [], plain: true, hostname: 'x.com' });
    for (const raw of ['https://x.com/odata/$metadata', 'https://x.com/$batch?k=${K}', 'https://x.com/a%7Bb'])
      expect(parseUrlTemplate(raw).ok, raw).toBe(true);
  });

  it.each([
    'https://${HOST}.example.com/',
    'https://x.com/${P}/a',
    'https://x.com/#${H}',
    'https://x.com/?${K}=1',
    'https://x.com/?a=1#${H}',
    'https://x.com/a$%7BH%7D',
    'https://x.com/#$%7BH%7D',
    'https://x.com/?a=${1A}',
    'https://x.com/?a=${A',
  ])('rejects misplaced or bad placeholders in %s', (raw) => {
    expect(parseUrlTemplate(raw).ok).toBe(false);
  });

  it('rejects userinfo without echoing it', () => {
    const r = parseUrlTemplate('https://user:pass@x.com/');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('pass');
    expect(parseUrlTemplate('https://user@x.com/').ok).toBe(false);
  });

  it.each(['ftp://x.com', 'javascript:alert(1)', 'data:text/plain,x', 'file:///etc/passwd', 'x.com', ''])(
    'rejects %s',
    (raw) => {
      expect(parseUrlTemplate(raw).ok).toBe(false);
    },
  );

  it('rejects long urls, whitespace and control characters', () => {
    expect(parseUrlTemplate(`https://x.com/?a=${'b'.repeat(3000)}`).ok).toBe(false);
    expect(parseUrlTemplate('https://x.com/a b').ok).toBe(false);
    expect(parseUrlTemplate('https://x.com/\u0007').ok).toBe(false);
    expect(parseUrlTemplate('https://x.com/\u202e').ok).toBe(false);
    expect(parseUrlTemplate(42 as any).ok).toBe(false);
  });

  it('never echoes the url in errors', () => {
    const r = parseUrlTemplate('ftp://x.com/?key=SECRET123');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('SECRET123');
  });
});

describe('httpItemError', () => {
  it('refuses env values over plain http to a non-loopback host', () => {
    expect(httpItemError('http://api.example.com/q?key=${API_KEY}', '')).toBe(NEEDS_TLS);
    expect(httpItemError('http://api.example.com/q', 'Authorization=Bearer $T')).toBe(NEEDS_TLS);
    expect(httpItemError('http://api.example.com/q', '')).toBeNull();
    expect(httpItemError('https://api.example.com/q?key=${K}', 'Authorization=Bearer $T')).toBeNull();
    for (const host of ['localhost:8080', '127.0.0.1', '[::1]:9'])
      expect(httpItemError(`http://${host}/q?key=\${K}`, 'X=$T')).toBeNull();
  });

  it('passes url errors through', () => {
    expect(httpItemError('https://${H}.x.com/', '')).toBe('placeholders are only allowed in query values');
  });
});

describe('env deny-list', () => {
  it('refuses credentials of Claude, cloud and package tools anywhere', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'GOOGLE_API_KEY',
      'GCLOUD_TOKEN',
      'GCP_KEY',
      'AZURE_CLIENT_SECRET',
      'CCINFOBAR_X',
      'NPM_TOKEN',
      'NODE_AUTH_TOKEN',
      'SSH_AUTH_SOCK',
      'anthropic_api_key',
    ]) {
      expect(envRule(name, 'api.example.com'), name).toBe('denied');
      expect(httpRefusal('https://api.example.com/q', `X=$${name}`)).toEqual({
        code: `env ${name} denied`,
        message: `env ${name} is not allowed in http items`,
        key: 'headers',
      });
      expect(httpRefusal(`https://api.example.com/q?k=\${${name}}`, '')?.key).toBe('url');
    }
    for (const name of ['RELAY_TOKEN', 'OPENROUTER_KEY', 'MY_AWS', 'SSHKEY'])
      expect(envRule(name, 'x.com'), name).toBe('ok');
  });

  it('sends GitHub tokens only to GitHub hosts or hosts gh lists', () => {
    for (const host of ['api.github.com', 'api.acme.ghe.com'])
      expect(httpRefusal(`https://${host}/user`, 'Authorization=Bearer $GH_TOKEN', [])).toBeNull();
    const other = 'https://ghe.corp.example/api/v3/user';
    expect(envRule('GITHUB_TOKEN', 'ghe.corp.example')).toBe('gh');
    expect(httpRefusal(other, 'Authorization=Bearer $GITHUB_TOKEN')).toBeNull();
    expect(httpRefusal(other, 'Authorization=Bearer $GITHUB_TOKEN', ['ghe.corp.example'])).toBeNull();
    expect(httpRefusal(other, 'Authorization=Bearer $GITHUB_TOKEN', ['github.com'])).toMatchObject({
      code: 'env GITHUB_TOKEN denied',
      key: 'headers',
    });
    expect(ghTokenNames(other, 'A=$GH_TOKEN, B=$GH_ENTERPRISE_TOKEN, C=$RELAY')).toEqual([
      'GH_TOKEN',
      'GH_ENTERPRISE_TOKEN',
    ]);
    expect(ghTokenNames('https://api.github.com/x', 'A=$GH_TOKEN')).toEqual([]);
  });
});

describe('resolveUrl', () => {
  const raw = 'https://api.example.com/v1/balance?key=${API_KEY}&mode=1';

  it('substitutes encoded values', () => {
    const r = resolveUrl(raw, { API_KEY: 'a b&c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url.search).toBe('?key=a%20b%26c&mode=1');
    expect(r.url.searchParams.get('key')).toBe('a b&c');
    expect(r.url.hostname).toBe('api.example.com');
  });

  it('cannot move the host with a crafted value', () => {
    const r = resolveUrl('https://x.com/?a=${A}', { A: '#@evil.com/' });
    expect(r.ok && r.url.hostname).toBe('x.com');
  });

  it('reports a missing or empty env var', () => {
    expect(resolveUrl(raw, {})).toEqual({ ok: false, missing: 'API_KEY' });
    expect(resolveUrl(raw, { API_KEY: '' })).toEqual({ ok: false, missing: 'API_KEY' });
  });

  it('refuses values that cannot be encoded', () => {
    expect(resolveUrl(raw, { API_KEY: '\ud800' })).toEqual({
      ok: false,
      error: 'env API_KEY has an invalid value',
    });
  });

  it('reports an invalid template', () => {
    const r = resolveUrl('https://${H}.x.com/', { H: 'a' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && 'error' in r).toBe(true);
  });
});

describe('redactUrl', () => {
  it('hides query values, userinfo and hash', () => {
    expect(redactUrl('https://u:p@x.com/p?key=abc&mode=1#f')).toBe('https://x.com/p?key=\u2026&mode=\u2026');
    expect(redactUrl('https://x.com/p?key=${API_KEY}')).toBe('https://x.com/p?key=\u2026');
    expect(redactUrl('https://x.com/p?SECRETTOKEN')).toBe('https://x.com/p?\u2026');
    expect(redactUrl('https://x.com:8443')).toBe('https://x.com:8443/');
  });

  it('hides path segments that look like tokens', () => {
    const cases: [string, string][] = [
      [
        'https://hooks.example.com/services/T0AB12CD3/B0AB12CD3EF/aBcDeFgHiJkLmNoPqRsTuVwX?x=1',
        'https://hooks.example.com/services/T0AB12CD3/B0AB12CD3EF/\u2026?x=\u2026',
      ],
      [
        'https://discord.com/api/webhooks/123456789012345678/Zx9_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefGHIJ',
        'https://discord.com/api/webhooks/123456789012345678/\u2026',
      ],
      [
        'https://api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/getMe',
        'https://api.telegram.org/\u2026/getMe',
      ],
      ['https://api.telegram.org/bot123:SECRET/getMe', 'https://api.telegram.org/\u2026/getMe'],
    ];
    for (const [raw, want] of cases) expect(redactUrl(raw)).toBe(want);
    const keep = 'https://status.claude.com/api/v2/summary.json';
    expect(redactUrl(keep)).toBe(keep);
    expect(redactUrl('https://x.com/v1/users/balance/2026')).toBe('https://x.com/v1/users/balance/2026');
  });

  it('never returns an unparseable input', () => {
    expect(redactUrl('ht tp://bad?key=SECRET123')).not.toContain('SECRET123');
    expect(redactUrl(undefined as any)).not.toContain('undefined');
  });
});

describe('describeHeaders', () => {
  it('names env vars and their state, never values', () => {
    const out = describeHeaders('Authorization=Bearer $RELAY_TOKEN, X-Key=${MISSING}', {
      RELAY_TOKEN: 'tok-secret-1',
      MISSING: '',
    });
    expect(out).toEqual(['Authorization=$RELAY_TOKEN (set)', 'X-Key=$MISSING (unset)']);
    expect(out.join()).not.toContain('tok-secret-1');
  });
});

describe('externalTargets', () => {
  const item = (id: string, type: string, options?: WidgetItem['options']): WidgetItem => ({
    id,
    type,
    options,
  });

  it('lists every command and http url with its position', () => {
    const lines: WidgetItem[][] = [
      [item('a', 'model'), item('b', 'command', { command: 'echo hi' })],
      [item('c', 'http', { url: 'https://x.com/?k=${K}' }), item('d', 'http', { url: 'https://y.com/' })],
      [item('e', 'command', { command: '  ' }), item('f', 'http', {}), item('g', 'http', { url: 3 })],
    ];
    expect(externalTargets({ lines })).toEqual([
      { kind: 'command', line: 0, index: 1, target: 'echo hi' },
      { kind: 'http', line: 1, index: 0, target: 'https://x.com/?k=${K}' },
      { kind: 'http', line: 1, index: 1, target: 'https://y.com/' },
    ]);
  });

  it('tolerates malformed configs', () => {
    expect(externalTargets({ lines: undefined as any })).toEqual([]);
    expect(externalTargets({ lines: [null, [null]] as any })).toEqual([]);
  });
});
