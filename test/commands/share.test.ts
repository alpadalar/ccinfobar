import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeShare } from '../../src/catalog/share-code.js';
import { parseArgs } from '../../src/cli/args.js';
import { main } from '../../src/cli/main.js';
import { runCatalog } from '../../src/commands/catalog.js';
import type { CliIo, PromptIo } from '../../src/commands/io.js';
import { runShare } from '../../src/commands/share.js';
import { defaultConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/types.js';
import { editorStateFile, runDetach } from '../../src/editor/detach.js';
import { startEditor } from '../../src/editor/server.js';

let root = '';
let cfg = '';
const saved: Record<string, string | undefined> = {};
const ENV = ['CCINFOBAR_CONFIG_DIR', 'CCINFOBAR_CACHE_DIR'];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-share-cmd-'));
  cfg = path.join(root, 'config.json');
  fs.mkdirSync(path.join(root, 'themes'));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.CCINFOBAR_CONFIG_DIR = root;
  process.env.CCINFOBAR_CACHE_DIR = path.join(root, 'cache');
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const lines = (): Config['lines'] => [
  [
    { id: 'm', type: 'model' },
    { id: 'k', type: 'command', options: { command: 'echo hi' } },
  ],
];

function write(extra: Partial<Config> = {}) {
  fs.writeFileSync(cfg, JSON.stringify({ lines: lines(), theme: 'nord', ...extra }));
}

function share(argv: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { tty: false, log: (l) => void out.push(l), error: (l) => void err.push(l) };
  process.exitCode = undefined;
  runShare(parseArgs(['share', ...argv]), cfg, io);
  const code = process.exitCode;
  process.exitCode = undefined;
  return { out, err, code };
}

async function catalog(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: PromptIo = {
    tty: false,
    columns: 100,
    ask: async () => false,
    log: (l) => void out.push(l),
    error: (l) => void err.push(l),
  };
  process.exitCode = undefined;
  await runCatalog(parseArgs(['catalog', ...argv]), cfg, { io, dir: path.join(root, 'catalog'), gsd: false });
  const code = process.exitCode;
  process.exitCode = undefined;
  return { out, err, code };
}

const codeOf = (config: Partial<Config>, includeCommands = false) => {
  const r = encodeShare({ ...defaultConfig(), ...config } as Config, { includeCommands });
  if (!r.ok) throw new Error(r.errorId);
  return r.code;
};

describe('ccinfobar share', () => {
  it('prints one code on stdout and the details on stderr', () => {
    write();
    const r = share();
    expect(r.code).toBeUndefined();
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).toMatch(/^ccib1:[A-Za-z0-9_-]+$/);
    expect(r.err.join('\n')).toContain('characters');
    expect(r.err.join('\n')).toContain('echo hi');
    expect(r.err.join('\n')).toContain('--include-commands');
    expect(r.err.join('\n')).toContain('ccinfobar edit --open');
  });

  it('prints JSON', () => {
    write();
    const r = share(['--json']);
    const j = JSON.parse(r.out[0]!);
    expect(j).toMatchObject({ schema: 1, max: 32768, included: false });
    expect(j.code).toMatch(/^ccib1:/);
    expect(j.chars).toBe(j.code.length);
    expect(j.dropped).toEqual([{ kind: 'command', target: 'echo hi' }]);
  });

  it('keeps commands with --include-commands', () => {
    write();
    const j = JSON.parse(share(['--json', '--include-commands']).out[0]!);
    expect(j.included).toBe(true);
    expect(j.dropped).toEqual([]);
  });

  it('fails on a config too big to share', () => {
    const big = Array.from({ length: 40 }, (_, l) =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `t${l}-${i}`,
        type: 'text',
        options: { text: crypto.randomBytes(60).toString('hex') },
      })),
    );
    fs.writeFileSync(cfg, JSON.stringify({ lines: big }));
    const r = share();
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err[0]).toMatch(/^✗ /);
  });

  it('fails on a broken config', () => {
    fs.writeFileSync(cfg, '{ nope');
    const r = share();
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
  });
});

