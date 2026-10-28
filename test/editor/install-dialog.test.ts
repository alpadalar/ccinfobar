import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { FakeEl } from '../i18n/fake-dom.js';

const g = globalThis as any;
const saved = { document: g.document, HTMLElement: g.HTMLElement };

const modalCalls: { body: any[]; actions: (close: () => void) => any[] }[] = [];
const planCalls: unknown[][] = [];
const installCalls: unknown[][] = [];

vi.mock('../../src/editor/web/ui.js', () => ({
  modal: async (o: any) => {
    modalCalls.push(o);
  },
  toast: () => {},
}));

vi.mock('../../src/editor/web/api.js', () => ({
  ApiError: class extends Error {},
  api: {
    installPlan: async (...a: unknown[]) => {
      planCalls.push(a);
      return { plan: { needsConfirm: false } };
    },
    install: async (...a: unknown[]) => {
      installCalls.push(a);
      return { backupsDir: '/b', claude: claudeInfo() };
    },
  },
}));

const claudeInfo = (subagent: { command: string; owned: boolean } | null = null) => ({
  statusLine: { command: 'ccinfobar' },
  installed: true,
  defaultCommand: 'ccinfobar',
  settingsFile: '~/.claude/settings.json',
  subagent,
});

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.document = { createElement: (tag: string) => new FakeEl(tag.toUpperCase()) };
});

afterAll(() => {
  g.document = saved.document;
  g.HTMLElement = saved.HTMLElement;
});

beforeEach(() => {
  modalCalls.length = 0;
  planCalls.length = 0;
  installCalls.length = 0;
});

async function open(subagent: { command: string; owned: boolean } | null) {
  const { init } = await import('../../src/editor/web/store.js');
  const { installDialog } = await import('../../src/editor/web/install-dialog.js');
  const config = defaultConfig();
  init({ config, savedConfig: config, categories: [], widgets: [], claude: claudeInfo(subagent) } as any);
  await installDialog();
  const o = modalCalls[0]!;
  const root = new FakeEl('DIV');
  root.append(...o.body.filter(Boolean));
  const box = root.all((e) => e.type === 'checkbox')[0]!;
  const pre = root.all((e) => e.tagName === 'PRE')[0]!;
  const actions = new FakeEl('DIV');
  actions.append(...o.actions(() => {}));
  const install = actions.all((e) => e.className.includes('primary'))[0]!;
  return { root, box, pre, install };
}

describe('install dialog subagents checkbox', () => {
  it('is unchecked when we do not own the subagent line and the preview omits it', async () => {
    const t = await open(null);
    expect(t.box.checked).toBe(false);
    expect(t.root.textContent).toContain('Also render the subagent panel rows (--subagents)');
    expect(t.pre.textContent).not.toContain('subagentStatusLine');
  });

  it('is checked when owned and the preview shows subagentStatusLine', async () => {
    const t = await open({ command: 'ccinfobar subagent-line', owned: true });
    expect(t.box.checked).toBe(true);
    expect(t.pre.textContent).toContain('subagentStatusLine');
    expect(t.pre.textContent).toContain('ccinfobar subagent-line');
  });

  it('toggling updates the preview and the api calls carry the box state', async () => {
    const t = await open(null);
    t.box.checked = true;
    t.box.dispatch('change');
    expect(t.pre.textContent).toContain('subagentStatusLine');
    t.install.dispatch('click');
    await new Promise((r) => setTimeout(r, 0));
    expect(planCalls[0]![2]).toBe(true);
    expect(installCalls[0]![4]).toBe(true);
  });

  it('sends false when unchecked', async () => {
    const t = await open({ command: 'x subagent-line', owned: false });
    expect(t.box.checked).toBe(false);
    t.install.dispatch('click');
    await new Promise((r) => setTimeout(r, 0));
    expect(planCalls[0]![2]).toBe(false);
    expect(installCalls[0]![4]).toBe(false);
  });
});
