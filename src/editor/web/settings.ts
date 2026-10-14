import { setBudget } from '../../core/edit.js';
import { t } from '../../core/i18n/index.js';
import { api } from './api.js';
import { clear, h } from './dom.js';
import { field, numberInput, segmented, textInput, toggle } from './inspector.js';
import { installDialog } from './install-dialog.js';
import { commit, S } from './store.js';
import { modal, toast } from './ui.js';

const KIND: Record<string, string> = {
  'npm-global': 'global npm install',
  local: 'pinned copy in your config folder',
  npx: 'running through npx',
  source: 'source checkout',
  unknown: 'unknown install',
};

function budgetInput(
  key: 'daily' | 'session' | 'warnAt',
  value: number | undefined,
  attrs: Record<string, unknown>,
  scale = 1,
): HTMLInputElement {
  return numberInput(
    value ?? '',
    (v) =>
      commit(setBudget(S.config, key, v === null ? undefined : v / scale), { coalesce: `budget.${key}` }),
    attrs,
  );
}

export async function openSettings(): Promise<void> {
  const body = h('div', { class: 'settings' });
  let info: Awaited<ReturnType<typeof api.system>> | null = null;
  let latest: { latest: string; newer: boolean } | null = null;
  let busy = false;

  const section = (title: string, ...children: (Node | null)[]) =>
    h('section', { class: 'section' }, h('h4', null, title), ...children);

  async function run(install: boolean) {
    busy = true;
    render();
    try {
      const r = await api.update(install);
      latest = { latest: r.latest, newer: r.newer && !r.installed };
      if (r.installed) toast(`Updated to ${r.installed}. Restart the editor to use it.`);
      else toast(r.newer ? `Version ${r.latest} is available` : `${r.current} is the latest version`, 'info');
      info = await api.system();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    busy = false;
    render();
  }

  async function runHooks(enabled: boolean, permission: boolean) {
    busy = true;
    render();
    try {
      const r = await api.hooks(enabled, permission);
      const on = r.hooks.installed;
      toast(enabled ? (on.length ? `Hooks on: ${on.join(', ')}` : 'No hooks were added') : 'Hooks removed');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    info = await api.system().catch(() => info);
    busy = false;
    render();
  }

  function hooksFields(): HTMLElement[] {
    const hk = info?.hooks ?? S.api.hooks;
    if (!hk) return [];
    const permission = hk.optional.some((e) => hk.installed.includes(e));
    const hint = `Optional. Records ${hk.events.join(', ')} so live widgets are exact; every widget also works without hooks. ${
      hk.available ? `Claude Code ${hk.claudeCode ?? ''}.` : (hk.reason ?? '')
    }`;
    const out = [
      field(
        'Hooks',
        toggle(hk.installed.length > 0, (v) => void runHooks(v, permission), undefined, {
          disabled: busy || (!hk.available && hk.installed.length === 0),
        }),
        hint,
        true,
      ),
    ];
    if (hk.available)
      out.push(
        field(
          'Permission requests',
          toggle(permission, (v) => void runHooks(true, v), undefined, { disabled: busy }),
          `Opt-in. Also records ${hk.optional.join(', ')} so a waiting permission prompt shows at once. Best left off on Windows without Git Bash.`,
          true,
        ),
      );
    return out;
  }

  function render() {
    clear(body);
    const c = S.config;
    const cl = info?.claude ?? S.api.claude;
    const set = (p: Partial<typeof c>) => {
      commit({ ...S.config, ...p });
      render();
    };
    const canUpdate = info?.kind === 'npm-global' || info?.kind === 'local';
    const checked = info?.update?.checkedAt
      ? `last checked ${new Date(info.update.checkedAt).toLocaleString()}`
      : 'not checked yet';
    body.append(
      section(
        'Claude Code',
        h(
          'div',
          { class: `status-line ${cl.installed ? 'ok' : 'off'}` },
          h('i', { class: 'status-dot' }),
          h(
            'span',
            null,
            cl.installed ? 'Claude Code uses ccinfobar.' : 'Claude Code does not use ccinfobar yet.',
          ),
        ),
        h(
          'div',
          { class: 'hint' },
          cl.installed
            ? `Command: ${cl.statusLine?.command ?? ''}${cl.statusLine?.refreshInterval ? `, refresh every ${cl.statusLine.refreshInterval}s` : ''}. Saving is enough; Claude Code picks up changes on its next refresh.`
            : 'Install once; after that, saving is enough.',
        ),
        h(
          'div',
          { class: 'row-inline' },
          h(
            'button',
            {
              class: `btn${cl.installed ? '' : ' primary'}`,
              type: 'button',
              onClick: async () => {
                await installDialog();
                info = await api.system().catch(() => info);
                render();
              },
            },
            cl.installed ? 'Change command or refresh' : 'Install in Claude Code',
          ),
        ),
        ...hooksFields(),
      ),
      section(
        'Updates',
        field(
          'When a new version is out',
          segmented(
            [
              {
                value: 'auto',
                label: 'Install automatically',
                title: 'Default. Checks each time Claude Code starts and installs in the background',
              },
              { value: 'notify', label: 'Tell me', title: 'Shows a note at the end of the status line' },
              { value: 'off', label: 'Off', title: 'Never checks' },
            ] as const,
            c.update,
            (v) => set({ update: v }),
          ),
          'Automatic is the default. Save to apply.',
        ),
        h(
          'div',
          { class: 'hint' },
          `This is ccinfobar ${info?.version ?? S.api.version}, ${KIND[info?.kind ?? 'unknown'] ?? info?.kind}; ${checked}.`,
          latest ? ` Latest: ${latest.latest}.` : '',
        ),
        h(
          'div',
          { class: 'row-inline' },
          h(
            'button',
            { class: 'btn', type: 'button', disabled: busy, onClick: () => void run(false) },
            'Check now',
          ),
          latest?.newer && canUpdate
            ? h(
                'button',
                { class: 'btn primary', type: 'button', disabled: busy, onClick: () => void run(true) },
                `Update to ${latest.latest}`,
              )
            : null,
        ),
      ),
      section(
        'Appearance',
        field(
          'Loading text',
          textInput(
            c.loadingText ?? t('loading.default'),
            (v) => {
              const { loadingText: _, ...rest } = S.config;
              const text = v.slice(0, 40);
              commit(text === t('loading.default') ? rest : { ...rest, loadingText: text }, {
                coalesce: 'loadingText',
              });
            },
            { maxLength: 40 },
          ),
          'Shown by context, token and limit widgets before the first reply. Leave empty to turn it off.',
        ),
      ),
      section(
        'Data',
        field(
          'Usage from Claude',
          toggle(c.usageApi, (v) => set({ usageApi: v })),
          'Fill usage limit widgets from your Claude login when Claude Code sends none.',
          true,
        ),
        field(
          'Git hardening',
          toggle(c.gitHardening !== false, (v) => set({ gitHardening: v ? undefined : false })),
          'Stop repos from running their own git hooks and filters through the status line.',
          true,
        ),
        field(
          'Save last payload',
          toggle(c.savePayload, (v) => set({ savePayload: v })),
          'Lets the preview use your real last session.',
          true,
        ),
      ),
      section(
        'Budget',
        field(
          'Daily budget (USD)',
          budgetInput('daily', c.budget?.daily, { min: 0, step: 'any', placeholder: 'none' }),
          'Estimated spend for the budget widget. Not your bill.',
        ),
        field(
          'Per session (USD)',
          budgetInput('session', c.budget?.session, { min: 0, step: 'any', placeholder: 'none' }),
        ),
        field(
          'Warn at (%)',
          budgetInput(
            'warnAt',
            c.budget?.warnAt === undefined ? undefined : Math.round(c.budget.warnAt * 100),
            { min: 5, max: 100, step: 1, placeholder: '80' },
            100,
          ),
          'The budget widget turns yellow here and red at 100%.',
        ),
      ),
    );
  }

  render();
  void api
    .system()
    .then((r) => {
      info = r;
      render();
    })
    .catch(() => {});
  await modal({
    title: 'Settings',
    body: [body],
    actions: (close) => [
      h('button', { class: 'btn primary', type: 'button', onClick: () => close() }, 'Done'),
    ],
  });
}
