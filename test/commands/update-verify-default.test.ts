import { describe, expect, it, vi } from 'vitest';
import { manualUpdate } from '../../src/commands/update.js';
import { useIdleEntry } from '../helpers.js';

const verify = vi.hoisted(() => vi.fn(async (v: string) => (v === '0.9.0' ? 'render-failed:1' : null)));

vi.mock('../../src/data/self-update.js', async (orig) => ({
  ...(await orig<typeof import('../../src/data/self-update.js')>()),
  verifyInstall: verify,
}));

describe('manual update default verify', () => {
  useIdleEntry();

  async function run() {
    const installs: string[] = [];
    const states: Array<Record<string, unknown>> = [];
    const out: string[] = [];
    const code = await manualUpdate('0.8.2', false, {
      fetchLatest: async () => '0.9.0',
      installKind: () => 'npm-global',
      install: async (v) => {
        installs.push(v);
      },
      writeState: ((s: Record<string, unknown>) => {
        states.push(s);
      }) as never,
      log: (l) => out.push(l),
      error: (l) => out.push(l),
    });
    return { code, installs, states, out };
  }

  it('the production default verify is verifyInstall; a failing check rolls back and exits 1', async () => {
    verify.mockClear();
    const r = await run();
    expect(verify.mock.calls[0]).toEqual(['0.9.0', process.env, undefined]);
    expect(verify.mock.calls[1]).toEqual(['0.8.2', process.env, expect.anything()]);
    expect(r.installs).toEqual(['0.9.0', '0.8.2']);
    expect(r.code).toBe(1);
    expect(r.states.at(-1)).toMatchObject({ rejected: '0.9.0', rollback: 'ok', reason: 'render-failed:1' });
    expect(r.out.at(-1)).toBe('✗ 0.9.0 failed its check (render-failed:1); back on 0.8.2');
  });

  it('a passing check keeps the install and exits 0', async () => {
    verify.mockReset();
    verify.mockResolvedValue(null);
    const r = await run();
    expect(r.code).toBe(0);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toBe('0.9.0');
    expect(r.installs).toEqual(['0.9.0']);
  });
});
