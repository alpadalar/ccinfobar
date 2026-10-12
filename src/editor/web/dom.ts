export type Child = Node | string | number | null | false | undefined;
type Props = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  let value: unknown;
  let hasValue = false;
  for (const [key, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (key.startsWith('on') && typeof v === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), v as EventListener);
    } else if (key === 'class') el.className = String(v);
    else if (key === 'style') el.setAttribute('style', String(v));
    else if (key === 'value') {
      value = v;
      hasValue = true;
    } else if (v === true) el.setAttribute(key, '');
    else if (key in el && !key.startsWith('aria-') && !key.startsWith('data-')) {
      (el as unknown as Record<string, unknown>)[key] = v;
    } else el.setAttribute(key, String(v));
  }
  append(el, children);
  if (hasValue) (el as unknown as { value: unknown }).value = value;
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === false || c === undefined) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

export function clear(el: Element): void {
  el.replaceChildren();
}

const PATHS: Record<string, string> = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  download: '<path d="M12 4v12m0 0-4-4m4 4 4-4M4 20h16"/>',
  upload: '<path d="M12 16V4m0 0-4 4m4-4 4 4M4 20h16"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  save: '<path d="M5 3h11l4 4v14H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
  terminal: '<path d="m4 7 5 5-5 5M12 18h8"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  alert: '<path d="M12 4 2.5 20h19zM12 10v4M12 17v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
  palette:
    '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="10" r="1"/><path d="M12 21a2.5 2.5 0 0 1 0-5h1.5a2 2 0 0 0 2-2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  paste:
    '<path d="M9 4h6v3H9z"/><path d="M15 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
  brush:
    '<path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8l-2.9-2.9z"/><path d="M9.1 11.9c-2.1 0-4.1 1.6-4.1 4.1 0 1.5-1 2.5-2.5 3 1 1.4 2.7 2 4.5 2 3 0 5-2.2 5-5z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  'align-left': '<path d="M4 6h16M4 12h10M4 18h13"/>',
  'align-center': '<path d="M4 6h16M7 12h10M5.5 18h13"/>',
  'align-right': '<path d="M4 6h16M10 12h10M7 18h13"/>',
};

export function icon(name: keyof typeof PATHS | string, size = 16): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'icon';
  const fill = name === 'grip' ? 'currentColor' : 'none';
  span.innerHTML = `<svg style="width:${size / 16}rem;height:${size / 16}rem" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;
  return span;
}
