import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runRender } from '../../src/cli/render.js';
import { configDir } from '../../src/core/paths.js';
import type { RenderContext } from '../../src/core/types.js';
import { limitsFile, recordLimits } from '../../src/data/limits.js';

const seen: RenderContext[] = [];

vi.mock('../../src/core/renderer.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/renderer.js')>();
  return {
    ...real,
    render: (ctx: RenderContext) => {
      seen.push(ctx);
      return real.render(ctx);
    },
  };
});

const PROVIDER = /^(CLAUDE_CODE_USE_|ANTHROPIC_)|^CLAUDE_CODE_OAUTH_TOKEN$/;
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  seen.length = 0;
  dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'render-limits-'));
  saved = {};
  for (const k of Object.keys(process.env)) {
    if (PROVIDER.test(k)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
});

afterEach(() => {
  fs.rmSync(limitsFile(), { force: true });
  Object.assign(process.env, saved);
  vi.restoreAllMocks();
});

describe('render limits', () => {
  it('hands widgets the resolved limits view', async () => {
    const resets_at = Math.floor(Date.now() / 1000) + 3600;
    recordLimits(
      process.env,
      { rate_limits: { five_hour: { used_percentage: 70, resets_at } } },
      Date.now() - 60_000,
      Date.now(),
    );
    const file = path.join(dir, 'p.json');
    fs.writeFileSync(file, JSON.stringify({ session_id: 'render-limits', model: { display_name: 'Opus' } }));
    fs.mkdirSync(configDir(), { recursive: true });
    const cfg = path.join(configDir(), 'render-limits.json');
    fs.writeFileSync(cfg, JSON.stringify({ lines: [[{ id: 'five', type: 'five-hour-usage' }]] }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runRender(parseArgs(['--payload', file]), cfg);
    const view = seen[0]?.data.limits?.();
    expect(view?.windows.five_hour?.pct).toBe(70);
    expect(view?.windows.five_hour?.source).toBe('limits-cache');
  });
});
