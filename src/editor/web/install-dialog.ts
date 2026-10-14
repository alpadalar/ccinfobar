import { t } from '../../core/i18n/index.js';
import { ApiError, api, type InstallPlanInfo } from './api.js';
import { clear, h } from './dom.js';
import { emit, isDirty, S } from './store.js';
import { modal, toast } from './ui.js';

export async function installDialog(): Promise<void> {
  const claude = S.api.claude;
  const cmd = h('input', {
    class: 'input mono',
    type: 'text',
    value: claude.statusLine?.command && claude.installed ? claude.statusLine.command : claude.defaultCommand,
    spellcheck: false,
  });
  const refresh = h('input', {
    class: 'input num',
    type: 'number',
    min: '0',
    step: '1',
    placeholder: 'off',
    value: claude.statusLine?.refreshInterval ? String(claude.statusLine.refreshInterval) : '',
  });
  const preview = h('pre', { class: 'code-preview' });
  const update = () => {
    const sl: Record<string, unknown> = { type: 'command', command: cmd.value, padding: 0 };
    if (Number(refresh.value) > 0) sl.refreshInterval = Math.floor(Number(refresh.value));
    preview.textContent = JSON.stringify({ statusLine: sl }, null, 2);
  };
  cmd.addEventListener('input', update);
  refresh.addEventListener('input', update);
  update();
  const current = claude.statusLine?.command;
  const planBox = h('div', { class: 'install-plan', hidden: true });
  const refreshValue = () => (Number(refresh.value) > 0 ? Number(refresh.value) : undefined);
  await modal({
    title: 'Install in Claude Code',
    body: [
      h(
        'div',
        { class: `status-line ${claude.installed ? 'ok' : 'off'}` },
        h('i', { class: 'status-dot' }),
        h(
          'span',
          null,
          claude.installed
            ? 'ccinfobar is the active status line.'
            : current
              ? `Current status line: ${current}`
              : 'No status line is configured yet.',
        ),
      ),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Command'), cmd),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field-label' }, 'Refresh interval (seconds, optional)'),
        refresh,
      ),
      h('div', { class: 'field-label' }, `Will be written to ${claude.settingsFile}`),
      preview,
      planBox,
      isDirty()
        ? h('div', { class: 'hint warn' }, 'You have unsaved changes. Save them so Claude Code uses them.')
        : null,
    ],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: async () => {
            const done = (r: { backupsDir: string; claude: typeof claude }) => {
              S.api.claude = r.claude;
              emit('ui');
              emit('config');
              close();
              toast(t('editor.installed', { dir: r.backupsDir }));
            };
            const failed = (e: unknown) => {
              if (e instanceof ApiError && e.status === 409 && isPlan(e.data?.plan)) {
                showPlan(e.data.plan);
                return;
              }
              toast(`Install failed: ${(e as Error).message}`, 'error');
            };
            const showPlan = (plan: InstallPlanInfo) => {
              clear(planBox);
              planBox.hidden = false;
              planBox.append(
                h('div', { class: 'hint warn' }, t('install.needsConfirm')),
                h('div', { class: 'field-label' }, t('editor.planCurrent')),
                h('pre', { class: 'code-preview' }, commandText(plan.current?.command)),
                h('div', { class: 'field-label' }, t('editor.planProposed')),
                h('pre', { class: 'code-preview' }, plan.proposed.command),
                h(
                  'div',
                  { class: 'modal-foot' },
                  h(
                    'button',
                    { class: 'btn', type: 'button', onClick: () => (planBox.hidden = true) },
                    t('editor.planCancel'),
                  ),
                  h(
                    'button',
                    {
                      class: 'btn primary',
                      type: 'button',
                      onClick: async () => {
                        try {
                          done(await api.install(plan.proposed.command, refreshValue(), true, plan.current));
                        } catch (e) {
                          failed(e);
                        }
                      },
                    },
                    t('editor.planReplace'),
                  ),
                ),
              );
            };
            try {
              const { plan } = await api.installPlan(cmd.value.trim(), refreshValue());
              if (plan.needsConfirm) showPlan(plan);
              else done(await api.install(cmd.value.trim(), refreshValue()));
            } catch (e) {
              failed(e);
            }
          },
        },
        claude.installed ? 'Update' : 'Install',
      ),
    ],
  });
}

function isPlan(v: unknown): v is InstallPlanInfo {
  const p = v as InstallPlanInfo | null;
  return !!p && typeof p === 'object' && typeof p.proposed?.command === 'string';
}

function commandText(c: unknown): string {
  if (typeof c === 'string') return c;
  return c === undefined ? t('install.unset') : JSON.stringify(c);
}
