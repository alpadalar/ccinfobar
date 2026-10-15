import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { render, renderPart } from '../../src/core/renderer.js';
import { sampleGit, samplePayload } from '../../src/core/sample.js';
import type { RenderContext, StatusPayload, WidgetItem } from '../../src/core/types.js';
import { findUp } from '../../src/data/repos.js';
import { ctxWith, NOW, withoutSideEffects } from '../helpers.js';

const tmpRepo = findUp(os.tmpdir(), '.git', 'any') !== null;
let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-vis-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const text = (t: string, extra: Partial<WidgetItem> = {}): WidgetItem => ({
  id: t,
  type: 'text',
  options: { text: t },
  ...extra,
});

const atPct = (pct: number): StatusPayload => {
  const p = samplePayload(NOW.getTime());
  p.context_window!.used_percentage = pct;
  delete p.context_window!.current_usage;
  return p;
};

const lineOf = (ctx: RenderContext, lines: WidgetItem[][]): string =>
  render({ ...ctx, config: { ...ctx.config, lines } })
    .map(stripAnsi)
    .join('\n');

describe('rule gate', () => {
  it.skipIf(tmpRepo)('hides a widget outside a repo with no placeholder', () => {
    const ctx = { ...ctxWith({ width: 200 }), cwd: dir };
    const item: WidgetItem = { id: 'b', type: 'git-branch', hideWhen: '!git' };
    expect(renderPart(ctx, item)).toBeNull();
    const out = lineOf(ctx, [[text('left'), item, text('right')]]);
    expect(out).toContain('left');
    expect(out).toContain('right');
    expect(out).not.toContain('—');
  });

  it('shows by context percent', () => {
    const item = text('HOT', { showWhen: 'context.pct >= 70' });
    expect(renderPart(ctxWith({ payload: atPct(42) }), item)).toBeNull();
    expect(renderPart(ctxWith({ payload: atPct(72) }), item)?.text).toContain('HOT');
    expect(renderPart(ctxWith({ payload: atPct(69.6) }), item)?.text).toContain('HOT');
  });

  it('hideEmpty false does not bring back a hidden widget', () => {
    const item: WidgetItem = { id: 'g', type: 'git-branch', hideEmpty: false, showWhen: 'context.pct >= 70' };
    const ctx = ctxWith({ payload: atPct(42), git: () => null });
    expect(renderPart(ctx, item)).toBeNull();
    expect(renderPart(ctx, { ...item, showWhen: undefined })?.empty).toBe(true);
  });

  it('a hidden widget does no IO of its own', () => {
    const git = vi.fn(sampleGit);
    const ctx = ctxWith({ payload: atPct(42), git });
    expect(renderPart(ctx, { id: 'g', type: 'git-branch', showWhen: 'context.pct >= 70' })).toBeNull();
    expect(git).not.toHaveBeenCalled();
  });

  it('fails open on an invalid rule', () => {
    const ctx = ctxWith({});
    expect(renderPart(ctx, text('typo', { showWhen: 'contxt.pct > 5' }))?.text).toContain('typo');
    expect(renderPart(ctx, text('bad', { hideWhen: 'git >>' }))?.text).toContain('bad');
  });

  it('skips rule-hidden items in the panel style', () => {
    const lines = [[text('alpha'), text('beta', { showWhen: 'context.pct >= 70' })], [text('gamma')]];
    const config = { theme: 'panel', widthOffset: 0, lines };
    const low = render(ctxWith({ width: 40, payload: atPct(42), config }))
      .map(stripAnsi)
      .join('\n');
    const high = render(ctxWith({ width: 40, payload: atPct(80), config }))
      .map(stripAnsi)
      .join('\n');
    expect(ctxWith({ config }).config.theme).toBe('panel');
    expect(low).toContain('alpha');
    expect(low).not.toContain('beta');
    expect(high).toContain('beta');
  });

  it("panel style resolves to 'tui'", async () => {
    const { resolveAppearance } = await import('../../src/core/renderer.js');
    const ctx = ctxWith({ config: { theme: 'panel' } });
    expect(resolveAppearance(ctx.config, ctx.theme, ctx.env).style).toBe('tui');
  });

  it('rule-free items read no data', () => {
    const boom = () => {
      throw new Error('boom');
    };
    const ctx = ctxWith({ git: boom, agents: boom });
    const before = renderPart(ctxWith({}), { id: 'm', type: 'model' });
    expect(renderPart(ctx, { id: 'm', type: 'model' })).toEqual(before);
  });
});

describe('D-39 no spawn for git presence', () => {
  it('renders the default layout plus a git rule without new git calls', () => {
    const cfg = defaultConfig();
    const p = samplePayload(NOW.getTime());
    p.cwd = dir;
    p.workspace = { ...p.workspace!, current_dir: dir, project_dir: dir };
    p.session_id = 'vis-test';
    const env = {
      CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
      CCINFOBAR_CONFIG_DIR: dir,
      CLAUDE_CONFIG_DIR: dir,
    };
    const run = (lines: WidgetItem[][]) => {
      const git = vi.fn(sampleGit);
      const ctx = createContext({
        payload: p,
        config: { ...cfg, colorLevel: 0, lines },
        env,
        now: NOW,
        preview: false,
        data: { git },
      });
      const out = withoutSideEffects(() => render(ctx));
      return { out, calls: git.mock.calls.length };
    };
    const base = run(cfg.lines);
    const ruled = run([
      ...cfg.lines,
      [{ id: 'r', type: 'model', showWhen: 'git' }, text('x', { hideWhen: 'gsd' })],
    ]);
    expect(ruled.out.length).toBeGreaterThan(0);
    expect(ruled.calls).toBe(base.calls);
  });

  it('a rule-only layout never calls the git source', () => {
    const git = vi.fn(() => {
      throw new Error('spawned');
    });
    const ctx = { ...ctxWith({ git, config: { lines: [[text('x', { showWhen: 'git' })]] } }), cwd: dir };
    withoutSideEffects(() => render(ctx));
    expect(git).not.toHaveBeenCalled();
  });
});
