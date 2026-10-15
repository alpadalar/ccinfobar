import { compareIds } from '../../core/i18n/format.js';
import { t } from '../../core/i18n/index.js';
import type { Config, TuiBreakpoint, TuiConfig } from '../../core/types.js';
import { api } from './api.js';
import { h } from './dom.js';
import { field, fieldWithReset, numberInput, resetLink, segmented, textInput, toggle } from './inspector.js';
import { commit, S } from './store.js';

const BOXES: Record<string, string> = {
  rounded: '╭╮╰╯─│',
  square: '┌┐└┘─│',
  heavy: '┏┓┗┛━┃',
  double: '╔╗╚╝═║',
  dashed: '╭╮╰╯┄┊',
  'heavy-dashed': '┏┓┗┛┅┇',
  mixed: '┍┑┕┙━│',
  ascii: '++++-|',
  invisible: '      ',
};

function sample(id: string): string {
  const [tl, tr, bl, br, hz, vt] = [...BOXES[id]!];
  return `${tl}${hz}${hz}${hz}${tr}\n${vt}   ${vt}\n${bl}${hz}${hz}${hz}${br}`;
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? value : undefined;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = prune(v);
      if (p !== undefined && p !== '') out[k] = p;
      else if (v === false) out[k] = false;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value === '' ? undefined : value;
}

// key order does not matter
function stable(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => compareIds(a, b)))
      : v,
  );
}

let validateTimer: number | undefined;

function validate(): void {
  clearTimeout(validateTimer);
  validateTimer = window.setTimeout(async () => {
    const note = document.getElementById('tui-note');
    if (!note) return;
    try {
      const { config } = await api.normalize(S.config);
      const sent = stable(S.config.tui);
      const got = stable(config.tui);
      note.textContent = sent === got ? '' : t('pinsp.adjusted');
      note.classList.toggle('on', sent !== got);
    } catch (e) {
      note.textContent = (e as Error).message;
      note.classList.add('on');
    }
  }, 250);
}

function setTui(patch: Partial<Record<keyof TuiConfig, unknown>>, coalesce?: string): void {
  const next = { ...(S.config.tui ?? {}), ...patch } as Record<string, unknown>;
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const tui = prune(next) as TuiConfig | undefined;
  const cfg = { ...S.config } as Record<string, unknown>;
  if (tui) cfg.tui = tui;
  else delete cfg.tui;
  commit(cfg as unknown as Config, coalesce ? { coalesce, inspector: false } : {});
  validate();
}

function pair<K extends 'title' | 'footer'>(
  key: K,
  side: 'left' | 'right',
  value: string | false | undefined,
) {
  const cur = { ...(S.config.tui?.[key] as Record<string, unknown> | undefined) };
  if (value === undefined || value === '') delete cur[side];
  else cur[side] = value;
  return Object.keys(cur).length ? cur : undefined;
}

function tokens(): string {
  const types = new Set<string>();
  const ids = new Set<string>();
  for (const line of S.config.lines) {
    for (const it of line) {
      types.add(it.type);
      ids.add(it.id);
    }
  }
  const all = [...new Set([...types, ...ids])].slice(0, 24);
  return all.length ? all.map((x) => `{${x}}`).join(' ') : t('pinsp.noWidgets');
}

