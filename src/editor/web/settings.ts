import { api } from './api.js';
import { clear, h } from './dom.js';
import { field, segmented, toggle } from './inspector.js';
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
