import { type MessageId, t } from '../../core/i18n/index.js';
import { h, icon } from './dom.js';

export const TIP_MS = 6000;
export const TIPS_KEY = 'ccinfobar.tipsHidden';

export const TIPS: readonly MessageId[] = [
  'web.tips.doubleClick',
  'web.tips.copyPaste',
  'web.tips.styleCopy',
  'web.tips.move',
  'web.tips.resize',
  'web.tips.undo',
  'web.tips.save',
];

function modKey(): string {
  try {
    return /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
  } catch {
    return 'Ctrl';
  }
}

function stored(): boolean {
  try {
    return localStorage.getItem(TIPS_KEY) === '1';
  } catch {
    return false;
  }
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// returns a relabel function for language changes
export function initTips(host: HTMLElement): () => void {
  let at = 0;
  let timer: number | undefined;
  let hover = false;
  let focus = false;
  let hidden = stored();
  const label = h('span', { class: 'tip-label' });
  const text = h('span', { class: 'tip-text' });
  const next = h(
    'button',
    { type: 'button', class: 'icon-btn sm', onClick: () => show(at + 1) },
    icon('chevron', 14),
  );
  const dismiss = h('button', { type: 'button', class: 'icon-btn sm', onClick: hide }, icon('x', 14));
  host.setAttribute('role', 'note');
  host.replaceChildren(icon('info', 14), label, text, next, dismiss);

  function schedule(): void {
    clearTimeout(timer);
    timer = undefined;
    if (hidden || hover || focus || reducedMotion()) return;
    timer = window.setTimeout(() => show(at + 1), TIP_MS);
  }
  function show(n: number): void {
    at = (n + TIPS.length) % TIPS.length;
    text.textContent = t(TIPS[at]!, { mod: modKey() });
    text.classList.remove('tip-in');
    void text.offsetWidth;
    text.classList.add('tip-in');
    schedule();
  }
  function hide(): void {
    hidden = true;
    host.hidden = true;
    schedule();
    try {
      localStorage.setItem(TIPS_KEY, '1');
    } catch {}
  }
  function relabel(): void {
    label.textContent = t('web.tips.label');
    for (const [b, id] of [
      [next, 'web.tips.next'],
      [dismiss, 'web.tips.dismiss'],
    ] as const) {
      b.title = t(id);
      b.setAttribute('aria-label', t(id));
    }
    text.textContent = t(TIPS[at]!, { mod: modKey() });
  }
  const watch = (on: string, off: string, set: (v: boolean) => void) => {
    host.addEventListener(on, () => {
      set(true);
      schedule();
    });
    host.addEventListener(off, () => {
      set(false);
      schedule();
    });
  };
  watch('pointerenter', 'pointerleave', (v) => {
    hover = v;
  });
  watch('focusin', 'focusout', (v) => {
    focus = v;
  });

  host.hidden = hidden;
  relabel();
  if (!hidden) show(0);
  return relabel;
}
