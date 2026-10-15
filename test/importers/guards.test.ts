import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { PromptIo } from '../../src/commands/io.js';
import { runImport, runImportCommand } from '../../src/commands/manage.js';
import { stripAnsi } from '../../src/core/ansi.js';
import { createContext } from '../../src/core/context.js';
import { render } from '../../src/core/renderer.js';
import { sampleGit, sampleGsd, samplePayload, sampleTranscript } from '../../src/core/sample.js';
import type { Config } from '../../src/core/types.js';
import { TARGETS as CCLINE_TARGETS } from '../../src/importers/ccometixline.js';
import { TARGETS as CC_TARGETS } from '../../src/importers/ccstatusline.js';
import { TARGETS as HUD_TARGETS } from '../../src/importers/claude-hud.js';
import { TARGETS as PL_TARGETS } from '../../src/importers/claude-powerline.js';
import { sanitizeImport } from '../../src/importers/confirm.js';
import { TARGETS as CSHIP_TARGETS } from '../../src/importers/cship.js';
import {
  IMPORT_SOURCES,
  type ImportResult,
  type ImportSource,
  importFrom,
  toConfig,
} from '../../src/importers/index.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const NOW = new Date('2026-10-12T12:00:00Z');

// CSI, OSC 8 link ended by BEL, a bare BEL and RLO
const HOSTILE = 'A\x1b[31mB\x1b]8;;https://evil.example.com\x07C\x07D\u202eE';
const toml = (s: string) =>
  JSON.stringify(s).replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

interface Tool {
  source: ImportSource;
  targets: readonly string[];
  fixtures: string[];
  // cship reads a wrapper-free file only under this name
  rename?: Record<string, string>;
  ext: string;
  hostile: string;
  proto?: string;
}

const TOOLS: Tool[] = [
  {
    source: 'ccstatusline',
    targets: CC_TARGETS,
    fixtures: ['ccstatusline-settings.json'],
    ext: 'json',
    hostile: JSON.stringify({
      lines: [
        [
          { id: 't', type: 'custom-text', customText: HOSTILE },
          { id: 's', type: 'separator', character: HOSTILE },
          { id: 'm', type: 'model' },
        ],
      ],
    }),
  },
  {
    source: 'claude-powerline',
    targets: PL_TARGETS,
    fixtures: ['claude-powerline.json'],
    ext: 'json',
    hostile: JSON.stringify({
      display: { lines: [{ segments: { env: { variable: HOSTILE }, [HOSTILE]: {}, model: {} } }] },
    }),
  },
  {
    source: 'ccometixline',
    targets: CCLINE_TARGETS,
    fixtures: ['ccometixline.toml', 'ccometixline-inline.toml', 'ccline-theme.toml'],
    ext: 'toml',
    hostile: [
      '[style]',
      'mode = "plain"',
      `separator = ${toml(HOSTILE)}`,
      '[[segments]]',
      'id = "model"',
      '[segments.icon]',
      `plain = ${toml(HOSTILE)}`,
      '[[segments]]',
      `id = ${toml(HOSTILE)}`,
      '',
    ].join('\n'),
    proto: '__proto__ = 1\n',
  },
  {
    source: 'cship',
    targets: CSHIP_TARGETS,
    fixtures: ['cship.toml', 'cship-wrapperless.toml', 'starship.toml'],
    rename: { 'cship-wrapperless.toml': 'cship.toml' },
    ext: 'toml',
    hostile: [
      '[cship]',
      `lines = [${toml(`$cship.model ${HOSTILE} $cship.cost`)}]`,
      '[cship.model]',
      `symbol = ${toml(HOSTILE)}`,
      '',
    ].join('\n'),
    proto: '[cship]\n__proto__ = 1\n',
  },
  {
    source: 'claude-hud',
    targets: HUD_TARGETS,
    fixtures: ['claude-hud.json', 'claude-hud.override.json'],
    ext: 'json',
    hostile: JSON.stringify({ elementOrder: ['project'], display: { customLine: HOSTILE } }),
  },
];

const BAD =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|\\u00(?:0[0-8bcef]|1[0-9a-f]|7f|[89][0-9a-f])|\\u20(?:2[a-e]|6[6-9])/i;

const show = (config: Config) =>
  render(
    createContext({
      payload: samplePayload(NOW.getTime()),
      config: { ...config, colorLevel: 0, maxWidth: 200 },
      env: {},
      now: NOW,
      data: { git: sampleGit, gsd: sampleGsd, transcript: () => sampleTranscript(NOW.getTime()) },
    }),
  ).map(stripAnsi);

const count = (r: { config: Partial<Config> }) => (r.config.lines ?? []).reduce((n, l) => n + l.length, 0);

const fakeIo = () => {
  const lines: string[] = [];
  const io: PromptIo = {
    tty: false,
    ask: async (_q, fallback) => fallback,
    log: (l) => lines.push(l),
    error: (l) => lines.push(l),
    columns: 100,
  };
  return { io, lines };
};

const ownProto = (v: unknown): boolean => {
  if (Array.isArray(v)) return v.some(ownProto);
  if (!v || typeof v !== 'object') return false;
  return Object.hasOwn(v, '__proto__') || Object.values(v).some(ownProto);
};

