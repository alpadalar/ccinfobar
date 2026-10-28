import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { editFlags, main } from '../../src/cli/main.js';
import { t } from '../../src/core/i18n/index.js';

const { startEditor, runDetach } = vi.hoisted(() => ({
  startEditor: vi.fn(async () => {}),
  runDetach: vi.fn(async () => 0),
}));
vi.mock('../../src/editor/server.js', () => ({ startEditor }));
vi.mock('../../src/editor/detach.js', () => ({ runDetach, editorStateFile: () => 'x' }));
vi.mock('../../src/editor/terminal-colors.js', () => ({ queryTerminalColors: async () => null }));

let cfg: string;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'edit-flags-'));
  cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, '{}');
});

afterEach(() => {
  vi.restoreAllMocks();
  startEditor.mockClear();
  runDetach.mockClear();
  process.exitCode = undefined;
});

async function errOut(argv: string[]): Promise<string> {
  const out: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((s) => void out.push(String(s)));
  await main([...argv, '--config', cfg]);
  return out.join('\n');
}

describe('editFlags', () => {
  const base = { port: undefined, detach: false, open: true, serveDetached: false, detect: true };
  it.each([
    [['edit'], {}],
    [['edit', '--detach=1'], { detach: true }],
    [['edit', '--detach'], { detach: true }],
    [['edit', '--open=0'], { open: false }],
    [['edit', '--no-open'], { open: false }],
    [['edit', '--serve-detached'], { serveDetached: true }],
    [['edit', '--no-detect'], { detect: false }],
    [['edit', '--port', '8080'], { port: 8080 }],
  ])('%j', (argv, want) => {
    expect(editFlags(parseArgs(argv))).toEqual({ ...base, ...want });
  });
});

describe('edit argument checks', () => {
  it.each(['foo', '8080'])('edit %s explains the flags and starts nothing', async (word) => {
    const err = await errOut(['edit', word]);
    expect(err).toContain('✗');
    expect(err).toContain('--port');
    expect(err).toContain('--open');
    expect(err).toContain('ccinfobar share');
    expect(err).not.toContain(word);
    expect(process.exitCode).toBe(1);
    expect(startEditor).not.toHaveBeenCalled();
    expect(runDetach).not.toHaveBeenCalled();
  });

  it('keeps the share-code error for a broken code', async () => {
    const err = await errOut(['edit', 'ccib1:!!']);
    expect(err).toContain(t('err.share.notCode'));
    expect(startEditor).not.toHaveBeenCalled();
  });

  it('rejects a port out of range', async () => {
    const err = await errOut(['edit', '--port', '70000']);
    expect(err).toContain(t('cli.badInt', { flag: '--port', min: 1, max: 65535 }));
    expect(process.exitCode).toBe(1);
    expect(startEditor).not.toHaveBeenCalled();
  });

  it('reads --yes=false as false at the command boundary', () => {
    expect(parseArgs(['install', '--yes=false']).flags.yes).toBe(false);
  });
});