function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function breakpointEditor(bp: TuiBreakpoint, index: number, all: TuiBreakpoint[]): HTMLElement {
  const update = (patch: Partial<TuiBreakpoint>, coalesce?: string) => {
    const current = S.config.tui?.breakpoints ?? all;
    const next = current.map((b, i) => (i === index ? { ...b, ...patch } : b));
    setTui({ breakpoints: next }, coalesce ? `bp${index}:${coalesce}` : undefined);
  };
  const areas = h('textarea', {
    class: 'input mono areas',
    rows: Math.max(3, bp.areas.length + 1),
    spellcheck: false,
    value: bp.areas.join('\n'),
    placeholder: 'model cwd cwd\n---\ngit git .',
    'aria-label': t('pinsp.gridAreas'),
    onInput: () =>
      update(
        {
          areas: areas.value
            .split('\n')
            .map((l) => l.trimEnd())
            .filter((l) => l.trim() !== ''),
        },
        'areas',
      ),
  });
  const cols = textInput((bp.columns ?? []).join(', '), (v) => update({ columns: splitList(v) }, 'cols'), {
    class: 'input mono',
    placeholder: '1fr, 2fr, auto',
    'aria-label': t('pinsp.columns'),
  });
  const align = textInput(
    (bp.align ?? []).join(', '),
    (v) => update({ align: splitList(v) as TuiBreakpoint['align'] }, 'align'),
    { class: 'input mono', placeholder: 'left, center, right', 'aria-label': t('pinsp.align') },
  );
  return h(
    'div',
    { class: 'bp' },
    h(
      'div',
      { class: 'bp-head' },
      h('strong', null, t('pinsp.breakpoint', { n: index + 1 })),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'reset-link',
          type: 'button',
          onClick: () =>
            setTui({ breakpoints: (S.config.tui?.breakpoints ?? all).filter((_, i) => i !== index) }),
        },
        t('pinsp.remove'),
      ),
    ),
    field(
      t('pinsp.minWidthColumns'),
      numberInput(bp.minWidth, (v) => update({ minWidth: Math.max(0, v ?? 0) }, 'min'), { min: 0, step: 1 }),
    ),
    field(t('pinsp.areas'), areas, t('pinsp.areasHelp')),
    field(t('pinsp.columns'), cols, t('pinsp.columnsHelp')),
    field(t('pinsp.align'), align, t('pinsp.alignHelp')),
  );
}

