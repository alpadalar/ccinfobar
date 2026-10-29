import { describe, expect, it } from 'vitest';
import { createRouter } from '../../src/editor/router.js';

const a = () => {};
const b = () => {};
const c = () => {};

describe('createRouter', () => {
  const router = createRouter<null>({
    prefix: [{ methods: ['DELETE'], path: '/api/presets/', handler: a }],
    exact: [{ method: 'GET', path: '/api/ping', handler: b }],
  });

  it('matches a prefix and an exact route', () => {
    expect(router.match('DELETE', '/api/presets/x')).toBe(a);
    expect(router.match('GET', '/api/ping')).toBe(b);
  });

  it('returns null for a wrong method or an unknown path', () => {
    expect(router.match('GET', '/api/presets/x')).toBeNull();
    expect(router.match('POST', '/api/ping')).toBeNull();
    expect(router.match('GET', '/api/ping/x')).toBeNull();
  });

  it('lets the first matching prefix win', () => {
    const r = createRouter<null>({
      prefix: [
        { methods: ['GET'], path: '/api/x/', handler: a },
        { methods: ['GET', 'DELETE'], path: '/api/x/y/', handler: c },
      ],
      exact: [],
    });
    expect(r.match('GET', '/api/x/y/z')).toBe(a);
    expect(r.match('DELETE', '/api/x/y/z')).toBe(c);
  });

  it('checks prefixes before exact routes', () => {
    const r = createRouter<null>({
      prefix: [{ methods: ['GET'], path: '/api/x', handler: a }],
      exact: [{ method: 'GET', path: '/api/x', handler: b }],
    });
    expect(r.match('GET', '/api/x')).toBe(a);
  });

  it('lists its table in insertion order', () => {
    expect(router.table()).toEqual({ exact: ['GET /api/ping'], prefix: [['DELETE', '/api/presets/']] });
    const r = createRouter<null>({
      prefix: [{ methods: ['GET', 'DELETE'], path: '/p/', handler: a }],
      exact: [],
    });
    expect(r.table().prefix).toEqual([['GET|DELETE', '/p/']]);
  });

  it('refuses a duplicate exact route', () => {
    expect(() =>
      createRouter<null>({
        prefix: [],
        exact: [
          { method: 'GET', path: '/a', handler: a },
          { method: 'GET', path: '/a', handler: b },
        ],
      }),
    ).toThrow();
  });
});
