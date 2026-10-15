import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { help } from '../../src/cli/help.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { runExplain } from '../../src/commands/explain.js';
import type { CliIo } from '../../src/commands/io.js';
import { runPreview } from '../../src/commands/manage.js';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { configDir } from '../../src/core/paths.js';
import {
  getScenario,
  SCENARIO_NOW,
  scenarioConfig,
  scenarioEnv,
  scenarioList,
} from '../../src/core/scenarios.js';
import type { Config } from '../../src/core/types.js';
import { VERSION } from '../../src/core/version.js';
import { initialState, reduce } from '../../src/tui/state.js';
import { renderScreen } from '../../src/tui/view.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { NOW, withLang } from '../helpers.js';

const SNAP = (name: string) => `__snapshots__/tr/${name}.txt`;

// env keys the outputs may read; everything else is dropped for the suite
const KEEP =
  /^(PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_\w+|TMPDIR|TMP|TEMP|LANG|LC_ALL|CCINFOBAR_\w+|CLAUDE_CONFIG_DIR|CCIB_\w+|VITEST\w*|NODE_\w+)$/;

let savedEnv: NodeJS.ProcessEnv;
let savedTz: string | undefined;

beforeAll(() => {
  savedEnv = { ...process.env };
  savedTz = process.env.TZ;
  for (const k of Object.keys(process.env)) if (!KEEP.test(k)) delete process.env[k];
  process.env.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

afterAll(() => {
  vi.useRealTimers();
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const roots = (): string[] => {
  const out = new Set<string>();
  for (const p of [process.env.CCIB_TEST_ROOT, process.env.CCIB_TEST_PARENT]) {
    if (!p) continue;
    out.add(p);
    try {
      out.add(fs.realpathSync.native(p));
    } catch {}
  }
  return [...out].sort((a, b) => b.length - a.length);
};

const normalize = (text: string): string => {
  let s = stripAnsi(text);
  for (const r of roots()) s = s.split(r).join('<tmp>');
  s = s.replace(/<tmp>[\\/][^\s"')]*/g, (p) => p.replace(/\\/g, '/'));
  s = s.split(VERSION).join('X.Y.Z').split(process.versions.node).join('N.N.N');
  return `${s.replace(/[ \t]+$/gm, '').trimEnd()}\n`;
};

const capture = () => {
  const out: string[] = [];
  const io: CliIo = { tty: false, log: (l) => out.push(l), error: (l) => out.push(l) };
  return { out, io };
};

const cfgFile = (cfg: object): string => {
  fs.mkdirSync(configDir(), { recursive: true });
  const file = path.join(configDir(), 'snapshots.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
};

const TR: Partial<Config> = { language: 'tr', colorLevel: 0, icons: 'text' };

function widgetLines(id: string): string {
  const scenario = getScenario(id)!;
  const bundle = scenario.build(SCENARIO_NOW);
  const config = scenarioConfig({ ...defaultConfig(), ...TR }, bundle);
  const ctx = createContext({
    payload: bundle.payload,
    config,
    env: scenarioEnv({}, bundle.env),
    now: new Date(SCENARIO_NOW),
    preview: true,
    terminalWidth: 120,
    data: bundle.data,
  });
  const rows = ALL_WIDGETS.filter((w) => !w.hidden).map((def) => {
    // live host values (hostname, memory, …) carry no words
    if (def.sources?.includes('system')) return `${def.type}: (system)`;
    const out = def.render(ctx, { id: def.type, type: def.type });
    const text = out == null ? null : typeof out === 'string' ? out : out.text;
    return `${def.type}: ${text ? text.replace(/\n/g, ' ⏎ ') : '(empty)'}`;
  });
  return rows.join('\n');
}

const checked = (text: string): string => {
  expect(text).not.toContain('\u001b');
  expect(text.normalize('NFC')).toBe(text);
  return text;
};

describe('Turkish snapshots', () => {
  it.each(scenarioList().map((s) => s.id))('widgets under %s', async (id) => {
    const text = normalize(withLang('tr', () => widgetLines(id)));
    await expect(checked(text)).toMatchFileSnapshot(SNAP(`widgets-${id}`));
  });

  it('--help', async () => {
    await expect(checked(normalize(withLang('tr', help)))).toMatchFileSnapshot(SNAP('help'));
  });

  it('doctor', async () => {
    const file = cfgFile({ language: 'tr' });
    const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'doctor-'));
    fs.writeFileSync(path.join(dir, 'ccinfobar.js'), '');
    const prev = { cwd: process.cwd(), argv: process.argv[1] };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.chdir(dir);
      process.argv[1] = path.join(dir, 'ccinfobar.js');
      runDoctor(file, { managedFiles: [] });
      const text = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      await expect(checked(normalize(text))).toMatchFileSnapshot(SNAP('doctor'));
    } finally {
      spy.mockRestore();
      process.chdir(prev.cwd);
      if (prev.argv !== undefined) process.argv[1] = prev.argv;
    }
  });

  it('explain', async () => {
    const c = capture();
    runExplain(parseArgs(['explain', '--width', '120']), cfgFile({ language: 'tr' }), c.io);
    await expect(checked(normalize(c.out.join('\n')))).toMatchFileSnapshot(SNAP('explain'));
  });

  it('preview', async () => {
    const file = cfgFile({ language: 'tr' });
    const parts: string[] = [];
    for (const [title, argv] of [
      ['preview --scenario', ['--scenario']],
      ['preview', []],
      ['preview --scenario near-5h-limit', ['--scenario', 'near-5h-limit']],
    ] as const) {
      const c = capture();
      withLang('tr', () => runPreview(parseArgs(['preview', ...argv, '--width', '120']), file, c.io));
      parts.push(`## ${title}\n${c.out.join('\n')}`);
    }
    await expect(checked(normalize(parts.join('\n\n')))).toMatchFileSnapshot(SNAP('preview'));
  });

  it('TUI view', async () => {
    const config = { ...defaultConfig(), language: 'tr' as const };
    const base = initialState(config, '/tmp/cc/config.json');
    const screens = withLang('tr', () =>
      [
        ['normal', base],
        ['picker', reduce(base, { type: 'openPicker' })],
      ].map(([name, s]) => `## ${name}\n${renderScreen(s as typeof base, 100, 30).lines.join('\n')}`),
    );
    await expect(checked(normalize(screens.join('\n\n')))).toMatchFileSnapshot(SNAP('tui'));
  });
});