export function panelSection(): HTMLElement {
  const tui = S.config.tui ?? {};
  const bps = tui.breakpoints ?? [];
  const boxId = typeof tui.box === 'string' ? tui.box : undefined;

  const boxes = h('div', { class: 'boxes' });
  for (const id of Object.keys(BOXES)) {
    boxes.append(
      h(
        'button',
        {
          type: 'button',
          class: `box-opt${id === boxId ? ' on' : ''}`,
          title: id,
          'aria-pressed': String(id === boxId),
          'data-box': id,
          onClick: () => setTui({ box: id }),
        },
        h('pre', null, sample(id)),
        h('span', null, id),
      ),
    );
  }

  const templates = h('textarea', {
    class: 'input mono areas',
    rows: 5,
    spellcheck: false,
    value: tui.templates ? JSON.stringify(tui.templates, null, 2) : '',
    placeholder: '{ "stats": { "items": ["{session-cost}", "{five-hour-usage}"], "gap": 2 } }',
    'aria-label': t('pinsp.templatesAria'),
  });
  const tplErr = h('div', { class: 'form-error', role: 'alert' });
  templates.addEventListener('input', () => {
    const text = templates.value.trim();
    if (!text) {
      tplErr.textContent = '';
      setTui({ templates: undefined }, 'tpl');
      return;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(t('pinsp.templatesObject'));
      }
      tplErr.textContent = '';
      setTui({ templates: parsed }, 'tpl');
    } catch (e) {
      tplErr.textContent = (e as Error).message;
    }
  });

  const tokenHint = t('pinsp.tokens', { list: tokens() });
  const root = h(
    'section',
    { class: 'section panel-section' },
    h('h4', null, t('pinsp.panel')),
    fieldWithReset(
      t('pinsp.box'),
      boxes,
      resetLink(tui.box !== undefined, () => setTui({ box: undefined })),
      boxId ? undefined : typeof tui.box === 'object' ? t('pinsp.boxCustom') : t('pinsp.boxTheme'),
    ),
    h('div', { id: 'tui-note', class: 'tui-note', role: 'status' }),
    field(
      t('pinsp.width'),
      segmented(
        [
          { value: 'auto', label: t('insp.auto'), title: t('pinsp.width.autoTitle') },
          { value: 'content', label: t('pinsp.width.content'), title: t('pinsp.width.contentTitle') },
          { value: 'full', label: t('pinsp.width.full'), title: t('pinsp.width.fullTitle') },
        ] as const,
        tui.fitContent === true ? 'content' : tui.fitContent === false ? 'full' : 'auto',
        (v) => setTui({ fitContent: v === 'content' ? true : v === 'full' ? false : undefined }),
      ),
      t('pinsp.widthHelp'),
    ),
    field(
      t('pinsp.dividers'),
      toggle(tui.dividers ?? true, (v) => setTui({ dividers: v ? undefined : false })),
      t('pinsp.dividersHelp'),
      true,
    ),
    h(
      'div',
      { class: 'two-col' },
      fieldWithReset(
        t('pinsp.minWidth'),
        numberInput(
          tui.minWidth ?? '',
          (v) => setTui({ minWidth: v === null ? undefined : Math.max(10, v) }, 'minw'),
          {
            min: 10,
            placeholder: '32',
          },
        ),
        resetLink(tui.minWidth !== undefined, () => setTui({ minWidth: undefined })),
      ),
      fieldWithReset(
        t('insp.maxWidth'),
        numberInput(
          tui.maxWidth ?? '',
          (v) => setTui({ maxWidth: v === null ? undefined : Math.max(10, v) }, 'maxw'),
          {
            min: 10,
            placeholder: t('insp.none'),
          },
        ),
        resetLink(tui.maxWidth !== undefined, () => setTui({ maxWidth: undefined })),
      ),
    ),
    fieldWithReset(
      t('insp.padding'),
      numberInput(
        tui.padding ?? '',
        (v) => setTui({ padding: v === null ? undefined : Math.max(0, Math.min(8, v)) }, 'pad'),
        {
          min: 0,
          max: 8,
          placeholder: '1',
        },
      ),
      resetLink(tui.padding !== undefined, () => setTui({ padding: undefined })),
      t('pinsp.paddingHelp'),
    ),
    h(
      'div',
      { class: 'two-col' },
      field(
        t('pinsp.titleLeft'),
        textInput(tui.title?.left ?? '', (v) => setTui({ title: pair('title', 'left', v) }, 'tl'), {
          class: 'input mono',
          placeholder: '{model}',
        }),
      ),
      field(
        t('pinsp.titleRight'),
        textInput(
          typeof tui.title?.right === 'string' ? tui.title.right : '',
          (v) => setTui({ title: pair('title', 'right', v) }, 'tr'),
          { class: 'input mono', placeholder: 'ccinfobar', disabled: tui.title?.right === false },
        ),
      ),
    ),
    field(
      t('pinsp.hideRightTitle'),
      toggle(tui.title?.right === false, (v) =>
        setTui({ title: pair('title', 'right', v ? false : undefined) }),
      ),
      undefined,
      true,
    ),
    h(
      'div',
      { class: 'two-col' },
      field(
        t('pinsp.footerLeft'),
        textInput(tui.footer?.left ?? '', (v) => setTui({ footer: pair('footer', 'left', v) }, 'fl'), {
          class: 'input mono',
          placeholder: '{session-cost}',
        }),
      ),
      field(
        t('pinsp.footerRight'),
        textInput(tui.footer?.right ?? '', (v) => setTui({ footer: pair('footer', 'right', v) }, 'fr'), {
          class: 'input mono',
          placeholder: '{five-hour-usage}',
        }),
      ),
    ),
    h('div', { class: 'hint token-hint' }, tokenHint),
    h(
      'div',
      { class: 'subsection' },
      h('h5', null, t('pinsp.grid')),
      h('p', { class: 'hint' }, t('pinsp.gridHelp')),
      ...bps.map((b, i) => breakpointEditor(b, i, bps)),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onClick: () => {
            const names = S.config.lines.flat().map((i) => i.id);
            const areasRows = [];
            for (let i = 0; i < names.length; i += 3) areasRows.push(names.slice(i, i + 3).join(' '));
            const next: TuiBreakpoint = {
              minWidth: bps.length ? Math.max(...bps.map((b) => b.minWidth)) + 40 : 0,
              areas: areasRows.length ? areasRows : ['.'],
            };
            setTui({ breakpoints: [...bps, next] });
          },
        },
        t('pinsp.addBreakpoint'),
      ),
      field(t('pinsp.templates'), templates, t('pinsp.templatesHelp')),
      tplErr,
    ),
  );
  validate();
  return root;
}
