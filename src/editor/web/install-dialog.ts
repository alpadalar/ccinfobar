import { t } from '../../core/i18n/index.js';
import { ApiError, api, type InstallPlanInfo } from './api.js';
import { clear, h } from './dom.js';
import { emit, isDirty, S } from './store.js';
import { modal, toast } from './ui.js';

export async function installDialog(opts: { refresh?: number } = {}): Promise<void> {
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
    placeholder: t('web.install.off'),
    value: opts.refresh
      ? String(opts.refresh)
      : claude.statusLine?.refreshInterval
        ? String(claude.statusLine.refreshInterval)
        : '',
  });
  const sub = h('input', { type: 'checkbox' });
  sub.checked = claude.subagent?.owned === true;
  const preview = h('pre', { class: 'code-preview' });
  const update = () => {
    const sl: Record<string, unknown> = { type: 'command', command: cmd.value, padding: 0 };
    if (Number(refresh.value) > 0) sl.refreshInterval = Math.floor(Number(refresh.value));
    const out: Record<string, unknown> = { statusLine: sl };
    if (sub.checked) out.subagentStatusLine = { type: 'command', command: `${cmd.value} subagent-line` };
    preview.textContent = JSON.stringify(out, null, 2);
  };
  cmd.addEventListener('input', update);
  refresh.addEventListener('input', update);
  sub.addEventListener('change', update);
  update();
  const current = claude.statusLine?.command;
  const planBox = h('div', { class: 'install-plan', hidden: true });
  const refreshValue = () => (Number(refresh.value) > 0 ? Number(refresh.value) : undefined);
  await modal({
    title: t('web.install.title'),
    body: [
      h(
        'div',
        { class: `status-line ${claude.installed ? 'ok' : 'off'}` },
        h('i', { class: 'status-dot' }),
        h(
          'span',
          null,
          claude.installed
            ? t('web.install.active')
            : current
              ? t('web.install.current', { command: current })
              : t('web.install.none'),
        ),
      ),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, t('web.install.command')), cmd),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, t('web.install.refresh')), refresh),
      h('label', { class: 'field row-inline' }, sub, h('span', null, t('web.install.subagents'))),
      h('div', { class: 'field-label' }, t('web.install.writesTo', { file: claude.settingsFile })),
      preview,
      planBox,
      isDirty() ? h('div', { class: 'hint warn' }, t('web.install.unsaved')) : null,
    ],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, t('web.ui.cancel')),
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
              toast(t('web.install.failed', { error: (e as Error).message }), 'error');
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
                ...subagentPlan(plan),
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
                          done(
                            await api.install(
                              plan.proposed.command,
                              refreshValue(),
                              true,
                              plan.current,
                              sub.checked,
                            ),
                          );
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
              const { plan } = await api.installPlan(cmd.value.trim(), refreshValue(), sub.checked);
              if (plan.needsConfirm) showPlan(plan);
              else
                done(await api.install(cmd.value.trim(), refreshValue(), undefined, undefined, sub.checked));
            } catch (e) {
              failed(e);
            }
          },
        },
        claude.installed ? t('web.install.update') : t('web.install.install'),
      ),
    ],
  });
}

function subagentPlan(plan: InstallPlanInfo): ReturnType<typeof h>[] {
  const sub = plan.subagent;
  if (!sub) return [];
  const params = { command: sub.proposed.command, from: commandText(subagentCurrent(sub.current)) };
  const id = !sub.changes
    ? 'install.dry.subagentKeep'
    : sub.owner === 'none'
      ? 'install.dry.subagentAdd'
      : sub.owner === 'ours'
        ? 'install.dry.subagentRewrite'
        : 'install.dry.subagentReplace';
  return [h('div', { class: 'hint' }, t(id, params))];
}

function subagentCurrent(v: unknown): unknown {
  return v && typeof v === 'object' ? (v as { command?: unknown }).command : v;
}

function isPlan(v: unknown): v is InstallPlanInfo {
  const p = v as InstallPlanInfo | null;
  return !!p && typeof p === 'object' && typeof p.proposed?.command === 'string';
}

function commandText(c: unknown): string {
  if (typeof c === 'string') return c;
  return c === undefined ? t('install.unset') : JSON.stringify(c);
}
