import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { resetLanguageCache } from '../../src/cli/lang.js';
import { runBench } from '../../src/commands/bench.js';
import { runConfig } from '../../src/commands/config-cmd.js';
import { runExplain } from '../../src/commands/explain.js';
import type { CliIo } from '../../src/commands/io.js';
import { configDir } from '../../src/core/paths.js';
import { startEditor } from '../../src/editor/server.js';
import { withEnvLang, withLang } from '../helpers.js';

const LINES = [
  [
    { id: 'model', type: 'model' },
    { id: 'ctx', type: 'context-percentage' },
    { id: 'eta', type: 'limit-eta' },
    { id: 'risk', type: 'limit-risk' },
    { id: 'branch', type: 'git-branch' },
  ],
  [
    { id: 'turn', type: 'turn-duration' },
    { id: 'status', type: 'claude-status' },
    { id: 'nope', type: 'nope' },
  ],
];

const cfgFile = (cfg: object): string => {
  fs.mkdirSync(configDir(), { recursive: true });
  const file = path.join(configDir(), 'json-parity.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
};

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { tty: false, log: (l) => out.push(l), error: (l) => err.push(l) };
  return { out, err, io };
};

const explain = (argv: string[], cfg: object): string => {
  const c = capture();
  runExplain(parseArgs(['explain', ...argv]), cfgFile(cfg), c.io);
  return c.out.join('\n');
};

const config = (argv: string[], cfg: object): string => {
  const out: string[] = [];
  runConfig(parseArgs(['config', ...argv]), cfgFile(cfg), { out: (s) => out.push(s), err: () => {} });
  return out.join('\n');
};

afterEach(() => {
  process.exitCode = undefined;
});

describe('JSON output stays English', () => {
  const plain = { lines: LINES };
  const tr = { language: 'tr', lines: LINES };

  it.each(['fresh-session', 'context-full', 'near-5h-limit', 'service-incident'])(
    'explain --json is byte-identical under en and tr (%s)',
    (scenario) => {
      const argv = ['--scenario', scenario, '--json', '--width', '120'];
      const en = withLang('en', () => explain(argv, plain));
      expect(() => JSON.parse(en)).not.toThrow();
      expect(withLang('tr', () => explain(argv, plain))).toBe(en);
      expect(withEnvLang('tr', () => explain(argv, plain))).toBe(en);
      expect(withLang('en', () => explain(argv, tr))).toBe(en);
      expect(withEnvLang('tr', () => explain(argv, tr))).toBe(en);
    },
  );

  it('the human explain output does switch, so the check above means something', () => {
    const argv = ['--scenario', 'fresh-session', '--width', '120'];
    expect(withEnvLang('tr', () => explain(argv, plain))).not.toBe(
      withLang('en', () => explain(argv, plain)),
    );
    expect(explain(argv, tr)).not.toBe(explain(argv, plain));
  });

  it('config get is identical under en and tr', () => {
    for (const path of ['lines', 'lines.0.1', 'language']) {
      const en = withLang('en', () => config(['get', path], tr));
      expect(en).not.toBe('');
      expect(withEnvLang('tr', () => config(['get', path], tr))).toBe(en);
      expect(withEnvLang('tr', () => config(['get', path], { ...tr, language: 'en' }))).toBe(
        en.replace(/^tr$/, 'en'),
      );
    }
  });

  it('bench --json keys and row names do not follow the language', { timeout: 60_000 }, () => {
    // own tmpdir: bench.test.ts counts ccib-bench-* dirs in the shared one
    const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'parity-'));
    const prev = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    for (const k of Object.keys(prev)) process.env[k] = dir;
    const entry = path.join(dir, 'fake.mjs');
    fs.writeFileSync(entry, '');
    const shape = (cfg: object) => {
      const c = capture();
      expect(runBench({ entry, runs: 1, json: true, cfgFile: cfgFile(cfg) }, c.io)).toBe(0);
      expect(c.out).toHaveLength(1);
      return JSON.stringify(JSON.parse(c.out[0]!), (_k, v) => (typeof v === 'number' ? 0 : v));
    };
    try {
      const en = withLang('en', () => shape(plain));
      expect(en).toContain('"name":"warm"');
      expect(withEnvLang('tr', () => shape(plain))).toBe(en);
      expect(withEnvLang('tr', () => shape(tr))).toBe(en);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('editor API JSON stays English', () => {
  const state = async (env: { lang?: string }, file: string): Promise<Record<string, unknown>> => {
    const prev = process.env.CCINFOBAR_LANG;
    if (env.lang === undefined) delete process.env.CCINFOBAR_LANG;
    else process.env.CCINFOBAR_LANG = env.lang;
    resetLanguageCache();
    const handle = await startEditor({ configPath: file, open: false, port: 0 });
    try {
      const url = new URL('/api/state', handle.url);
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get(url, { headers: { 'x-ccinfobar-token': handle.token } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
      });
      return JSON.parse(body);
    } finally {
      await handle.close();
      if (prev === undefined) delete process.env.CCINFOBAR_LANG;
      else process.env.CCINFOBAR_LANG = prev;
      resetLanguageCache();
    }
  };

  it.each([{ lines: LINES }, { language: 'tr', lines: LINES }])(
    '/api/state is identical under CCINFOBAR_LANG=tr and LANG=C apart from language (%#)',
    async (cfg) => {
      const file = cfgFile(cfg);
      const en = await state({}, file);
      const tr = await state({ lang: 'tr' }, file);
      expect(en.language).toEqual({ id: 'en', source: 'LC_ALL' });
      expect(tr.language).toEqual({ id: 'tr', source: 'CCINFOBAR_LANG' });
      delete en.language;
      delete tr.language;
      expect(JSON.stringify(tr)).toBe(JSON.stringify(en));
      expect(JSON.stringify(en)).toContain('"name":"Model"');
    },
  );
});
