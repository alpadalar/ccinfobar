import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { PromptIo } from '../../src/commands/io.js';
import { runImport, runImportCommand } from '../../src/commands/manage.js';
import { importCcpet, TARGETS } from '../../src/importers/ccpet.js';
import { detectTool, importFrom } from '../../src/importers/index.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const FILE = path.join(FIXTURES, 'ccpet.json');
const fixture = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

type R = ReturnType<typeof importCcpet>;
const types = (r: R) => r.config.lines!.map((l) => l.map((i) => i.type));
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: R) => r.notes.map((n) => n.text);

const PET = 'ccpet "expression, energy-bar, energy-value" is approximated by the pet widget';
const TOTAL = 'ccpet "total" is approximated by the tokens-total widget';
const ACC = 'ccpet widget "accumulated-tokens" has no ccinfobar equivalent and was skipped';
const LIFE = 'ccpet widget "lifetime-tokens" has no ccinfobar equivalent and was skipped';
const TOKENS = ['tokens-input', 'tokens-output', 'tokens-cached', 'tokens-total'];

describe('importCcpet', () => {
  it('maps the default config with a custom third line and colors', () => {
    const r = importCcpet(fixture());
    expect(r.source).toBe('ccpet');
    expect(types(r)).toEqual([['pet'], TOKENS, ['context-percentage', 'session-cost']]);
    expect(r.config).toMatchObject({ style: 'text', separator: ' ' });
    expect(item(r, 'pet')).toEqual({ id: 'ccpet-pet', type: 'pet', color: '#ffff00', bold: true });
    expect(item(r, 'tokens-cached')).toMatchObject({ color: '#f4a460' });
    expect(item(r, 'tokens-cached')!.bold).toBeUndefined();
    expect(item(r, 'context-percentage')).toMatchObject({ options: { basis: 'usable' }, color: '#90ee90' });
    expect(item(r, 'session-cost')).toMatchObject({ color: '#ffd700', bold: true });
    expect(r.notes).toEqual([
      { kind: 'approx', text: PET },
      { kind: 'approx', text: TOTAL },
      { kind: 'drop', text: ACC },
      { kind: 'drop', text: LIFE },
      { kind: 'drop', text: 'ccpet settings not imported: pet' },
    ]);
  });

  it('imports the defaults when there is no file', () => {
    const r = importCcpet({}, { defaulted: true });
    expect(types(r)).toEqual([
      ['pet'],
      TOKENS,
      ['context-length', 'context-percentage', 'context-percentage', 'session-cost'],
    ]);
    const third = r.config.lines![2]!;
    expect(third[1]!.options).toBeUndefined();
    expect(third[2]).toMatchObject({ id: 'ccpet-context-percentage-2', options: { basis: 'usable' } });
    expect(item(r, 'session-cost')!.bold).toBeUndefined();
    expect(texts(r)).toEqual([
      'no ccpet config file found, imported its default layout',
      PET,
      TOTAL,
      ACC,
      LIFE,
    ]);
  });

  it('follows maxLines and enabled', () => {
    expect(types(importCcpet({ display: { maxLines: 2 } }))).toEqual([['pet'], TOKENS]);
    expect(types(importCcpet({ display: { maxLines: 1 } }))).toEqual([['pet']]);
    const off = importCcpet({ display: { line2: { enabled: false }, line1: { enabled: false } } });
    expect(types(off)).toEqual([
      ['context-length', 'context-percentage', 'context-percentage', 'session-cost'],
    ]);
    expect(texts(off)).not.toContain(PET);
  });

  it('keeps one pet for the pet items, uses pet-name colors and falls back to the default pet line', () => {
    const named = importCcpet({ display: { line1: { items: ['pet-name', 'lifetime-tokens', 'pet-name'] } } });
    expect(named.config.lines![0]).toEqual([{ id: 'ccpet-pet', type: 'pet', color: '#00ffff' }]);
    expect(texts(named)).toContain('ccpet "pet-name" is approximated by the pet widget');
    const fallback = importCcpet({ display: { line1: { items: ['input', 'nope'] }, maxLines: 1 } });
    expect(types(fallback)).toEqual([['pet']]);
    expect(texts(fallback)).toEqual([
      PET,
      'ccpet widget "nope" has no ccinfobar equivalent and was skipped',
      ACC,
      LIFE,
      'ccpet settings not imported: display.line1.items "input"',
    ]);
  });

  it('skips pet items on the session lines and unknown names, and names bad colors', () => {
    const r = importCcpet({
      colors: { sessionInput: 'green', cost: '#12345' },
      display: { maxLines: 2, line2: { items: ['input', 'expression', 'cost', 'weather'] } },
    });
    expect(types(r)).toEqual([['pet'], ['tokens-input', 'session-cost']]);
    expect(item(r, 'tokens-input')!.color).toBeUndefined();
    expect(item(r, 'session-cost')!.color).toBeUndefined();
    expect(texts(r).slice(-2)).toEqual([
      'ccpet widget "weather" has no ccinfobar equivalent and was skipped',
      'ccpet settings not imported: display.line2.items "expression", colors.sessionInput, colors.cost',
    ]);
  });

  it('never reads or copies the supabase block', () => {
    const r = importCcpet({ ...fixture(), supabase: { url: 'https://x.example', apiKey: 'REDACTED-TEST' } });
    const json = JSON.stringify(r);
    expect(json).not.toContain('REDACTED-TEST');
    expect(json).not.toContain('x.example');
    const secret = r.notes.filter((n) => n.text.includes('secret'));
    expect(secret).toEqual([
      { kind: 'info', text: 'ccpet setting "supabase" holds a secret and was not copied' },
    ]);
  });

  it('imports the defaults with one note for a file that is not a JSON object', () => {
    for (const raw of [[1], 'x', 3, null]) {
      const r = importCcpet(raw, { file: '~/.claude-pet/config.json' });
      expect(types(r)[1]).toEqual(TOKENS);
      expect(r.notes[0]).toEqual({
        kind: 'info',
        text: '~/.claude-pet/config.json is not a JSON object and was ignored',
      });
    }
  });

  it('ignores prototype keys', () => {
    const raw = JSON.parse(
      '{"__proto__": {"display": {"maxLines": 1}}, "colors": {"__proto__": {"cost": "#000000"}, "toString": "#111111"}, "display": {"line3": {"items": ["toString", "cost"]}}}',
    );
    const r = importCcpet(raw);
    expect(types(r)[2]).toEqual(['session-cost']);
    expect(item(r, 'session-cost')!.color).toBe('#ffd700');
    expect(texts(r)).toContain('ccpet widget "toString" has no ccinfobar equivalent and was skipped');
  });

  it('lists only existing widgets as targets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });

  it('writes its notes in Turkish', () => {
    withLang('tr', () => {
      const r = importCcpet({ supabase: {}, display: { maxLines: 1, line1: { items: ['expression'] } } });
      expect(texts(r)).toEqual([
        'ccpet ayarı "supabase" gizli bir değer içeriyor, kopyalanmadı',
        'ccpet "expression", pet bileşeniyle yaklaşık olarak gösteriliyor',
      ]);
    });
  });
});

describe('ccpet importer', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ccpet-')));
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.claude-pet'), { recursive: true });
    env = { HOME: home, USERPROFILE: home };
  });

  afterEach(() => {
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const homeFile = () => path.join(env.HOME!, '.claude-pet', 'config.json');

  it('reads --file', () => {
    const r = importFrom('ccpet', { file: FILE, env, cwd: dir });
    expect(r.file).toBe(FILE);
    expect(types(r)[2]).toEqual(['context-percentage', 'session-cost']);
  });

  it('finds ~/.claude-pet/config.json, else imports the defaults', () => {
    const none = importFrom('ccpet', { env, cwd: dir });
    expect(none.file).toBeNull();
    expect(texts(none)[0]).toBe('no ccpet config file found, imported its default layout');
    fs.writeFileSync(homeFile(), '{"display": {"maxLines": 1}}');
    const r = importFrom('ccpet', { env, cwd: dir });
    expect(r.file).toBe(homeFile());
    expect(types(r)).toEqual([['pet']]);
    fs.writeFileSync(homeFile(), '{"display": ');
    expect(() => importFrom('ccpet', { env, cwd: dir })).toThrow(/Cannot parse ccpet config/);
  });

  it('never prints the supabase values', async () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ ...fixture(), supabase: { url: 'https://x.example', apiKey: 'REDACTED-TEST' } }),
    );
    const lines: string[] = [];
    const io: PromptIo = {
      tty: false,
      ask: async (_q, fallback) => fallback,
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
      columns: 100,
    };
    const cfgFile = path.join(dir, 'out', 'config.json');
    await runImportCommand(parseArgs(['import', 'ccpet', '--dry-run', '--file', file]), cfgFile, io);
    const flags = { allowCommands: false, yes: true, dryRun: false };
    expect(await runImport('ccpet', { file, command: '', flags }, cfgFile, io)).toBe(true);
    const out = `${lines.join('\n')}\n${fs.readFileSync(cfgFile, 'utf8')}`;
    expect(out).toContain('ccpet setting "supabase" holds a secret and was not copied');
    expect(out).not.toContain('REDACTED-TEST');
    expect(out).not.toContain('x.example');
  });

  it('is detected from its npx and global commands', () => {
    for (const cmd of ['npx ccpet@latest', 'ccpet', '/usr/local/bin/ccpet']) {
      expect(detectTool(cmd), cmd).toMatchObject({ tool: 'ccpet', name: 'ccpet', importable: true });
    }
    expect(detectTool('npx ccpetx')?.tool).toBe('unknown');
  });
});
