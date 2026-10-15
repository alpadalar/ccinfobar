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
