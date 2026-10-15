import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { help, OPTIONS, USAGE } from '../../src/cli/help.js';
import { resetLanguageCache } from '../../src/cli/lang.js';
import { main } from '../../src/cli/main.js';
import { runRender } from '../../src/cli/render.js';
import { cliMessages } from '../../src/core/i18n/en/cli.js';
import type { LanguageDef } from '../../src/core/i18n/index.js';
import { claudeSettingsPath } from '../../src/core/paths.js';
import { VERSION } from '../../src/core/version.js';
import { visibleWidth } from '../../src/core/width.js';
import { withLang } from '../helpers.js';

const fixture = fs
  .readFileSync(path.resolve(__dirname, '../fixtures/help-en.txt'), 'utf8')
  .replace('{version}', VERSION);

const COL = 34;

const KNOWN = [...USAGE, ...OPTIONS].map(([u]) => u);

function usageOf(line: string): string | undefined {
  return KNOWN.filter((u) => line === `  ${u}` || line.startsWith(`  ${u} `)).sort(
    (a, b) => b.length - a.length,
  )[0];
}

function usages(text: string): string[] {
  return text
    .split('\n')
    .map(usageOf)
    .filter((u) => u !== undefined);
}

function expectAligned(text: string) {
  let seen = 0;
  for (const line of text.split('\n')) {
    expect(line, line).not.toMatch(/\s$/);
    if (!line.startsWith('  ')) continue;
    if (line.startsWith('   ')) {
      expect(/^ */.exec(line)![0].length, line).toBe(COL);
      continue;
    }
    const u = usageOf(line);
    expect(u, line).toBeDefined();
    seen++;
    if (line === `  ${u}`) {
      expect(visibleWidth(u!), line).toBeGreaterThan(COL - 4);
      continue;
    }
    expect(visibleWidth(u!), `${line}: two spaces before the text`).toBeLessThanOrEqual(COL - 4);
    expect(line.slice(0, COL), line).toBe(`  ${u!.padEnd(COL - 2)}`);
    expect(visibleWidth(line.slice(0, COL)), line).toBe(COL);
    expect(line[COL], line).not.toBe(' ');
  }
  expect(seen).toBe(KNOWN.length);
}

describe('help()', () => {
  it('matches the English help byte for byte', () => {
    expect(help()).toBe(fixture);
  });

  it('is built at call time', () => {
    const tr = withLang('tr', () => help());
    expect(tr).not.toBe(fixture);
    expect(help()).toBe(fixture);
  });

  it('keeps English aligned', () => {
    expectAligned(help());
  });

  it('translates descriptions and keeps usage literal in Turkish', () => {
    const tr = withLang('tr', () => help());
    expect(tr).toContain('Kullanım\n');
    expect(tr).toContain('Seçenekler\n');
    expect(tr).toContain('Durum satırını görüntüler');
    expect(usages(tr)).toEqual(KNOWN);
    expect(usages(fixture)).toEqual(KNOWN);
    for (const u of usages(fixture)) expect(tr, u).toContain(`  ${u}`);
    expect(tr.split('\n').length).toBe(fixture.split('\n').length);
    expect(tr).toContain('default, cockpit, dashboard');
    expectAligned(tr);
  });

  it('aligns by visible width with fullwidth text', () => {
    const wide = Object.fromEntries(
      Object.keys(cliMessages).map((id) => [
        id,
        id === 'help.cmd.uninstall' ? 'ＡＢＣ\u3000ｄ\nＥＦ' : 'ＷＩＤＥ\u3000ｔｅｘｔ',
      ]),
    );
    const zz: LanguageDef = { id: 'zz', name: 'Wide', aliases: [], locale: 'en', messages: wide };
    const text = withLang(zz, () => help());
    expect(text).toContain(
      `  ${'ccinfobar uninstall'.padEnd(COL - 2)}ＡＢＣ\u3000ｄ\n${' '.repeat(COL)}ＥＦ\n`,
    );
    expect(text).toContain(`  ccinfobar preview --scenario <name>\n${' '.repeat(COL)}ＷＩＤＥ`);
    expectAligned(text);
  });
});

describe('cli messages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetLanguageCache();
  });

  const unknown = async (lang?: string) => {
    if (lang) vi.stubEnv('CCINFOBAR_LANG', lang);
    resetLanguageCache();
    const err: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((s) => void err.push(String(s)));
    await main(['frobnicate']);
    process.exitCode = undefined;
    return err;
  };

  it('names an unknown command in the env language', async () => {
    expect(await unknown()).toEqual(['Unknown command "frobnicate". Run ccinfobar --help.']);
    expect(await unknown('tr')).toEqual(['Bilinmeyen komut "frobnicate". ccinfobar --help çalıştırın.']);
  });

  it.each([
    ['en', 'ccinfobar: invalid JSON on stdin\n'],
    ['tr', "ccinfobar: stdin'den gelen JSON geçersiz\n"],
  ])('reports bad payload JSON in the config language (%s)', async (language, text) => {
    const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'help-json-'));
    const file = path.join(dir, 'p.json');
    fs.writeFileSync(file, '{"session_id": ');
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ language, lines: [[{ id: 'm', type: 'model' }]] }));
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out += String(s);
      return true;
    });
    await runRender(parseArgs(['--payload', file]), cfg);
    vi.restoreAllMocks();
    expect(out).toBe(text);
  });
});

describe('command errors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it.each([[['install', '--command', '/bin/ccinfobar']], [['uninstall']]])(
    'prints why %j failed without a terminal',
    async (argv) => {
      const file = claudeSettingsPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{\n  "model": "opus",\n}\n');
      expect(process.stdin.isTTY).toBeFalsy();
      const err: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((s) => void err.push(String(s)));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await main(argv);
        expect(process.exitCode).toBe(1);
        expect(err.join('\n')).toMatch(/^✗ Cannot parse .*settings\.json/);
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
  );
});
