import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { samplePayload } from '../../src/core/sample.js';
import { loadHistory, recordHistory } from '../../src/data/history.js';
import { sparkline } from '../../src/widgets/shared.js';
import { ctxWith, NOW, renderWidget } from '../helpers.js';

const tmpEnv = () => ({ CCINFOBAR_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-hist-')) });

describe('sparkline', () => {
  it('maps values onto the ramp and pads to a fixed width', () => {
    expect(sparkline([0, 50, 100], 3, { min: 0, max: 100 })).toBe('▁▅█');
    expect(sparkline([1, 2], 4)).toBe('▁▁▁█');
    expect(sparkline([0, 100], 2, { min: 0, max: 100, ascii: true })).toBe('_#');
    expect(sparkline([], 4)).toBe('');
  });
});

describe('history', () => {
  it('merges samples closer than five seconds and keeps the newest last', () => {
    const env = tmpEnv();
    recordHistory('s1', { t: 0, tok: 1 }, env);
    recordHistory('s1', { t: 2000, tok: 2 }, env);
    const out = recordHistory('s1', { t: 7000, tok: 3 }, env);
    expect(out).toEqual([
      { t: 0, tok: 2 },
      { t: 7000, tok: 3 },
    ]);
    expect(loadHistory('s1', env)).toEqual(out);
  });

  it('caps the series and refuses unsafe session ids', () => {
    const env = tmpEnv();
    for (let i = 0; i < 400; i++) recordHistory('s2', { t: i * 6000, tok: i }, env);
    expect(loadHistory('s2', env)).toHaveLength(360);
    recordHistory('../../etc/x', { t: 0, tok: 1 }, env);
    expect(fs.existsSync(path.join(env.CCINFOBAR_CACHE_DIR, 'history', 'default.json'))).toBe(true);
  });
});

describe('chart widgets', () => {
  it('draws from the session history', () => {
    const c = ctxWith();
    expect(renderWidget('token-rate-graph', c)).toMatch(/^[▁▂▃▄▅▆▇█ ]{16} \S+$/);
    expect(renderWidget('context-graph', c)).toMatch(/ 34%$/);
    expect(renderWidget('usage-graph', c, { options: { window: '5h', points: 8 } })).toMatch(
      /^[▁-█]{8} 42%$/,
    );
    expect(renderWidget('cost-graph', c, { options: { showValue: false } })).toMatch(/^[▁-█ ]{16}$/);
    expect(renderWidget('output-speed-graph', c)).toMatch(/^[▁-█]{16} \d+ t\/s$/);
  });

  it('records a sample on a real render and needs two to draw', () => {
    const env = tmpEnv();
    const payload = { ...samplePayload(NOW.getTime()), session_id: 'live' };
    const at = (ms: number) =>
      createContext({ payload, config: { ...defaultConfig(), colorLevel: 0 }, env, now: new Date(ms) });
    expect(renderWidget('context-graph', at(NOW.getTime()))).toBeNull();
    expect(renderWidget('context-graph', at(NOW.getTime() + 10_000))).toMatch(/34%$/);
    expect(loadHistory('live', env)).toHaveLength(2);
  });
});
