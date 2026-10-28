import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runRender } from '../../src/cli/render.js';
import { stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { configDir } from '../../src/core/paths.js';
import { okEnvelope, writeEnvelope } from '../../src/data/jobs/runner.js';
import type { UpdateValue } from '../../src/data/jobs/update.js';
import { useIdleEntry } from '../helpers.js';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'render-notice-')));
  vi.stubEnv('CCINFOBAR_CACHE_DIR', path.join(dir, 'cache'));
  vi.stubEnv('CI', '');
  vi.stubEnv('CCINFOBAR_NO_UPDATE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function render(update: string, words: string, maxWidth = 40): Promise<string[]> {
  const payload = path.join(dir, 'p.json');
  fs.writeFileSync(payload, JSON.stringify({ session_id: 'ntc', workspace: { current_dir: dir } }));
  fs.mkdirSync(configDir(), { recursive: true });
  const cfg = path.join(configDir(), 'render-notice.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      update,
      maxWidth,
      autoWrap: false,
      lines: [[{ id: 'a', type: 'text', options: { text: words } }]],
    }),
  );
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out += String(s);
    return true;
  });
  await runRender(parseArgs(['--payload', payload]), cfg);
  vi.restoreAllMocks();
  return out.split('\n').filter(Boolean);
}

const pending = () =>
  writeEnvelope(okEnvelope<UpdateValue>('update', { latest: '999.0.0', rollback: 'ok' }, Date.now(), 's'));

describe('update notice width', () => {
  useIdleEntry();

  it('is appended to a short last line', async () => {
    pending();
    const lines = await render('notify', 'hi', 120);
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toContain('999.0.0');
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(120);
  });

  it('gets its own line when the last line is full', async () => {
    const without = await render('notify', 'x'.repeat(60));
    pending();
    const lines = await render('notify', 'x'.repeat(60));
    expect(lines).toHaveLength(without.length + 1);
    expect(stripAnsi(lines[lines.length - 1]!)).toContain('999');
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });

  it('prints no notice when updates are off', async () => {
    const without = await render('off', 'hi');
    pending();
    const lines = await render('off', 'hi');
    expect(lines).toEqual(without);
    expect(stripAnsi(lines.join('\n'))).not.toContain('999');
  });
});
