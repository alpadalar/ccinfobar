import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runRender } from '../../src/cli/render.js';
import { stripAnsi } from '../../src/core/ansi.js';
import { configDir } from '../../src/core/paths.js';
import { VERSION } from '../../src/core/version.js';
import { okEnvelope, writeEnvelope } from '../../src/data/jobs/runner.js';
import type { UpdateValue } from '../../src/data/jobs/update.js';
import { useIdleEntry } from '../helpers.js';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'render-rejected-')));
  vi.stubEnv('CI', '');
  vi.stubEnv('CCINFOBAR_NO_UPDATE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function render(update: string): Promise<string> {
  const payload = path.join(dir, 'p.json');
  fs.writeFileSync(payload, JSON.stringify({ session_id: 'rej', workspace: { current_dir: dir } }));
  fs.mkdirSync(configDir(), { recursive: true });
  const cfg = path.join(configDir(), 'render-rejected.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({ update, lines: [[{ id: 'a', type: 'text', options: { text: 'hi' } }]] }),
  );
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out += String(s);
    return true;
  });
  await runRender(parseArgs(['--payload', payload]), cfg);
  vi.restoreAllMocks();
  return stripAnsi(out).replace(/ /g, ' ');
}

describe('render with a rejected update', () => {
  useIdleEntry();
  it('shows the notice in auto mode and hides it when updates are off', async () => {
    writeEnvelope(
      okEnvelope<UpdateValue>(
        'update',
        { latest: '999.0.0', rejected: '999.0.0', rollback: 'ok' },
        Date.now(),
        's',
      ),
    );
    const on = await render('auto');
    expect(on).toContain(`failed its check, still on ${VERSION}`);
    expect(await render('off')).not.toContain('failed its check');
  });
});