const listing = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();

describe('cross-importer guards', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let cfgFile: string;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-guards-')));
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
    cfgFile = path.join(dir, 'config', 'config.json');
  });

  afterEach(() => {
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const load = (tool: Tool, file?: string): ImportResult =>
    importFrom(tool.source, { ...(file ? { file } : {}), env, cwd: dir });

  const fixture = (tool: Tool, f: string) => {
    const name = tool.rename?.[f];
    if (!name) return path.join(FIXTURES, f);
    const file = path.join(dir, 'fx', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, f), file);
    return file;
  };

  const writeSource = (tool: Tool, text: string) => {
    const file = path.join(dir, `source.${tool.ext}`);
    fs.writeFileSync(file, text);
    return file;
  };

  it('covers every import source', () => {
    expect(TOOLS.map((x) => x.source).sort()).toEqual([...IMPORT_SOURCES].sort());
  });

  describe.each(TOOLS)('$source', (tool) => {
    it('targets only existing widgets and emits only targets', () => {
      const types = new Set(ALL_WIDGETS.map((w) => w.type));
      for (const type of tool.targets) expect(types.has(type), type).toBe(true);
      for (const f of tool.fixtures) {
        for (const item of (load(tool, fixture(tool, f)).config.lines ?? []).flat()) {
          expect(tool.targets, `${f}: ${item.type}`).toContain(item.type);
        }
      }
    });

    it('keeps every fixture item through sanitize and normalize and renders it', () => {
      const results = tool.fixtures.map((f) => load(tool, fixture(tool, f)));
      if (tool.source !== 'ccstatusline' && tool.source !== 'cship') results.push(load(tool));
      for (const r of results) {
        expect(count(r)).toBeGreaterThan(0);
        const cfg = toConfig(sanitizeImport(r));
        expect(count({ config: cfg }), r.file ?? 'default').toBe(count(r));
        const lines = show(cfg);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join('')).not.toMatch(BAD);
      }
    });

    it('strips control and bidi characters from labels and text', async () => {
      const file = writeSource(tool, tool.hostile);
      const f = fakeIo();
      const flags = { allowCommands: false, yes: true, dryRun: false };
      expect(await runImport(tool.source, { file, command: '', flags }, cfgFile, f.io)).toBe(true);
      const saved = fs.readFileSync(cfgFile, 'utf8');
      expect(saved).toContain('ABCDE');
      expect(saved).not.toMatch(BAD);
      for (const line of f.lines) expect(line).not.toMatch(BAD);
    });

    it('never pollutes prototypes', () => {
      if (tool.proto) {
        const file = writeSource(tool, tool.proto);
        const line = tool.proto.split('\n').findIndex((l) => l.startsWith('__proto__')) + 1;
        expect(() => load(tool, file)).toThrow(new RegExp(`:${line}:1 The key "__proto__" is not allowed`));
        return;
      }
      const evil = '{"polluted": 1}';
      const text =
        tool.source === 'ccstatusline'
          ? `{"__proto__": ${evil}, "lines": [[{"id": "m", "type": "model", "__proto__": ${evil}}, {"type": "__proto__"}, {"type": "constructor"}, {"type": "toString"}]]}`
          : tool.source === 'claude-powerline'
            ? `{"__proto__": ${evil}, "display": {"__proto__": ${evil}, "lines": [{"segments": {"__proto__": ${evil}, "constructor": {}, "model": {}}}]}, "colors": {"custom": {"__proto__": ${evil}}}}`
            : `{"elementOrder": ["project"], "display": {"__proto__": ${evil}, "customLine": "x"}}`;
      const file = writeSource(tool, text);
      if (tool.source === 'claude-hud') {
        const over = path.join(env.CLAUDE_CONFIG_DIR!, 'claude-hud.json');
        fs.mkdirSync(path.dirname(over), { recursive: true });
        fs.writeFileSync(over, `{"__proto__": ${evil}, "display": {"constructor": ${evil}, "prototype": 1}}`);
      }
      const r = sanitizeImport(load(tool, file));
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('polluted');
      expect(ownProto(r.config)).toBe(false);
      expect(ownProto(toConfig(r))).toBe(false);
      const types = (r.config.lines ?? []).flat().map((i) => i.type);
      for (const type of types) expect(tool.targets, String(type)).toContain(type);
      expect(types.length).toBeGreaterThan(0);
    });

    it('--dry-run writes nothing', async () => {
      fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
      fs.writeFileSync(cfgFile, '{"lines": [[{"id": "keep", "type": "model"}]]}\n');
      const before = listing(dir);
      const bytes = fs.readFileSync(cfgFile);
      const f = fakeIo();
      const argv = ['import', tool.source, '--dry-run', '--file', path.join(FIXTURES, tool.fixtures[0]!)];
      await runImportCommand(parseArgs(argv), cfgFile, f.io);
      expect(process.exitCode ?? 0, f.lines.join('\n')).toBe(0);
      expect(f.lines.at(-1)).toBe('Dry run: nothing was written.');
      expect(listing(dir)).toEqual(before);
      expect(fs.readFileSync(cfgFile).equals(bytes)).toBe(true);
    });
  });
});
