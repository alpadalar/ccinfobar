// 21-05 swaps sourceTable() for the router table; the literals stay
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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

function sourceTable(): { exact: string[]; prefix: [string, string][] } {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'editor', 'server.ts'), 'utf8');
  const flow = /const FLOW_PATH = '([^']+)'/.exec(src)?.[1] ?? '';
  const exact = [...src.matchAll(/^ {6}case '([A-Z]+ \/[^']*)':/gm)].map((m) => m[1]!);
  const prefix: [string, string][] = [];
  for (const m of src.matchAll(/^ {4}if \((.*startsWith\((?:'[^']+'|FLOW_PATH)\))\) \{$/gm)) {
    const cond = m[1]!;
    const methods = [...cond.matchAll(/method === '([A-Z]+)'/g)].map((x) => x[1]!);
    const p = /startsWith\((?:'([^']+)'|FLOW_PATH)\)/.exec(cond)!;
    prefix.push([methods.join('|'), p[1] ?? flow]);
  }
  return { exact, prefix };
}

describe('editor route table', () => {
  it('lists every exact route in source order', () => {
    expect(sourceTable().exact).toEqual(EXACT);
  });

  it('lists the prefix routes in match order', () => {
    expect(sourceTable().prefix).toEqual(PREFIX);
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
