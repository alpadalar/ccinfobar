export interface TerminalProfile {
  id: string;
  name: string;
  bg: string;
  fg: string;
  palette: string[];
  light?: boolean;
}

export interface DetectedColors {
  bg: string;
  fg: string | null;
  palette: (string | null)[] | null;
}

const VSCODE = [
  '#000000',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff',
];
const XTERM = [
  '#000000',
  '#cd0000',
  '#00cd00',
  '#cdcd00',
  '#0000ee',
  '#cd00cd',
  '#00cdcd',
  '#e5e5e5',
  '#7f7f7f',
  '#ff0000',
  '#00ff00',
  '#ffff00',
  '#5c5cff',
  '#ff00ff',
  '#00ffff',
  '#ffffff',
];
const TANGO = [
  '#2e3436',
  '#cc0000',
  '#4e9a06',
  '#c4a000',
  '#3465a4',
  '#75507b',
  '#06989a',
  '#d3d7cf',
  '#555753',
  '#ef2929',
  '#8ae234',
  '#fce94f',
  '#729fcf',
  '#ad7fa8',
  '#34e2e2',
  '#eeeeec',
];
const SOLARIZED = [
  '#073642',
  '#dc322f',
  '#859900',
  '#b58900',
  '#268bd2',
  '#d33682',
  '#2aa198',
  '#eee8d5',
  '#002b36',
  '#cb4b16',
  '#586e75',
  '#657b83',
  '#839496',
  '#6c71c4',
  '#93a1a1',
  '#fdf6e3',
];

export const TERMINALS: TerminalProfile[] = [
  { id: 'default', name: 'Dark (default)', bg: '#0a0a0c', fg: '#d7d7de', palette: VSCODE },
  { id: 'black', name: 'Black', bg: '#000000', fg: '#e5e5e5', palette: XTERM },
  { id: 'gray', name: 'Gray', bg: '#2e3436', fg: '#e8e8e6', palette: TANGO },
  { id: 'navy', name: 'Navy', bg: '#0f1d3a', fg: '#d6deeb', palette: VSCODE },
  { id: 'ubuntu', name: 'Ubuntu', bg: '#300a24', fg: '#ffffff', palette: TANGO },
  {
    id: 'gnome',
    name: 'GNOME',
    bg: '#1e1e1e',
    fg: '#d0cfcc',
    palette: [
      '#171421',
      '#c01c28',
      '#26a269',
      '#a2734c',
      '#12488b',
      '#a347ba',
      '#2aa1b3',
      '#d0cfcc',
      '#5e5c64',
      '#f66151',
      '#33da7a',
      '#e9ad0c',
      '#2a7bde',
      '#c061cb',
      '#33c7de',
      '#ffffff',
    ],
  },
  {
    id: 'campbell',
    name: 'Windows Terminal',
    bg: '#0c0c0c',
    fg: '#cccccc',
    palette: [
      '#0c0c0c',
      '#c50f1f',
      '#13a10e',
      '#c19c00',
      '#0037da',
      '#881798',
      '#3a96dd',
      '#cccccc',
      '#767676',
      '#e74856',
      '#16c60c',
      '#f9f1a5',
      '#3b78ff',
      '#b4009e',
      '#61d6d6',
      '#f2f2f2',
    ],
  },
  {
    id: 'macos',
    name: 'macOS Terminal',
    bg: '#ffffff',
    fg: '#000000',
    light: true,
    palette: [
      '#000000',
      '#990000',
      '#00a600',
      '#999900',
      '#0000b2',
      '#b200b2',
      '#00a6b2',
      '#bfbfbf',
      '#666666',
      '#e50000',
      '#00d900',
      '#e5e500',
      '#0000ff',
      '#e500e5',
      '#00e5e5',
      '#e5e5e5',
    ],
  },
  { id: 'light', name: 'Light', bg: '#fafafa', fg: '#383a42', palette: XTERM, light: true },
  { id: 'solarized-dark', name: 'Solarized Dark', bg: '#002b36', fg: '#839496', palette: SOLARIZED },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    bg: '#fdf6e3',
    fg: '#657b83',
    palette: SOLARIZED,
    light: true,
  },
  {
    id: 'dracula',
    name: 'Dracula',
    bg: '#282a36',
    fg: '#f8f8f2',
    palette: [
      '#21222c',
      '#ff5555',
      '#50fa7b',
      '#f1fa8c',
      '#bd93f9',
      '#ff79c6',
      '#8be9fd',
      '#f8f8f2',
      '#6272a4',
      '#ff6e6e',
      '#69ff94',
      '#ffffa5',
      '#d6acff',
      '#ff92df',
      '#a4ffff',
      '#ffffff',
    ],
  },
  {
    id: 'nord',
    name: 'Nord',
    bg: '#2e3440',
    fg: '#d8dee9',
    palette: [
      '#3b4252',
      '#bf616a',
      '#a3be8c',
      '#ebcb8b',
      '#81a1c1',
      '#b48ead',
      '#88c0d0',
      '#e5e9f0',
      '#4c566a',
      '#bf616a',
      '#a3be8c',
      '#ebcb8b',
      '#81a1c1',
      '#b48ead',
      '#8fbcbb',
      '#eceff4',
    ],
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    bg: '#1a1b26',
    fg: '#c0caf5',
    palette: [
      '#15161e',
      '#f7768e',
      '#9ece6a',
      '#e0af68',
      '#7aa2f7',
      '#bb9af7',
      '#7dcfff',
      '#a9b1d6',
      '#414868',
      '#f7768e',
      '#9ece6a',
      '#e0af68',
      '#7aa2f7',
      '#bb9af7',
      '#7dcfff',
      '#c0caf5',
    ],
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox Dark',
    bg: '#282828',
    fg: '#ebdbb2',
    palette: [
      '#282828',
      '#cc241d',
      '#98971a',
      '#d79921',
      '#458588',
      '#b16286',
      '#689d6a',
      '#a89984',
      '#928374',
      '#fb4934',
      '#b8bb26',
      '#fabd2f',
      '#83a598',
      '#d3869b',
      '#8ec07c',
      '#ebdbb2',
    ],
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin Mocha',
    bg: '#1e1e2e',
    fg: '#cdd6f4',
    palette: [
      '#45475a',
      '#f38ba8',
      '#a6e3a1',
      '#f9e2af',
      '#89b4fa',
      '#f5c2e7',
      '#94e2d5',
      '#bac2de',
      '#585b70',
      '#f38ba8',
      '#a6e3a1',
      '#f9e2af',
      '#89b4fa',
      '#f5c2e7',
      '#94e2d5',
      '#a6adc8',
    ],
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    bg: '#282c34',
    fg: '#abb2bf',
    palette: [
      '#282c34',
      '#e06c75',
      '#98c379',
      '#e5c07b',
      '#61afef',
      '#c678dd',
      '#56b6c2',
      '#abb2bf',
      '#5c6370',
      '#e06c75',
      '#98c379',
      '#e5c07b',
      '#61afef',
      '#c678dd',
      '#56b6c2',
      '#ffffff',
    ],
  },
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

