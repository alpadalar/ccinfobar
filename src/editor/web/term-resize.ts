import { h } from './dom.js';
import { DEFAULT_WIDTH, S, setWidth } from './store.js';

export function colsFor(start: number, dx: number, colPx: number): number {
  if (!Number.isFinite(colPx) || colPx <= 0) return start;
  return Math.round(start + dx / colPx);
}

function measureCh(screen: HTMLElement): number {
  const probe = h('span', { class: 'term-probe', 'aria-hidden': 'true' }, '0'.repeat(20));
  screen.append(probe);
  const w = probe.getBoundingClientRect().width / 20;
  probe.remove();
  return w;
}

// pointer capture routes the drag to the handle
export function initTermResize(
  handle: HTMLElement,
  screen: HTMLElement,
  colPx: () => number = () => measureCh(screen),
): void {
  let drag: { x: number; start: number; px: number; pointer: number } | null = null;
  const end = () => {
    if (!drag) return;
    try {
      handle.releasePointerCapture?.(drag.pointer);
    } catch {}
    drag = null;
    document.body.classList.remove('resizing-term');
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, start: S.width, px: colPx(), pointer: e.pointerId };
    try {
      handle.setPointerCapture?.(e.pointerId);
    } catch {}
    document.body.classList.add('resizing-term');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (drag) setWidth(colsFor(drag.start, e.clientX - drag.x, drag.px));
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, end);
  handle.addEventListener('dblclick', () => setWidth(DEFAULT_WIDTH));
}
