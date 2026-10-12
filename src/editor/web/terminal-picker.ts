import { clear, h, icon } from './dom.js';
import {
  applyProfile,
  type DetectedColors,
  detectedProfile,
  resolveProfile,
  TERMINALS,
  type TerminalChoice,
  type TerminalProfile,
} from './terminals.js';

const KEY = 'ccinfobar.terminal';

function load(): TerminalChoice | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as TerminalChoice | null;
    return v && typeof v.id === 'string' ? v : null;
  } catch {
    return null;
  }
}

function save(choice: TerminalChoice): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {}
}

function swatch(p: TerminalProfile, size: 'sm' | 'lg' = 'lg'): HTMLSpanElement {
  const bars = [1, 2, 3, 4, 5, 6].map((i) => h('i', { style: `background:${p.palette[i]}` }));
  return h(
    'span',
    { class: `term-swatch ${size}`, style: `background:${p.bg};color:${p.fg}`, 'aria-hidden': 'true' },
    h('b', null, 'Aa'),
    h('span', { class: 'term-swatch-bars' }, ...bars),
  );
}

export function initTerminalPicker(mount: HTMLElement, detectedColors: DetectedColors | null): void {
  const detected = detectedColors ? detectedProfile(detectedColors) : null;
  const profiles = detected ? [detected, ...TERMINALS] : TERMINALS;
  let choice: TerminalChoice = load() ?? { id: detected ? 'detected' : 'default' };
  if (!profiles.some((p) => p.id === choice.id)) choice = { id: profiles[0]!.id };

  const label = h('span', { class: 'term-picker-label' });
  const button = h(
    'button',
    {
      type: 'button',
      class: 'btn term-picker-btn',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      title: 'Terminal colors used for the preview',
    },
    h('span', { class: 'term-picker-dot' }),
    label,
    icon('chevron', 12),
  );
  const panel = h('div', {
    class: 'term-picker-panel',
    role: 'dialog',
    'aria-label': 'Terminal colors',
    hidden: true,
  });
  mount.append(button, panel);

  const apply = () => {
    const p = resolveProfile(choice, detected);
    applyProfile(document.documentElement, p);
    label.textContent = choice.bg || choice.fg ? `${p.name} · custom` : p.name;
    (button.querySelector('.term-picker-dot') as HTMLElement).style.cssText =
      `background:${p.bg};box-shadow:inset 0 0 0 0.1875rem ${p.palette[4]}, 0 0 0 0.0625rem var(--line)`;
    save(choice);
  };

  const render = () => {
    clear(panel);
    const current = resolveProfile(choice, detected);
    panel.append(
      h(
        'div',
        { class: 'term-picker-head' },
        h('strong', null, 'Terminal colors'),
        h(
          'span',
          { class: 'hint' },
          'Match your terminal so the preview shows the colors you will really see.',
        ),
      ),
    );
    const list = h('div', { class: 'term-picker-list', role: 'listbox', 'aria-label': 'Terminal profiles' });
    for (const p of profiles) {
      const selected = p.id === choice.id;
      list.append(
        h(
          'button',
          {
            type: 'button',
            role: 'option',
            'aria-selected': String(selected),
            class: `term-option${selected ? ' on' : ''}${p.id === 'detected' ? ' detected' : ''}`,
            onclick: () => {
              choice = { id: p.id };
              apply();
              render();
            },
          },
          swatch(p),
          h('span', { class: 'term-option-name' }, p.name),
          selected ? icon('check', 14) : null,
        ),
      );
    }
    panel.append(list);
    const colorInput = (key: 'bg' | 'fg', text: string) =>
      h(
        'label',
        { class: 'term-custom-field' },
        h('span', null, text),
        h('input', {
          type: 'color',
          value: choice[key] ?? current[key],
          oninput: (e: Event) => {
            choice = { ...choice, [key]: (e.target as HTMLInputElement).value };
            apply();
          },
          onchange: () => render(),
        }),
      );
    panel.append(
      h(
        'div',
        { class: 'term-custom' },
        h('span', { class: 'term-custom-title' }, 'Custom'),
        colorInput('bg', 'Background'),
        colorInput('fg', 'Text'),
        choice.bg || choice.fg
          ? h(
              'button',
              {
                type: 'button',
                class: 'link-btn',
                onclick: () => {
                  choice = { id: choice.id };
                  apply();
                  render();
                },
              },
              'Reset',
            )
          : null,
      ),
    );
    if (!detected) {
      panel.append(
        h(
          'p',
          { class: 'hint term-picker-note' },
          'Tip: run ccinfobar edit from your usual terminal to detect its colors automatically.',
        ),
      );
    }
  };

  const close = () => {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    render();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (panel.querySelector('.term-option.on') as HTMLElement | null)?.focus();
  };
  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !mount.contains(e.target as Node)) close();
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      button.focus();
    }
  });
  apply();
}
