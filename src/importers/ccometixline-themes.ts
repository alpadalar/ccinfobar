type Color = { c16: number } | { c256: number } | { r: number; g: number; b: number };
type Seg = { text: Color; icon?: Color; bg?: Color; bold?: boolean; plain?: string; nerd?: string };
export type CclineTheme =
  | 'cometix'
  | 'default'
  | 'minimal'
  | 'gruvbox'
  | 'nord'
  | 'powerline-dark'
  | 'powerline-light'
  | 'powerline-rose-pine'
  | 'powerline-tokyo-night';

const IDS = [
  'model',
  'directory',
  'git',
  'context_window',
  'usage',
  'cost',
  'session',
  'output_style',
] as const;
type Id = (typeof IDS)[number];

const ON = new Set<string>(['model', 'directory', 'git', 'context_window']);

const ICONS: Record<Id, [string, string]> = {
  model: ['\u{1f916}', '\ue26d'],
  directory: ['\u{1f4c1}', '\u{f024b}'],
  git: ['\u{1f33f}', '\u{f02a2}'],
  context_window: ['\u26a1\ufe0f', '\uf49b'],
  usage: ['\u{1f4ca}', '\u{f0a9e}'],
  cost: ['\u{1f4b0}', '\ueec1'],
  session: ['\u23f1\ufe0f', '\u{f19bb}'],
  output_style: ['\u{1f3af}', '\u{f12f5}'],
};

const OPTIONS: Partial<Record<Id, Record<string, unknown>>> = {
  git: { show_sha: false },
  usage: { api_base_url: 'https://api.anthropic.com', cache_duration: 180, timeout: 2 },
};

const c16 = (c16: number): Color => ({ c16 });
const c256 = (c256: number): Color => ({ c256 });
const rgb = (n: number): Color => ({ r: n >> 16, g: (n >> 8) & 255, b: n & 255 });
const bold = true;

const theme = (name: CclineTheme, mode: string, separator: string, segs: Record<Id, Seg>) => ({
  theme: name,
  style: { mode, separator },
  segments: IDS.map((id) => {
    const s = segs[id];
    return {
      id,
      enabled: ON.has(id),
      icon: { plain: s.plain ?? ICONS[id][0], nerd_font: s.nerd ?? ICONS[id][1] },
      colors: { icon: s.icon ?? s.text, text: s.text, ...(s.bg ? { background: s.bg } : {}) },
      styles: { text_bold: s.bold === true },
      options: { ...OPTIONS[id] },
    };
  }),
});

