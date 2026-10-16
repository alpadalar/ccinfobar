import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage, t } from '../../src/core/i18n/index.js';
import { ApiError, api, apiErrorText, idText } from '../../src/editor/web/api.js';
import { withLang } from '../helpers.js';

const NEEDS = 'Confirm replacing the current statusLine first.';

describe('apiErrorText', () => {
  it('translates a known errorId and keeps the English error otherwise', () => {
    const body = { error: NEEDS, errorId: 'install.needsConfirm' };
    expect(apiErrorText(body, 409)).toBe(NEEDS);
    expect(withLang('tr', () => apiErrorText(body, 409))).toBe(
      withLang('tr', () => t('install.needsConfirm')),
    );
    expect(withLang('tr', () => apiErrorText({ error: NEEDS, errorId: 'install.nope' }, 409))).toBe(NEEDS);
    expect(withLang('tr', () => apiErrorText({ error: NEEDS }, 409))).toBe(NEEDS);
    expect(apiErrorText(null, 502)).toBe('HTTP 502');
  });

  it('uses only string and number params', () => {
    const body = {
      error: 'x',
      errorId: 'install.stale',
      errorParams: { file: '~/.claude/settings.json', extra: { a: 1 } },
    };
    expect(withLang('tr', () => apiErrorText(body, 409))).toBe(
      withLang('tr', () => t('install.stale', { file: '~/.claude/settings.json' })),
    );
    expect(withLang('tr', () => apiErrorText({ ...body, errorParams: { file: ['a'] } }, 409))).toContain(
      '{file}',
    );
  });

  it('ignores prototype ids and params', () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty'])
      expect(idText(id, {}, 'fallback')).toBe('fallback');
    const params = JSON.parse('{"__proto__": "x", "file": "f"}');
    expect(idText('install.stale', params, 'fallback')).toBe(t('install.stale', { file: 'f' }));
    expect(idText('hooks.reason.notActive', [1, 2], 'fallback')).toBe(t('hooks.reason.notActive'));
  });
});

describe('api error', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws an ApiError with the translated message and the raw body', async () => {
    const body = { error: NEEDS, errorId: 'install.needsConfirm', plan: { changes: true } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 409 })),
    );
    // the message is built after the await
    const prev = setLanguage('tr');
    let err: unknown;
    try {
      err = await api.install('ccinfobar').catch((e: unknown) => e);
    } finally {
      setLanguage(prev);
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).data).toEqual(body);
    expect((err as ApiError).message).toBe(withLang('tr', () => t('install.needsConfirm')));
  });
});

describe('catalog error text (D-17)', () => {
  const exists = {
    error: 'x',
    errorId: 'err.catalog.exists',
    errorParams: { kind: 'bundle', name: 'A', version: 1 },
  };

  it('translates lazy ids with the localized kind word', () => {
    expect(apiErrorText(exists, 409)).toBe('A bundle named A already exists (v1)');
    const tr = withLang('tr', () => apiErrorText(exists, 409));
    expect(tr).toBe(withLang('tr', () => t('err.catalog.exists', { kind: 'paket', name: 'A', version: 1 })));
    expect(tr).not.toBe(apiErrorText(exists, 409));
    for (const errorId of ['market.error.timeout', 'catalog.remote.badId', 'err.catalog.noEndpoint']) {
      const text = withLang('tr', () =>
        apiErrorText({ error: 'x', errorId, errorParams: { ref: 'r' } }, 409),
      );
      expect(text, errorId).toBe(withLang('tr', () => t(errorId as never, { ref: 'r' })));
      expect(text, errorId).not.toBe(t(errorId as never, { ref: 'r' }));
    }
  });

  it('keeps the English error for unknown ids', () => {
    expect(withLang('tr', () => apiErrorText({ error: 'Nope', errorId: 'err.catalog.nope' }, 400))).toBe(
      'Nope',
    );
    expect(
      withLang('tr', () => apiErrorText({ error: 'Nope', errorId: 'market.error.__proto__' }, 400)),
    ).toBe('Nope');
  });
});

