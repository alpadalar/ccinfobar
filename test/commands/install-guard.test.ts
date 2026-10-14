import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyInstall,
  InstallNeedsConfirmError,
  install,
  planInstall,
  projectSettingsPath,
  takeOverProjects,
} from '../../src/commands/install.js';
import { findStatusLineEntry, manifestFile, readManifest } from '../../src/commands/manifest.js';

const tmpEnv = () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-guard-')));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
  };
  const file = path.join(dir, 'claude', 'settings.json');
  return { dir, env, file };
};

const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) {
        out[`${p}/`] = '';
        walk(p);
      } else out[p] = fs.readFileSync(p, 'base64');
    }
  };
  walk(dir);
  return out;
}

const foreign = { type: 'command' as const, command: '/usr/local/bin/other-line', refreshInterval: 3 };
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('planInstall', () => {
  it('plans a fresh install into a missing file', () => {
    const { env, file } = tmpEnv();
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(plan).toMatchObject({
      owner: 'none',
      needsConfirm: false,
      changes: true,
      current: null,
      diff: [],
    });
    expect(plan.proposed).toEqual({ type: 'command', command: '/bin/ccinfobar', padding: 0 });
  });

  it('needs confirmation over a foreign statusLine and lists the diffs', () => {
    const { env, file } = tmpEnv();
    writeJson(file, { statusLine: foreign });
    const plan = planInstall({ file, command: '/bin/ccinfobar', refresh: 7.9, env });
    expect(plan.owner).toBe('foreign');
    expect(plan.needsConfirm).toBe(true);
    expect(plan.current).toEqual(foreign);
    expect(plan.proposed).toEqual({
      type: 'command',
      command: '/bin/ccinfobar',
      padding: 0,
      refreshInterval: 7,
    });
    expect(plan.diff).toEqual([
      { key: 'refreshInterval', current: 3, proposed: 7 },
      { key: 'padding', current: null, proposed: 0 },
    ]);
    const noRefresh = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(noRefresh.proposed.refreshInterval).toBeUndefined();
  });

  it('sees its own identical statusLine as unchanged', () => {
    const { env, file } = tmpEnv();
    applyInstall(planInstall({ file, command: '/bin/ccinfobar', refresh: 5, env }), {
      confirmed: false,
      env,
    });
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(plan).toMatchObject({ owner: 'ours', changes: false, needsConfirm: false, diff: [] });
    expect(plan.proposed.refreshInterval).toBe(5);
  });

  it('asks for legacy-ask and inherits refresh for legacy-ours', () => {
    const { env, file } = tmpEnv();
    writeJson(file, { statusLine: { type: 'command', command: 'ccinfobar --x | tee /tmp/y' } });
    expect(planInstall({ file, command: '/bin/ccinfobar', env })).toMatchObject({
      owner: 'legacy-ask',
      needsConfirm: true,
    });
    writeJson(file, { statusLine: { type: 'command', command: 'ccinfobar', refreshInterval: 4 } });
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(plan).toMatchObject({ owner: 'legacy-ours', needsConfirm: false });
    expect(plan.proposed.refreshInterval).toBe(4);
  });

  it('writes nothing', () => {
    const { dir, env, file } = tmpEnv();
    writeJson(file, { statusLine: foreign });
    const before = snapshot(dir);
    planInstall({ file, command: '/bin/ccinfobar', env });
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('applyInstall', () => {
  it('refuses an unconfirmed foreign replacement without touching anything', () => {
    const { dir, env, file } = tmpEnv();
    writeJson(file, { statusLine: foreign });
    const before = snapshot(dir);
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(() => applyInstall(plan, { confirmed: false, env })).toThrow(InstallNeedsConfirmError);
    expect(snapshot(dir)).toEqual(before);
    expect(fs.existsSync(manifestFile(env))).toBe(false);
  });

  it('replaces when confirmed and records the manifest', () => {
    const { env, file } = tmpEnv();
    writeJson(file, { model: 'opus', statusLine: foreign });
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    const res = applyInstall(plan, { confirmed: true, env });
    expect(res.written).toEqual(plan.proposed);
    expect(res.replaced).toEqual(foreign);
    expect(res.changed).toBe(true);
    expect(res.backup && fs.existsSync(res.backup)).toBe(true);
    expect(read(file)).toEqual({ model: 'opus', statusLine: plan.proposed });
    const entry = findStatusLineEntry(readManifest(env), file);
    expect(entry?.value).toEqual(plan.proposed);
    expect(entry?.previous).toEqual(foreign);
  });

  it('refuses a stale plan when the statusLine changed after planning', () => {
    const { env, file } = tmpEnv();
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    writeJson(file, { statusLine: foreign });
    expect(() => applyInstall(plan, { confirmed: true, env })).toThrow(InstallNeedsConfirmError);
    expect(read(file).statusLine).toEqual(foreign);
  });

  it('adopts a legacy-ask statusLine with the legacy restore chain', () => {
    const { env, file } = tmpEnv();
    const prior = { type: 'command', command: 'npx ccstatusline' };
    writeJson(`${file}.ccinfobar-backup`, { statusLine: prior });
    writeJson(file, { statusLine: { type: 'command', command: '"/opt/x/ccinfobar" --flag' } });
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(plan.owner).toBe('legacy-ask');
    applyInstall(plan, { confirmed: true, adoptLegacy: true, env });
    const entry = findStatusLineEntry(readManifest(env), file);
    expect(entry?.previous).toEqual(prior);
    expect(entry?.restore).toBeNull();
    expect(entry?.fileExisted).toBe(true);

    const other = tmpEnv();
    const legacy = { type: 'command' as const, command: '"/opt/x/ccinfobar" --flag' };
    writeJson(other.file, { statusLine: legacy });
    applyInstall(planInstall({ file: other.file, command: '/bin/ccinfobar', env: other.env }), {
      confirmed: true,
      env: other.env,
    });
    expect(findStatusLineEntry(readManifest(other.env), other.file)?.previous).toEqual(legacy);
  });

  it('keeps install() as a confirmed wrapper', () => {
    const { file } = tmpEnv();
    writeJson(file, { statusLine: foreign });
    expect(install('/bin/ccinfobar', undefined, file)).not.toBeNull();
    expect(read(file).statusLine.command).toBe('/bin/ccinfobar');
    expect(install('/bin/ccinfobar', undefined, file)).toBeNull();
  });
});

describe('takeOverProjects', () => {
  it('applies confirmed installs and records each project', () => {
    const { dir, env } = tmpEnv();
    const roots = ['a', 'b'].map((n) => {
      const root = path.join(dir, n);
      writeJson(projectSettingsPath(root, false), {
        statusLine: { type: 'command', command: 'node .claude/hooks/gsd-statusline.js' },
      });
      return root;
    });
    writeJson(path.join(dir, 'claude', '.claude.json'), {
      projects: Object.fromEntries(roots.map((r) => [r, {}])),
    });
    expect(takeOverProjects('/bin/ccinfobar', 6, env)).toEqual(roots);
    const m = readManifest(env);
    for (const root of roots) {
      const entry = findStatusLineEntry(m, projectSettingsPath(root));
      expect(entry?.value).toEqual({
        type: 'command',
        command: '/bin/ccinfobar',
        padding: 0,
        refreshInterval: 6,
      });
      expect(entry?.restore).toEqual({ absent: true });
    }
  });
});