export const CCLINE_THEMES: Readonly<Record<CclineTheme, Record<string, unknown>>> = {
  cometix: theme('cometix', 'nerd_font', ' | ', {
    model: { text: c16(14), bold },
    directory: { text: c16(10), icon: c16(11), bold },
    git: { text: c16(12), bold },
    context_window: { text: c16(13), bold },
    usage: { text: c16(14) },
    cost: { text: c16(3), bold },
    session: { text: c16(2), bold },
    output_style: { text: c16(6), bold },
  }),
  default: theme('default', 'plain', ' | ', {
    model: { text: c16(14) },
    directory: { text: c16(10), icon: c16(11) },
    git: { text: c16(12) },
    context_window: { text: c16(13) },
    usage: { text: c16(14) },
    cost: { text: c16(3) },
    session: { text: c16(2) },
    output_style: { text: c16(6) },
  }),
  minimal: theme('minimal', 'plain', ' \u2502 ', {
    model: { text: c16(14), plain: '\u273d', nerd: '\uf2d0' },
    directory: { text: c16(10), icon: c16(11), plain: '\u25d0' },
    git: { text: c16(12), plain: '\u203b' },
    context_window: { text: c16(13), plain: '\u25d0' },
    usage: { text: c16(14) },
    cost: { text: c16(3) },
    session: { text: c16(2) },
    output_style: { text: c16(6) },
  }),
  gruvbox: theme('gruvbox', 'nerd_font', ' | ', {
    model: { text: c256(208), bold },
    directory: { text: c256(142), bold },
    git: { text: c256(109), bold },
    context_window: { text: c16(5), bold },
    usage: { text: c16(14) },
    cost: { text: c256(214), bold },
    session: { text: c256(142), bold },
    output_style: { text: c256(109), bold },
  }),
  nord: theme('nord', 'nerd_font', '', {
    model: { text: rgb(0x2e3440), bg: rgb(0x88c0d0) },
    directory: { text: rgb(0x2e3440), bg: rgb(0xa3be8c) },
    git: { text: rgb(0x2e3440), bg: rgb(0x81a1c1) },
    context_window: { text: rgb(0x2e3440), bg: rgb(0xb48ead) },
    usage: { text: rgb(0x2e3440), bg: rgb(0xebcb8b) },
    cost: { text: rgb(0x2e3440), bg: rgb(0xebcb8b) },
    session: { text: rgb(0x2e3440), bg: rgb(0xa3be8c) },
    output_style: { text: rgb(0x2e3440), bg: rgb(0x88c0d0) },
  }),
  'powerline-dark': theme('powerline-dark', 'nerd_font', '\ue0b0', {
    model: { text: rgb(0xffffff), bg: rgb(0x2d2d2d) },
    directory: { text: rgb(0xffffff), bg: rgb(0x8b4513) },
    git: { text: rgb(0xffffff), bg: rgb(0x404040) },
    context_window: { text: rgb(0xd1d5db), bg: rgb(0x374151) },
    usage: { text: rgb(0xd1d5db), bg: rgb(0x2d323b) },
    cost: { text: rgb(0xe5c07b), bg: rgb(0x282c34) },
    session: { text: rgb(0xa3be8c), bg: rgb(0x2d323b) },
    output_style: { text: rgb(0x81a1c1), bg: rgb(0x323842) },
  }),
  'powerline-light': theme('powerline-light', 'nerd_font', '\ue0b0', {
    model: { text: rgb(0x000000), bg: rgb(0x87ceeb) },
    directory: { text: rgb(0xffffff), bg: rgb(0xff6b47) },
    git: { text: rgb(0xffffff), bg: rgb(0x4fb3d9) },
    context_window: { text: rgb(0xffffff), bg: rgb(0x6b7280) },
    usage: { text: rgb(0xffffff), bg: rgb(0x28a745) },
    cost: { text: rgb(0xffffff), bg: rgb(0xffc107) },
    session: { text: rgb(0xffffff), bg: rgb(0x28a745) },
    output_style: { text: rgb(0xffffff), bg: rgb(0x20c997) },
  }),
  'powerline-rose-pine': theme('powerline-rose-pine', 'nerd_font', '\ue0b0', {
    model: { text: rgb(0xebbcba), bg: rgb(0x191724) },
    directory: { text: rgb(0xc4a7e7), bg: rgb(0x26233a) },
    git: { text: rgb(0x9ccfd8), bg: rgb(0x1f1d2e) },
    context_window: { text: rgb(0xe0def4), bg: rgb(0x524f67) },
    usage: { text: rgb(0xf6c177), bg: rgb(0x232136) },
    cost: { text: rgb(0xf6c177), bg: rgb(0x232136) },
    session: { text: rgb(0x9ccfd8), bg: rgb(0x2a273f) },
    output_style: { text: rgb(0x31748f), bg: rgb(0x26233a) },
  }),
  'powerline-tokyo-night': theme('powerline-tokyo-night', 'nerd_font', '\ue0b0', {
    model: { text: rgb(0xfca7ea), bg: rgb(0x191b29) },
    directory: { text: rgb(0x82aaff), bg: rgb(0x2f334d) },
    git: { text: rgb(0xc3e88d), bg: rgb(0x1e2030) },
    context_window: { text: rgb(0xc0caf5), bg: rgb(0x3d59a1), plain: '\u26a1\ufe0f\ufe0f' },
    usage: { text: rgb(0xe0af68), bg: rgb(0x24283b) },
    cost: { text: rgb(0xe0af68), bg: rgb(0x24283b) },
    session: { text: rgb(0x9ece6a), bg: rgb(0x292e42), nerd: '\u{f1ad3}' },
    output_style: { text: rgb(0x7dcfff), bg: rgb(0x202334) },
  }),
};
