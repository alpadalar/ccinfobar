import { describe, expect, it } from 'vitest';
import { routeTable } from '../../src/editor/server.js';

const EXACT = [
  'GET /api/ping',
  'GET /api/state',
  'POST /api/preview',
  'POST /api/normalize',
  'POST /api/theme-previews',
  'POST /api/themes',
  'POST /api/presets',
  'GET /api/catalog',
  'POST /api/catalog/previews',
  'POST /api/catalog/save',
  'POST /api/catalog/restore',
  'POST /api/catalog/share',
  'POST /api/catalog/publish/plan',
  'POST /api/catalog/publisher',
  'POST /api/catalog/publish',
  'POST /api/catalog/remote/previews',
  'GET /api/catalog/remote',
  'POST /api/catalog/login',
  'POST /api/catalog/logout',
  'POST /api/catalog/install/plan',
  'POST /api/catalog/install',
  'POST /api/catalog/report',
  'POST /api/catalog/install-theme',
  'POST /api/share',
  'POST /api/share/open',
  'POST /api/share/install-theme',
  'PUT /api/styles',
  'PUT /api/config',
  'POST /api/install/plan',
  'POST /api/install',
  'POST /api/hooks',
  'POST /api/progress',
  'GET /api/system',
  'POST /api/update',
  'POST /api/shutdown',
];

const PREFIX: [string, string][] = [
  ['DELETE', '/api/presets/'],
  ['DELETE', '/api/themes/'],
  ['GET|DELETE', '/api/catalog/entries/'],
  ['GET', '/api/catalog/remote/'],
  ['GET|DELETE', '/api/catalog/login/'],
];

describe('editor route table', () => {
  it('lists every exact route in source order', () => {
    expect(routeTable().exact).toEqual(EXACT);
  });

  it('lists the prefix routes in match order', () => {
    expect(routeTable().prefix).toEqual(PREFIX);
  });

  it('has no duplicate exact route', () => {
    expect(new Set(EXACT).size).toBe(EXACT.length);
  });

  it('keeps every prefix from shadowing an exact route', () => {
    for (const [methods, prefix] of PREFIX) {
      for (const m of methods.split('|')) {
        expect(EXACT.filter((e) => e.startsWith(`${m} ${prefix}`))).toEqual([]);
      }
    }
  });
});
