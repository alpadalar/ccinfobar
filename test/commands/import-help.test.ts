import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { resetLanguageCache } from '../../src/cli/lang.js';
import { main } from '../../src/cli/main.js';
import { importHelp } from '../../src/commands/import-help.js';
import { runImportCommand } from '../../src/commands/manage.js';
import { VERSION } from '../../src/core/version.js';
import { visibleWidth } from '../../src/core/width.js';
import { IMPORT_SOURCES } from '../../src/importers/index.js';
import { importerList } from '../../src/importers/registry.js';
import { withLang } from '../helpers.js';

const fixture = fs
  .readFileSync(path.resolve(__dirname, '../fixtures/help-en.txt'), 'utf8')
  .replace('{version}', VERSION);

const rows = (text: string) => text.split('\n').filter((l) => /^ {2}\S/.test(l));

function columns(text: string): number[][] {
  return rows(text).map((line) => {
    const starts: number[] = [];
    for (const m of line.matchAll(/ {2,}(?=\S)/g))
      starts.push(visibleWidth(line.slice(0, m.index + m[0].length)));
    return starts;
  });
}

function expectListing(text: string) {
  const list = importerList();
  const lines = rows(text);
  expect(lines.length).toBe(list.length);
  for (const [i, info] of list.entries()) {
    const ids = [info.source, ...(info.aliases ?? [])].join(', ');
    expect(lines[i]!.startsWith(`  ${ids}  `), lines[i]).toBe(true);
    expect(lines[i]).toContain(`${info.name} (${info.repo})`);
  }
  for (const id of IMPORT_SOURCES)
    expect(
      lines.some((l) => l.startsWith(`  ${id}`)),
      id,
    ).toBe(true);
  expect(lines.some((l) => l.startsWith('  ccometixline, ccline  '))).toBe(true);
  for (const line of text.split('\n')) expect(line, line).not.toMatch(/\s$/);
  const cols = columns(text);
  for (const c of cols) expect(c.slice(0, 2)).toEqual(cols[0]!.slice(0, 2));
}

describe('importHelp', () => {
  it('lists every tool in English', () => {
    const text = importHelp();
    expect(text.split('\n').slice(0, 4)).toEqual([
      "Import another status line's layout into ccinfobar",
      'Usage: ccinfobar import <tool> [--file <path>] [--command <cmd>] [--force] [--dry-run] [--allow-commands]',
      '',
      'Tools',
    ]);
    expect(text).toContain('  ccstatusline  ');
    expect(text).toContain('~/.config/ccstatusline/settings.json');
    expect(text).toContain('Without --file');
    expectListing(text);
  });

  it('lists the same ids in Turkish', () => {
    const tr = withLang('tr', () => importHelp());
    expect(tr).not.toBe(importHelp());
    expect(tr).toContain('Kullanım: ccinfobar import <tool>');
    expect(tr).toContain('Araçlar\n');
    expectListing(tr);
  });
});

describe('import help from main', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetLanguageCache();
    process.exitCode = undefined;
  });

  const stdout = async (argv: string[]) => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out += String(s);
      return true;
    });
    await main(argv);
    vi.restoreAllMocks();
    return out;
  };

  it('prints the import help for import --help and exits 0', async () => {
    expect(await stdout(['import', '--help'])).toBe(importHelp());
    expect(process.exitCode).toBeUndefined();
  });

  it('follows the env language', async () => {
    vi.stubEnv('CCINFOBAR_LANG', 'tr');
    resetLanguageCache();
    expect(await stdout(['import', '--help'])).toBe(withLang('tr', () => importHelp()));
  });

  it('keeps the global help byte for byte', async () => {
    expect(await stdout(['--help'])).toBe(fixture);
  });
});

describe('import without a known tool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
    const cfg = path.join(process.env.CCIB_TEST_ROOT!, 'import-help-none.json');
    await runImportCommand(parseArgs(['import', ...argv]), cfg);
    const code = process.exitCode;
    vi.restoreAllMocks();
    return { out, err, code };
  };

  it('prints the listing and exits 1 without a tool', async () => {
    const r = await run();
    expect(r.out).toEqual(importHelp().trimEnd().split('\n'));
    expect(r.err).toEqual([]);
    expect(r.code).toBe(1);
  });

  it('prints the short usage for an unknown tool', async () => {
    const r = await run('nope');
    expect(r.out).toEqual([]);
    expect(r.err).toEqual([
      'Usage: ccinfobar import <tool> [--file <path>] [--command <cmd>] [--force] [--dry-run] [--allow-commands]',
      'Run ccinfobar import --help for the list of tools',
    ]);
    expect(r.code).toBe(1);
  });
});
