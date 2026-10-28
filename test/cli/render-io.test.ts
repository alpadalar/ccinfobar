import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { resetSavePayloadMemo, runRender, savePayload } from '../../src/cli/render.js';
import { configDir, lastPayloadPath } from '../../src/core/paths.js';
import type { StatusPayload } from '../../src/core/types.js';
import { envelopeFile, okEnvelope, writeEnvelope } from '../../src/data/jobs/runner.js';
import type { UpdateValue } from '../../src/data/jobs/update.js';
import { limitsFile } from '../../src/data/limits.js';
import { type UsageValue, usageKey } from '../../src/data/usage.js';
import { useIdleEntry } from '../helpers.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');

beforeEach(() => resetSavePayloadMemo());

describe('savePayload', () => {
  const run = (payload: StatusPayload, mtimeMs: number | null) => {
    const write = vi.fn();
    const stat = vi.fn(() => (mtimeMs === null ? undefined : { mtimeMs }));
    savePayload(payload, { now: () => NOW, stat, write });
    return { write, stat };
  };

  it('writes the first call and skips an equal payload without a stat', () => {
    const write = vi.fn();
    const stat = vi.fn(() => undefined);
    const deps = { now: () => NOW, stat, write };
    savePayload({ session_id: '1' }, deps);
    savePayload({ session_id: '1' }, deps);
    expect(write).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('skips a changed payload when the file is younger than 5 s', () => {
    expect(run({ session_id: '1' }, NOW - 1000).write).not.toHaveBeenCalled();
    expect(run({ session_id: '2' }, NOW - 4999).write).not.toHaveBeenCalled();
  });

  it('writes a changed payload when the file is 5 s or older', () => {
    expect(run({ session_id: '1' }, NOW - 5000).write).toHaveBeenCalledTimes(1);
    expect(run({ session_id: '2' }, NOW - 6000).write).toHaveBeenCalledTimes(1);
  });

  it('always writes when the file is missing', () => {
    expect(run({ session_id: '1' }, null).write).toHaveBeenCalledTimes(1);
  });

  it('does not let a future mtime block the write', () => {
    expect(run({ session_id: '1' }, NOW + 60_000).write).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing write and retries the same payload next time', () => {
    const write = vi.fn(() => {
      throw new Error('disk full');
    });
    const deps = { now: () => NOW, stat: () => undefined, write };
    expect(() => savePayload({ session_id: '1' }, deps)).not.toThrow();
    savePayload({ session_id: '1' }, deps);
    expect(write).toHaveBeenCalledTimes(2);
  });
});

const PROVIDER = /^(CLAUDE_CODE_USE_|ANTHROPIC_)|^CLAUDE_CODE_OAUTH_TOKEN$/;

describe('runRender file operations', () => {
  useIdleEntry();
  let dir: string;
  let cfg: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'render-io-')));
    vi.stubEnv('CCINFOBAR_CACHE_DIR', path.join(dir, 'cache'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, 'claude'));
    vi.stubEnv('CI', '');
    vi.stubEnv('CCINFOBAR_NO_UPDATE', '');
    vi.stubEnv('CCINFOBAR_NO_USAGE_API', '');
    for (const k of Object.keys(process.env)) if (PROVIDER.test(k)) vi.stubEnv(k, undefined);
    fs.mkdirSync(configDir(), { recursive: true });
    cfg = path.join(configDir(), 'render-io.json');
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        update: 'notify',
        savePayload: true,
        lines: [
          [
            { id: 'a', type: 'five-hour-usage' },
            { id: 'b', type: 'service-status' },
          ],
        ],
      }),
    );
    resetSavePayloadMemo();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const payload = () =>
    JSON.stringify({
      session_id: 'render-io',
      workspace: { current_dir: dir },
      rate_limits: { five_hour: { used_percentage: 70, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
    });

  async function once(): Promise<string> {
    const stdin = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    stdin.end(payload());
    let out = '';
    const w = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out += String(s);
      return true;
    });
    await runRender(parseArgs([]), cfg);
    w.mockRestore();
    return out;
  }

  it('writes the payload once, reads the limits store and each envelope once per render', async () => {
    const now = Date.now();
    writeEnvelope(okEnvelope<UpdateValue>('update', { latest: '999.0.0', rollback: 'ok' }, now, 'render-io'));
    writeEnvelope(
      okEnvelope<UsageValue>(
        usageKey(),
        { rate_limits: { seven_day: { used_percentage: 10, resets_at: null } } },
        now,
      ),
    );
    writeEnvelope(okEnvelope('status', { indicator: 'none', description: '', incidents: [] }, now));
    // steady state: the store already holds this payload
    await once();
    fs.rmSync(lastPayloadPath(), { force: true });
    resetSavePayloadMemo();
    const files = {
      limits: limitsFile(),
      update: envelopeFile('update'),
      usage: envelopeFile(usageKey()),
      status: envelopeFile('status'),
    };
    const read = vi.spyOn(fs, 'readFileSync');
    const write = vi.spyOn(fs, 'writeFileSync');
    const counts: Record<string, number>[] = [];
    const outs: string[] = [];
    for (let i = 0; i < 2; i++) {
      read.mockClear();
      outs.push(await once());
      counts.push(
        Object.fromEntries(
          Object.entries(files).map(([k, f]) => [k, read.mock.calls.filter(([p]) => p === f).length]),
        ),
      );
    }
    const saved = write.mock.calls.filter(([p]) => String(p).startsWith(lastPayloadPath()));
    const stored = write.mock.calls.filter(([p]) => String(p).startsWith(files.limits));
    expect(counts).toEqual([
      { limits: 1, update: 1, usage: 1, status: 1 },
      { limits: 1, update: 1, usage: 1, status: 1 },
    ]);
    expect(saved).toHaveLength(1);
    expect(stored).toHaveLength(0);
    expect(outs[0]).toBe(outs[1]);
  });
});
