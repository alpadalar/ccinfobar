import { api } from './api.js';
import { h } from './dom.js';
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
      h('div', { class: 'field-label' }, 'Will be written to ~/.claude/settings.json'),
      preview,
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
            try {
              const r = await api.install(
                cmd.value.trim(),
                Number(refresh.value) > 0 ? Number(refresh.value) : undefined,
              );
              S.api.claude = r.claude;
              emit('ui');
              emit('config');
              close();
              toast(r.backup ? 'Installed. Settings backed up' : 'Installed in Claude Code');
            } catch (e) {
              toast(`Install failed: ${(e as Error).message}`, 'error');
            }
          },
        },
        claude.installed ? 'Update' : 'Install',
      ),
    ],
  });
}
