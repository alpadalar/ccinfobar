import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboardConfig, getPreset } from '../src/core/presets.js';
import { renderPreview } from '../src/core/preview.js';
import { resolveTheme } from '../src/core/themes.js';
import { ansiToHtml } from '../src/editor/web/ansi-html.js';
import { TERMINALS } from '../src/editor/web/terminals.js';

const root = process.argv[2] ?? process.cwd();
const OUT = path.join(root, 'docs/images/demo.gif');
const COLS = 118;
const ROWS = 5;
const W = 1040;
const H = 268;
const SCALE = 2;
const DELAY_MS = 1000;

const FRAMES: [preset: string, theme: string][] = [
  ['default', 'classic'],
  ['gsd', 'tokyo-night'],
  ['cockpit', 'classic'],
  ['minimal', 'catppuccin'],
  ['full', 'dracula'],
  ['gsd', 'neon'],
  ['default', 'blocks'],
  ['powerline', 'nord'],
  ['gsd', 'gruvbox'],
  ['default', 'panel'],
];

function browser(): string {
  const names = [process.env.CHROME, 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
  for (const n of names) {
    if (!n) continue;
    try {
      execFileSync('which', [n], { stdio: 'ignore' });
      return n;
    } catch {}
  }
  throw new Error('No Chrome or Chromium found; set CHROME=/path/to/chrome');
}

function page(lines: string[], title: string, box = false, height = H): string {
  const term = TERMINALS.find((t) => t.id === 'default')!;
  const vars = term.palette.map((c, i) => `--ansi-${i}:${c}`).join(';');
  const body = lines.map((l) => `<div class="line">${ansiToHtml(l) || '&nbsp;'}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${vars};--term-bg:${term.bg};--term-fg:${term.fg}}
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${height}px;background:#0d1117;overflow:hidden}
body{padding:14px;font:14px/1.25 "DejaVu Sans Mono","Noto Sans Mono",monospace}
.win{height:100%;border-radius:10px;background:var(--term-bg);color:var(--term-fg);box-shadow:0 0 0 1px #30363d;overflow:hidden}
.bar{display:flex;align-items:center;gap:7px;height:30px;padding:0 12px;background:#16171c;color:#8b8b96;font:12px system-ui,sans-serif}
.bar i{width:11px;height:11px;border-radius:50%;background:#3a3b42}
.bar span{margin-left:8px}
.prompt{margin:12px 14px 10px;padding:6px 10px;border:1px solid #2a2b31;border-radius:6px;color:#6e6e78}
.prompt b{color:#e8895a;font-weight:400}
.lines{padding:0 14px;white-space:pre;font-variant-ligatures:none}
.cell{display:inline-block;width:1ch;overflow:visible;text-align:center}
.line{height:18px;line-height:18px;overflow:visible}
.box .line{height:17px;line-height:17px;transform:scaleY(1.06);transform-origin:top}
.pl{position:relative;color:transparent}
.pl::before{content:"";position:absolute;inset:0;background:var(--pl,var(--term-fg))}
.pl-e0b0::before{clip-path:polygon(0 0,100% 50%,0 100%)}
.pl-e0b2::before{clip-path:polygon(100% 0,0 50%,100% 100%)}
.pl-e0b1::before{clip-path:polygon(0 0,18% 0,100% 50%,18% 100%,0 100%,82% 50%)}
.pl-e0b3::before{clip-path:polygon(100% 0,82% 0,0 50%,82% 100%,100% 100%,18% 50%)}
.pl-e0b4::before{clip-path:ellipse(100% 50% at 0 50%)}
.pl-e0b6::before{clip-path:ellipse(100% 50% at 100% 50%)}
</style></head><body><div class="win"><div class="bar"><i></i><i></i><i></i><span>${title}</span></div>
<div class="prompt"><b>&gt;</b> Ask Claude to build something</div><div class="lines${box ? ' box' : ''}">${body}</div></div></body></html>`;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccinfobar-demo-'));
const chrome = browser();

function shoot(html: string, png: string, height: number): void {
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--force-device-scale-factor=${SCALE}`,
    `--window-size=${W},${height}`,
    `--screenshot=${png}`,
    `file://${html}`,
  ]);
}
const shots: string[] = [];
FRAMES.forEach(([presetId, themeId], i) => {
  const preset = getPreset(presetId);
  if (!preset) throw new Error(`unknown preset ${presetId}`);
  const theme = resolveTheme(themeId);
  const built = preset.build();
  const config = {
    ...built,
    lines: built.lines.map((l) => l.map((item) => ({ ...item, hideEmpty: true }))),
    theme: themeId,
    style: undefined,
    separator: undefined,
    widthOffset: 0,
    maxWidth: 'auto' as const,
    colorLevel: 3 as const,
    charset: 'nerd' as const,
  };
  const lines = renderPreview(config, 'sample', COLS).slice(0, theme.style === 'tui' ? ROWS + 2 : ROWS);
  const html = path.join(tmp, `frame-${i}.html`);
  fs.writeFileSync(html, page(lines, `${theme.name} theme · ${preset.name} preset`, theme.style === 'tui'));
  const png = path.join(tmp, `frame-${String(i).padStart(2, '0')}.png`);
  shoot(html, png, H);
  shots.push(png);
  console.log(`frame ${i + 1}/${FRAMES.length}: ${preset.name} × ${theme.name}`);
});
execFileSync('magick', ['-delay', String(DELAY_MS / 10), '-loop', '0', ...shots, '-layers', 'Optimize', OUT]);
const dash = renderPreview(
  { ...dashboardConfig(), widthOffset: 0, colorLevel: 3, charset: 'nerd' },
  'sample',
  COLS,
);
const dashHtml = path.join(tmp, 'dashboard.html');
const dashHeight = 104 + dash.length * 18;
fs.writeFileSync(dashHtml, page(dash, 'Dashboard preset', true, dashHeight));
shoot(dashHtml, path.join(root, 'docs/images/dashboard.png'), dashHeight);
console.log('wrote docs/images/dashboard.png');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${path.relative(root, OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
