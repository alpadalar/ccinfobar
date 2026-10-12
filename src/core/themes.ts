export interface ThemeColor {
  fg: string;
  bg: string;
}

export interface Theme {
  name: string;
  colors: ThemeColor[];
}

export const THEMES: Record<string, Theme> = {
  default: {
    name: 'Default',
    colors: [
      { fg: 'brightWhite', bg: 'blue' },
      { fg: 'black', bg: 'cyan' },
      { fg: 'black', bg: 'green' },
      { fg: 'black', bg: 'yellow' },
      { fg: 'brightWhite', bg: 'magenta' },
      { fg: 'brightWhite', bg: 'brightBlack' },
    ],
  },
  nord: {
    name: 'Nord',
    colors: [
      { fg: '#eceff4', bg: '#5e81ac' },
      { fg: '#2e3440', bg: '#88c0d0' },
      { fg: '#2e3440', bg: '#a3be8c' },
      { fg: '#2e3440', bg: '#ebcb8b' },
      { fg: '#eceff4', bg: '#b48ead' },
      { fg: '#eceff4', bg: '#4c566a' },
    ],
  },
  dracula: {
    name: 'Dracula',
    colors: [
      { fg: '#f8f8f2', bg: '#6272a4' },
      { fg: '#282a36', bg: '#8be9fd' },
      { fg: '#282a36', bg: '#50fa7b' },
      { fg: '#282a36', bg: '#f1fa8c' },
      { fg: '#282a36', bg: '#ff79c6' },
      { fg: '#282a36', bg: '#bd93f9' },
    ],
  },
  gruvbox: {
    name: 'Gruvbox',
    colors: [
      { fg: '#fbf1c7', bg: '#458588' },
      { fg: '#282828', bg: '#83a598' },
      { fg: '#282828', bg: '#b8bb26' },
      { fg: '#282828', bg: '#fabd2f' },
      { fg: '#fbf1c7', bg: '#b16286' },
      { fg: '#fbf1c7', bg: '#504945' },
    ],
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    colors: [
      { fg: '#1a1b26', bg: '#7aa2f7' },
      { fg: '#1a1b26', bg: '#7dcfff' },
      { fg: '#1a1b26', bg: '#9ece6a' },
      { fg: '#1a1b26', bg: '#e0af68' },
      { fg: '#1a1b26', bg: '#bb9af7' },
      { fg: '#c0caf5', bg: '#414868' },
    ],
  },
  catppuccin: {
    name: 'Catppuccin Mocha',
    colors: [
      { fg: '#1e1e2e', bg: '#89b4fa' },
      { fg: '#1e1e2e', bg: '#94e2d5' },
      { fg: '#1e1e2e', bg: '#a6e3a1' },
      { fg: '#1e1e2e', bg: '#f9e2af' },
      { fg: '#1e1e2e', bg: '#cba6f7' },
      { fg: '#cdd6f4', bg: '#45475a' },
    ],
  },
  solarized: {
    name: 'Solarized',
    colors: [
      { fg: '#fdf6e3', bg: '#268bd2' },
      { fg: '#fdf6e3', bg: '#2aa198' },
      { fg: '#fdf6e3', bg: '#859900' },
      { fg: '#002b36', bg: '#b58900' },
      { fg: '#fdf6e3', bg: '#6c71c4' },
      { fg: '#93a1a1', bg: '#073642' },
    ],
  },
  monochrome: {
    name: 'Monochrome',
    colors: [
      { fg: '#ffffff', bg: '#3a3a3a' },
      { fg: '#ffffff', bg: '#4e4e4e' },
      { fg: '#ffffff', bg: '#626262' },
    ],
  },
};

export function getTheme(name: string): Theme {
  return THEMES[name] ?? THEMES.default!;
}