export function isLight(hex: string): boolean {
  return HEX_RE.test(hex) && luminance(hex) > 0.4;
}

export function detectedProfile(d: DetectedColors): TerminalProfile {
  const light = isLight(d.bg);
  const base = light ? TERMINALS.find((t) => t.id === 'light')! : TERMINALS[0]!;
  const palette = base.palette.map((c, i) => {
    const v = d.palette?.[i];
    return v && HEX_RE.test(v) ? v : c;
  });
  return { id: 'detected', name: 'My terminal (detected)', bg: d.bg, fg: d.fg ?? base.fg, palette, light };
}

export interface TerminalChoice {
  id: string;
  bg?: string;
  fg?: string;
}

export function resolveProfile(choice: TerminalChoice, detected: TerminalProfile | null): TerminalProfile {
  const list = detected ? [detected, ...TERMINALS] : TERMINALS;
  const base = list.find((t) => t.id === choice.id) ?? list[0]!;
  if (!choice.bg && !choice.fg) return base;
  const bg = choice.bg && HEX_RE.test(choice.bg) ? choice.bg : base.bg;
  const fg = choice.fg && HEX_RE.test(choice.fg) ? choice.fg : base.fg;
  return { ...base, bg, fg, light: isLight(bg) };
}

export function applyProfile(root: HTMLElement, p: TerminalProfile): void {
  root.style.setProperty('--term-bg', p.bg);
  root.style.setProperty('--term-fg', p.fg);
  p.palette.forEach((c, i) => {
    root.style.setProperty(`--ansi-${i}`, c);
  });
  root.dataset.term = p.light ? 'light' : 'dark';
}