describe('ccinfobar catalog apply <code>', () => {
  const target = () => ({ lines: [[{ id: 'x', type: 'cwd' }]], budget: { daily: 3 }, language: 'tr' });

  it('applies a code with a backup and keeps personal settings', async () => {
    fs.writeFileSync(cfg, JSON.stringify(target()));
    const code = codeOf({ lines: lines(), theme: 'nord' }, true);
    const r = await catalog(['apply', code, '--yes', '--json']);
    expect(r.code).toBeUndefined();
    const j = JSON.parse(r.out.at(-1)!);
    expect(j.applied).toBe('share-code');
    expect(j.backup).toBeTruthy();
    expect(fs.existsSync(j.backup)).toBe(true);
    expect(j.dropped).toEqual([{ kind: 'command', target: 'echo hi' }]);
    const next = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    expect(next.budget).toEqual({ daily: 3 });
    expect(next.language).toBe('tr');
    expect(next.theme).toBe('nord');
    expect(next.lines[0].map((i: { type: string }) => i.type)).toEqual(['model']);
  });

  it('keeps commands with --allow-commands', async () => {
    fs.writeFileSync(cfg, JSON.stringify(target()));
    const code = codeOf({ lines: lines() }, true);
    const r = await catalog(['apply', code, '--allow-commands', '--json']);
    expect(JSON.parse(r.out.at(-1)!).dropped).toEqual([]);
    const next = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    expect(next.lines[0].map((i: { type: string }) => i.type)).toEqual(['model', 'command']);
  });

  it('never echoes the code in the rerun hint', async () => {
    fs.writeFileSync(cfg, JSON.stringify(target()));
    const code = codeOf({ lines: lines() }, true);
    const r = await catalog(['apply', code, '--yes']);
    const text = r.out.join('\n');
    expect(text).toContain('catalog apply <code> --allow-commands');
    expect(text).not.toContain(code);
  });

  it('writes nothing on a dry run', async () => {
    fs.writeFileSync(cfg, JSON.stringify(target()));
    const before = fs.readFileSync(cfg);
    const r = await catalog(['apply', codeOf({ lines: lines() }), '--dry-run', '--json']);
    const j = JSON.parse(r.out.at(-1)!);
    expect(j).toMatchObject({ applied: 'share-code', dryRun: true, backup: null });
    expect(fs.readFileSync(cfg)).toEqual(before);
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.bak'))).toEqual([]);
  });

  it('fails on a damaged code', async () => {
    fs.writeFileSync(cfg, JSON.stringify(target()));
    const r = await catalog(['apply', 'ccib1:AAAA', '--yes']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('damaged');
  });
});

describe('ccinfobar edit <code>', () => {
  it('rejects a bad code before starting a server', async () => {
    write();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['edit', '--open', 'ccib1:AAAA', '--no-open', '--no-detect', '--config', cfg]);
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toMatch(/^✗ /);
    expect(log).not.toHaveBeenCalled();
    await main(['edit', 'hello', '--no-open', '--no-detect', '--config', cfg]);
    expect(process.exitCode).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('puts the code in the editor url', async () => {
    write();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = codeOf({ lines: lines() });
    const h = await startEditor({
      configPath: cfg,
      open: false,
      terminal: null,
      share: code,
      claudeVersion: () => null,
    });
    try {
      expect(h.url.endsWith(`#c=${code}`)).toBe(true);
      expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+#c=ccib1:/);
    } finally {
      await h.close();
    }
  });

  it('adds the code to a reused detached editor url', async () => {
    write();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { ...process.env };
    const stateFile = editorStateFile(env);
    const h = await startEditor({
      configPath: cfg,
      open: false,
      terminal: null,
      claudeVersion: () => null,
      detached: { idleMs: 60_000, stateFile },
    });
    try {
      const code = codeOf({ lines: lines() });
      const said: string[] = [];
      const exit = await runDetach({
        configPath: cfg,
        open: false,
        share: code,
        env,
        log: (l) => void said.push(l),
      });
      expect(exit).toBe(0);
      expect(said.join('\n')).toContain(`${h.url}#c=${code}`);
    } finally {
      await h.close();
    }
  });
});
