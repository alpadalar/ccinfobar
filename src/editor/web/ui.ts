import { type Child, h, icon } from './dom.js';

export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'ok'): void {
  const host = document.getElementById('toasts')!;
  const el = h(
    'div',
    { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info', 16),
    h('span', null, message),
  );
  host.append(el);
  const ms = kind === 'error' ? 6000 : 3000;
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

export interface ModalOpts {
  title: string;
  body: Child[];
  actions: (close: (value?: unknown) => void) => Child[];
  wide?: boolean;
}

export function modal<T = unknown>(opts: ModalOpts): Promise<T | undefined> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const close = (value?: unknown) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.add('leaving');
      setTimeout(() => overlay.remove(), 140);
      previous?.focus?.();
      resolve(value as T | undefined);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const dialog = h(
      'div',
      {
        class: `modal${opts.wide ? ' wide' : ''}`,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': opts.title,
      },
      h(
        'header',
        { class: 'modal-head' },
        h('h2', null, opts.title),
        h('button', { class: 'icon-btn', type: 'button', title: 'Close', onClick: () => close() }, icon('x')),
      ),
      h('div', { class: 'modal-body' }, ...opts.body),
      h('footer', { class: 'modal-foot' }, ...opts.actions(close)),
    );
    const overlay = h('div', { class: 'overlay' }, dialog);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    const first =
      dialog.querySelector<HTMLElement>('textarea, input, select') ??
      dialog.querySelector<HTMLElement>('.btn.primary');
    first?.focus();
  });
}

export async function confirmDialog(
  title: string,
  message: string,
  confirmLabel = 'Continue',
): Promise<boolean> {
  const r = await modal<boolean>({
    title,
    body: [h('p', { class: 'modal-text' }, message)],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onClick: () => close(true) }, confirmLabel),
    ],
  });
  return r === true;
}