describe('catalog api (D-06, D-10)', () => {
  const calls: { method: string; url: string; body: unknown }[] = [];

  function answer(status: number, body: unknown) {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          method: String(init.method),
          url,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        return new Response(JSON.stringify(body), { status });
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the exists payload on a 409 save', async () => {
    const body = {
      error: 'A bundle named A already exists (v1)',
      errorId: 'err.catalog.exists',
      errorParams: { kind: 'bundle', name: 'A', version: 1 },
      exists: { id: 'u-0123456789ab', version: 1, name: 'A' },
    };
    answer(409, body);
    const config = { lines: [] } as never;
    const err = await api
      .catalogSave({ kind: 'bundle', name: 'A', description: '', share: true, mode: 'new', config })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect(((err as ApiError).data!.exists as { version: number }).version).toBe(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/catalog/save' });
    expect((calls[0]!.body as { lang: string }).lang).toBe('en');
  });

  it('encodes every path part', async () => {
    answer(200, {});
    await api.catalogRemoteEntry('alp/x y');
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/api/catalog/remote/alp/x%20y' });
    await api.catalogEntry('legacy:preset/a b');
    expect(calls.at(-1)!.url).toBe('/api/catalog/entries/legacy%3Apreset%2Fa%20b?lang=en');
    await api.catalogDelete('../x');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/catalog/entries/..%2Fx?lang=en' });
  });

  it('calls every catalog route with the browser language', async () => {
    answer(200, {});
    const config = { lines: [] } as never;
    const routes: [() => Promise<unknown>, string, string, Record<string, unknown> | undefined][] = [
      [() => api.catalog(), 'GET', '/api/catalog?lang=tr', undefined],
      [() => api.catalogEntry('bundle/dev'), 'GET', '/api/catalog/entries/bundle%2Fdev?lang=tr', undefined],
      [
        () => api.catalogPreviews(config, { source: 'scenario', scenario: 'busy' }, 80, ['bundle/dev']),
        'POST',
        '/api/catalog/previews',
        { config, source: 'scenario', scenario: 'busy', width: 80, refs: ['bundle/dev'], lang: 'tr' },
      ],
      [
        () => api.catalogRestore('u-0123456789ab', 2, 5),
        'POST',
        '/api/catalog/restore',
        { id: 'u-0123456789ab', version: 2, rev: 5, lang: 'tr' },
      ],
      [
        () => api.catalogShare('u-0123456789ab', false, 3),
        'POST',
        '/api/catalog/share',
        { ref: 'u-0123456789ab', share: false, rev: 3, lang: 'tr' },
      ],
      [
        () => api.catalogDelete('u-0123456789ab'),
        'DELETE',
        '/api/catalog/entries/u-0123456789ab?lang=tr',
        undefined,
      ],
      [
        () => api.catalogInstallTheme('theme/nord', 2),
        'POST',
        '/api/catalog/install-theme',
        { ref: 'theme/nord', version: 2 },
      ],
      [
        () => api.catalogInstallTheme('theme/nord'),
        'POST',
        '/api/catalog/install-theme',
        { ref: 'theme/nord' },
      ],
      [
        () => api.catalogPublishPlan(['u-0123456789ab']),
        'POST',
        '/api/catalog/publish/plan',
        { refs: ['u-0123456789ab'] },
      ],
      [() => api.catalogPublishPlan(), 'POST', '/api/catalog/publish/plan', {}],
      [
        () => api.catalogPublish(['u-0123456789ab'], 'abc'),
        'POST',
        '/api/catalog/publish',
        { refs: ['u-0123456789ab'], confirm: true, planHash: 'abc', lang: 'tr' },
      ],
      [() => api.catalogRemote(), 'GET', '/api/catalog/remote', undefined],
    ];
    const prev = setLanguage('tr');
    try {
      for (const [run, method, url, body] of routes) {
        calls.length = 0;
        await run();
        expect(calls, url).toEqual([{ method, url, body }]);
      }
    } finally {
      setLanguage(prev);
    }
  });
});
