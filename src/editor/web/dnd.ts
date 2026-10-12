import { h } from './dom.js';

export type DragSpec =
  | { kind: 'palette'; type: string; label: string; color: string | null }
  | { kind: 'chip'; id: string; label: string; color: string | null }
  | { kind: 'row'; line: number; label: string };

export type DropTarget =
  | { kind: 'slot'; line: number; index: number }
  | { kind: 'newline' }
  | { kind: 'trash' }
  | { kind: 'rowslot'; slot: number };

export interface PressHandlers {
  click?(): void;
  drop(spec: DragSpec, target: DropTarget): void;
}

const THRESHOLD = 4;

function rectOf(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

function inside(r: DOMRect, x: number, y: number, pad = 0): boolean {
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#canvas .line')];
}

function nearestSlot(row: HTMLElement, x: number, y: number) {
  const chips = [...row.querySelectorAll<HTMLElement>('.chip')];
  const items = row.querySelector<HTMLElement>('.line-items')!;
  if (!chips.length) {
    const r = rectOf(items);
    return { index: 0, cx: r.left + 12, top: r.top + 8, height: r.height - 16 };
  }
  let best = 0;
  let bestD = Infinity;
  chips.forEach((c, i) => {
    const r = rectOf(c);
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dx * dx + dy * dy * 4;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  const r = rectOf(chips[best]!);
  const after = x > r.left + r.width / 2;
  const index = best + (after ? 1 : 0);
  return { index, cx: after ? r.right + 3 : r.left - 3, top: r.top, height: r.height };
}

interface Hit {
  target: DropTarget | null;
  caret?: { x: number; y: number; w: number; h: number; horizontal: boolean };
  row?: HTMLElement;
  hot?: HTMLElement;
}

function hitTest(spec: DragSpec, x: number, y: number): Hit {
  const rs = rows();
  if (spec.kind === 'row') {
    if (!rs.length) return { target: null };
    const canvas = document.getElementById('canvas')!;
    const cr = rectOf(canvas);
    let slot = rs.length;
    for (let i = 0; i < rs.length; i++) {
      const r = rectOf(rs[i]!);
      if (y < r.top + r.height / 2) {
        slot = i;
        break;
      }
    }
    const ref = slot < rs.length ? rectOf(rs[slot]!) : rectOf(rs[rs.length - 1]!);
    const yy = slot < rs.length ? ref.top - 5 : ref.bottom + 5;
    return {
      target: { kind: 'rowslot', slot },
      caret: { x: cr.left, y: yy - 1, w: cr.width, h: 3, horizontal: true },
    };
  }
  const trash = document.getElementById('trash');
  if (spec.kind === 'chip' && trash && inside(rectOf(trash), x, y, 6)) {
    return { target: { kind: 'trash' }, hot: trash };
  }
  const add = document.getElementById('add-line');
  if (add && inside(rectOf(add), x, y, 8)) return { target: { kind: 'newline' }, hot: add };
  let row: HTMLElement | null = null;
  const canvas = document.getElementById('canvas');
  if (!canvas) return { target: null };
  const cr = rectOf(canvas);
  if (!inside(cr, x, y, 8)) return { target: null };
  for (const r of rs) if (inside(rectOf(r), x, y)) row = r;
  if (!row) {
    let bestD = Infinity;
    for (const r of rs) {
      const rr = rectOf(r);
      const d = y < rr.top ? rr.top - y : y > rr.bottom ? y - rr.bottom : 0;
      if (d < bestD) {
        bestD = d;
        row = r;
      }
    }
  }
  if (!row) return { target: null };
  const line = Number(row.dataset.line);
  const s = nearestSlot(row, x, y);
  return {
    target: { kind: 'slot', line, index: s.index },
    caret: { x: s.cx - 1, y: s.top - 2, w: 3, h: s.height + 4, horizontal: false },
    row,
  };
}

export function press(ev: PointerEvent, spec: DragSpec, handlers: PressHandlers): void {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const el = ev.currentTarget as HTMLElement;
  const startX = ev.clientX;
  const startY = ev.clientY;
  const pointerId = ev.pointerId;
  let active = false;
  let ghost: HTMLElement | null = null;
  let caret: HTMLElement | null = null;
  let hit: Hit = { target: null };
  let offX = 0;
  let offY = 0;
  let marked: HTMLElement[] = [];

  try {
    el.setPointerCapture(pointerId);
  } catch {}

  function activate() {
    active = true;
    const r = rectOf(el);
    offX = Math.min(startX - r.left, 80);
    offY = Math.min(startY - r.top, 20);
    ghost = h('div', { class: 'drag-ghost' });
    if (spec.kind !== 'row') {
      const c = 'color' in spec ? spec.color : null;
      ghost.append(h('i', { class: 'dot', style: c ? `--c:${c}` : '' }), h('span', null, spec.label));
    } else ghost.append(h('span', null, spec.label));
    caret = h('div', { class: 'caret' });
    document.body.append(ghost, caret);
    document.body.classList.add('dragging', `dragging-${spec.kind}`);
    el.classList.add('is-dragging');
  }

  function clearMarks() {
    for (const m of marked) m.classList.remove('drop-target', 'hot');
    marked = [];
  }

  function move(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    if (!active) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
      activate();
    }
    e.preventDefault();
    ghost!.style.transform = `translate(${e.clientX - offX}px, ${e.clientY - offY}px)`;
    hit = hitTest(spec, e.clientX, e.clientY);
    clearMarks();
    if (hit.row) {
      hit.row.classList.add('drop-target');
      marked.push(hit.row);
    }
    if (hit.hot) {
      hit.hot.classList.add('hot');
      marked.push(hit.hot);
    }
    if (hit.caret) {
      const c = hit.caret;
      caret!.style.cssText = `display:block;left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px`;
      caret!.classList.toggle('horizontal', c.horizontal);
    } else caret!.style.display = 'none';
  }

  function cleanup() {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    try {
      el.releasePointerCapture(pointerId);
    } catch {}
    clearMarks();
    ghost?.remove();
    caret?.remove();
    document.body.classList.remove('dragging', 'dragging-palette', 'dragging-chip', 'dragging-row');
    el.classList.remove('is-dragging');
  }

  function up(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    const wasActive = active;
    const target = hit.target;
    cleanup();
    if (!wasActive) handlers.click?.();
    else if (target) handlers.drop(spec, target);
  }

  function cancel() {
    cleanup();
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cleanup();
    }
  }

  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
}
