import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { render } from '../../src/core/renderer.js';
import type { StatusPayload, WidgetItem } from '../../src/core/types.js';
import { renderWidget, withoutSideEffects } from '../helpers.js';

const tmpRepo = fs.existsSync(path.join(os.tmpdir(), '.git'));
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ws-')));
  env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function repo(root: string, name: string, head: string): void {
  fs.mkdirSync(path.join(root, name, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, name, '.git', 'HEAD'), head);
}

function workspace(): string {
  const w = path.join(dir, 'w');
  repo(w, 'api', 'ref: refs/heads/main\n');
  repo(w, 'web', 'ref: refs/heads/dev\n');
  fs.mkdirSync(path.join(w, 'notes'));
  repo(path.join(w, 'node_modules'), 'x', 'ref: refs/heads/main\n');
  return w;
}

function ctxAt(cwd: string, item: Partial<WidgetItem> = {}) {
  const payload: StatusPayload = { workspace: { current_dir: cwd } } as StatusPayload;
  return createContext({
    payload,
    config: { ...defaultConfig(), colorLevel: 0, lines: [[{ id: 'r', type: 'workspace-repos', ...item }]] },
    env,
    preview: false,
  });
}

describe.skipIf(tmpRepo)('workspace-repos on a real folder', () => {
  it('lists child repos with branches', () => {
    const lines = render(ctxAt(workspace())).map(stripAnsi);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('repos: api (main) · web (dev)');
    expect(lines[0]).not.toContain('notes');
    expect(lines[0]).not.toContain('node_modules');
  });

  it('never spawns', () => {
    const w = workspace();
    expect(() => withoutSideEffects(() => render(ctxAt(w)))).not.toThrow();
  });

  it('is null inside a repo', () => {
    const w = path.join(dir, 'w');
    fs.mkdirSync(path.join(w, '.git'), { recursive: true });
    repo(path.join(w, 'inner'), 'api', 'ref: refs/heads/main\n');
    expect(renderWidget('workspace-repos', ctxAt(path.join(w, 'inner')))).toBeNull();
  });

  it('is null without child repos', () => {
    const e = path.join(dir, 'empty');
    fs.mkdirSync(e);
    expect(renderWidget('workspace-repos', ctxAt(e))).toBeNull();
  });
});
