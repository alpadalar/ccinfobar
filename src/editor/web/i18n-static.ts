import { en } from '../../core/i18n/en/index.js';
import { language, type MessageId, t } from '../../core/i18n/index.js';

const ATTRS = ['title', 'placeholder', 'aria-label'] as const;

function text(key: string | null): string | null {
  return key && Object.hasOwn(en, key) ? t(key as MessageId) : null;
}

export function applyStatic(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const v = text(el.getAttribute('data-i18n'));
    if (v !== null) el.textContent = v;
  }
  for (const a of ATTRS) {
    for (const el of root.querySelectorAll<HTMLElement>(`[data-i18n-${a}]`)) {
      const v = text(el.getAttribute(`data-i18n-${a}`));
      if (v !== null) el.setAttribute(a, v);
    }
  }
  document.documentElement.lang = language();
}
