import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMPORT_SOURCES, type ImportSource, resolveSource } from '../../src/importers/index.js';
import {
  type ImportCtx,
  type ImporterDef,
  importerList,
  LEGACY_INFO,
  loadFromRegistry,
  makeCtx,
  REGISTRY,
  registryDef,
} from '../../src/importers/registry.js';

const dummy = (hasDefault: boolean, shown: string | null = '~/.dummy/config.json') => {
  const calls = { discover: 0, load: [] as (string | null)[] };
  const def: ImporterDef = {
    source: 'dummy' as ImportSource,
    name: 'Dummy',
    repo: 'example/dummy',
    shown,
    hasDefault,
    discover: (ctx: ImportCtx) => {
      calls.discover++;
      return shown === null ? null : path.join(ctx.home, '.dummy', 'config.json');
    },
    load: (file) => {
      calls.load.push(file);
      return {
        config: { lines: [[{ id: 'm', type: 'model' }]] },
        notes: [],
        source: 'dummy' as ImportSource,
      };
    },
  };
  return { def, calls };
};

describe('loadFromRegistry', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-registry-')));
    env = { HOME: home, USERPROFILE: home };
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('fails with notFound naming the tool and the tildified path', () => {
    const { def, calls } = dummy(false);
    expect(() => loadFromRegistry(def, { env })).toThrow('no Dummy config found');
    expect(() => loadFromRegistry(def, { env })).toThrow(path.join('~', '.dummy', 'config.json'));
    expect(calls.load).toEqual([]);
  });

  it('names the shown text when nothing was discovered', () => {
    expect(() => loadFromRegistry(dummy(false, null).def, { env })).toThrow(
      'no Dummy config found (path from the status line command)',
    );
  });

  it('loads the default layout when the file is missing and the tool has one', () => {
    const { def, calls } = dummy(true);
    expect(loadFromRegistry(def, { env }).config.lines).toHaveLength(1);
    expect(calls.load).toEqual([null]);
  });

  it('loads the discovered file', () => {
    const file = path.join(home, '.dummy', 'config.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '{}');
    const { def, calls } = dummy(false);
    loadFromRegistry(def, { env });
    expect(calls.load).toEqual([file]);
  });

  it('ignores a discovered directory', () => {
    fs.mkdirSync(path.join(home, '.dummy', 'config.json'), { recursive: true });
    const { def, calls } = dummy(true);
    loadFromRegistry(def, { env });
    expect(calls.load).toEqual([null]);
  });

  it('loads --file without discovery', () => {
    const { def, calls } = dummy(false);
    loadFromRegistry(def, { file: 'x', env });
    expect(calls).toEqual({ discover: 0, load: ['x'] });
  });
});

describe('makeCtx', () => {
  it('splits the command and takes home from env', () => {
    expect(makeCtx({ command: 'x --a b', env: { HOME: '/h' } })).toEqual({
      command: 'x --a b',
      args: ['x', '--a', 'b'],
      argv: [],
      env: { HOME: '/h' },
      cwd: process.cwd(),
      home: '/h',
    });
    const tool = (a: string) => a === 'x';
    expect(makeCtx({ command: 'sh -c "x --a b"', env: { HOME: '/h' } }, tool).argv).toEqual([
      'x',
      '--a',
      'b',
    ]);
    expect(makeCtx({ command: 'y --a b', env: { HOME: '/h' } }, tool).argv).toEqual([]);
    expect(makeCtx({ env: { USERPROFILE: 'C:\\U' } }).home).toBe('C:\\U');
    expect(makeCtx({ env: { HOME: '', USERPROFILE: 'C:\\U' }, cwd: '/w' })).toMatchObject({
      home: 'C:\\U',
      cwd: '/w',
      command: '',
      args: [],
    });
  });
});

describe('registry', () => {
  it('lists the legacy tools and registry tools in IMPORT_SOURCES order', () => {
    expect(importerList().map((i) => i.source)).toEqual([...IMPORT_SOURCES]);
    expect(LEGACY_INFO.map((i) => i.source)).toEqual([
      'ccstatusline',
      'claude-powerline',
      'ccometixline',
      'cship',
      'claude-hud',
    ]);
    expect(resolveSource('ccline')).toBe('ccometixline');
    expect(resolveSource('CCLine')).toBe('ccometixline');
  });

  it('keeps registry sources unique and apart from the legacy ones', () => {
    const legacy = new Set<string>(LEGACY_INFO.map((i) => i.source));
    const sources = REGISTRY.map((d) => d.source);
    expect(new Set(sources).size).toBe(sources.length);
    for (const def of REGISTRY) {
      expect(IMPORT_SOURCES, def.source).toContain(def.source);
      expect(legacy.has(def.source), def.source).toBe(false);
      expect(registryDef(def.source)).toBe(def);
    }
    for (const s of legacy) expect(registryDef(s as ImportSource)).toBeNull();
  });

  it('keeps aliases unique and off the source ids', () => {
    const aliases = importerList().flatMap((i) => i.aliases ?? []);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const a of aliases) {
      expect(IMPORT_SOURCES as readonly string[]).not.toContain(a);
      expect(resolveSource(a)).not.toBeNull();
    }
  });
});
