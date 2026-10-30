import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, normalizeConfig } from '../../src/core/config.js';
import { aliasesFor, canonicalOptions, OPTION_ALIASES } from '../../src/core/option-aliases.js';
import { renderPreview } from '../../src/core/preview.js';
import { type ImportSource, importFrom, toConfig } from '../../src/importers/index.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const fx = (name: string) => path.join(FIXTURES, name);

describe('canonicalOptions', () => {
  it('turns inverted aliases into the canonical key', () => {
    expect(canonicalOptions('fast-mode', { showOff: true })).toEqual({ hideOff: false });
    expect(canonicalOptions('fast-mode', { showOff: 'false' })).toEqual({ hideOff: true });
  });

  it('renames plain aliases', () => {
    expect(canonicalOptions('agents', { maxAgents: 3 })).toEqual({ maxItems: 3 });
  });

  it('lets the canonical key win', () => {
    expect(canonicalOptions('budget', { display: 'bar', show: 'pct' })).toEqual({ show: 'pct' });
  });

  it('keeps other keys and returns the same object when nothing changes', () => {
    expect(canonicalOptions('agents', { maxAgents: 3, width: 4 })).toEqual({ maxItems: 3, width: 4 });
    const same = { mode: 'x' };
    expect(canonicalOptions('model', same)).toBe(same);
    const empty = {};
    expect(canonicalOptions('constructor', empty)).toBe(empty);
    expect(canonicalOptions('budget', undefined)).toBeUndefined();
  });
});

let dir: string;
let env: NodeJS.ProcessEnv;
let prev: Record<string, string | undefined>;

const KEYS = ['CCINFOBAR_CONFIG_DIR', 'CCINFOBAR_CACHE_DIR', 'NO_COLOR', 'FORCE_COLOR'];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccinfobar-canon-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  env = { HOME: home, USERPROFILE: home };
  prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '3';
});

afterEach(() => {
  for (const k of KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const isAliasKey = (type: string, key: string) =>
  Object.hasOwn(OPTION_ALIASES, type) &&
  Object.keys(OPTION_ALIASES[type]!).some((canon) => aliasesFor(type, canon).some((a) => a.key === key));

interface Case {
  source: ImportSource;
  file?: string;
  command?: string;
  script?: string;
}

const CASES: Case[] = [
  { source: 'claude-statusbar', file: fx('claude-statusbar.json') },
  { source: 'token-tracker', file: fx('token-tracker.json') },
  { source: 'nycu-cc-statusline', file: fx('nycu-cc-statusline.json') },
  { source: 'claude-ultimate-hud', file: fx('claude-ultimate-hud.json') },
  { source: 'claude-hud', file: fx('claude-hud.json') },
  { source: 'cc-statusline', command: 'bash ~/.claude/statusline.sh', script: fx('cc-statusline.sh') },
  { source: 'claudebar', file: fx('claudebar.toml') },
  { source: 'coralline', file: fx('coralline.conf') },
  { source: 'claude-usage-monitor', file: fx('claude-usage-monitor.settings.json') },
  { source: 'claude-powerline', file: fx('claude-powerline.json') },
  { source: 'pyccsl', file: fx('pyccsl.env') },
  { source: 'statusline-pro', file: fx('statusline-pro.toml') },
  { source: 'claudeline', command: 'claudeline -cwd -git-branch -cost' },
  { source: 'ccstatusline', file: fx('ccstatusline-settings.json') },
];

describe('toConfig canonical option names', () => {
  let changed = 0;

  // both renders must see the same clock and memory
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-30T12:00:00Z') });
    vi.spyOn(os, 'totalmem').mockReturnValue(16 * 2 ** 30);
    vi.spyOn(os, 'freemem').mockReturnValue(8 * 2 ** 30);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const c of CASES) {
    it(`${c.source} renders byte-identically with canonical names`, () => {
      if (c.script) fs.copyFileSync(c.script, path.join(env.HOME!, '.claude', 'statusline.sh'));
      const result = importFrom(c.source, {
        ...(c.file ? { file: c.file } : {}),
        ...(c.command ? { command: c.command } : {}),
        env,
        cwd: dir,
      });
      const old = normalizeConfig({
        ...defaultConfig(),
        ...result.config,
        lines: result.config.lines ?? [],
      });
      const neu = toConfig(result);
      for (const lang of ['en', 'tr'] as const) {
        withLang(lang, () => {
          expect(renderPreview(neu, 'sample', 120)).toEqual(renderPreview(old, 'sample', 120));
        });
      }
      for (const item of neu.lines.flat()) {
        for (const key of Object.keys(item.options ?? {})) {
          expect(isAliasKey(item.type, key), `${c.source}: ${item.type}.${key}`).toBe(false);
        }
      }
      const opts = (cfg: typeof old) => JSON.stringify(cfg.lines.flat().map((i) => i.options));
      if (opts(old) !== opts(neu)) changed++;
    });
  }

  it('changed at least one importer output', () => {
    expect(changed).toBeGreaterThan(0);
  });
});
