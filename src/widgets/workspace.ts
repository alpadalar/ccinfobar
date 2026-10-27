import os from 'node:os';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { OptionSpec, WidgetDef } from '../core/types.js';
import { truncate } from '../core/width.js';
import { opt } from './shared.js';

const SEP = /[\\/]+/;
const MAX_NAMES = 5;
const NAME_COLS = 24;

function home(): string {
  return os.homedir();
}

function withTilde(p: string): string {
  const h = home();
  if (p === h) return '~';
  if (p.startsWith(h + path.sep) || p.startsWith(`${h}/`)) return `~${p.slice(h.length)}`;
  return p;
}

function join(parts: string[], absolute: boolean, prefix: string): string {
  return prefix + (absolute ? '/' : '') + parts.join('/');
}

export function formatPath(p: string, style: string, segments = 2): string {
  const t = style === 'short' || style === 'tilde' ? withTilde(p) : p;
  if (style === 'full') return p;
  if (style === 'tilde') return t;
  const root = /^[A-Za-z]:[\\/]/.test(t) ? t.slice(0, 2) : '';
  const rest = root ? t.slice(2) : t;
  const absolute = rest.startsWith('/') || rest.startsWith('\\');
  const parts = rest.split(SEP).filter(Boolean);
  if (parts.length === 0) return t;
  if (style === 'basename') return parts[parts.length - 1]!;
  if (style === 'segments') {
    const n = Math.max(1, Math.floor(segments));
    const tail = parts.slice(-n);
    return tail.length < parts.length ? tail.join('/') : join(parts, absolute, root);
  }
  const short = parts.map((s, i) => {
    if (i === parts.length - 1 || s === '~') return s;
    return s.startsWith('.') ? s.slice(0, 2) : s.slice(0, 1);
  });
  return join(short, absolute, root);
}

export const styleOption: OptionSpec = {
  key: 'style',
  label: 'Style',
  kind: 'select',
  default: 'basename',
  choices: [
    { value: 'basename', label: 'Folder name' },
    { value: 'full', label: 'Full path' },
    { value: 'tilde', label: '~ for home' },
    { value: 'short', label: 'Abbreviated (~/p/acme-app)' },
    { value: 'segments', label: 'Last N segments' },
  ],
};

export const segmentsOption: OptionSpec = {
  key: 'segments',
  label: 'Segments',
  kind: 'number',
  default: 2,
};

export const widgets: WidgetDef[] = [
  {
    type: 'cwd',
    name: 'Current directory',
    category: 'workspace',
    description: 'Current working directory',
    icon: { nerd: '', emoji: '📂' },
    color: 'blue',
    sample: 'acme-app',
    options: [
      styleOption,
      segmentsOption,
      {
        key: 'addedDirs',
        label: 'Added folders',
        kind: 'select',
        default: 'off',
        choices: [
          { value: 'off', label: 'Off' },
          { value: 'count', label: 'Count' },
          { value: 'names', label: 'Names' },
        ],
        help: 'Folders added with /add-dir, as a count or as names',
      },
    ],
    render(ctx, item) {
      const dir = ctx.payload.workspace?.current_dir ?? ctx.payload.cwd ?? ctx.cwd;
      if (!dir) return null;
      const base = formatPath(dir, opt<string>(item, 'style', 'basename'), opt(item, 'segments', 2));
      const mode = opt<string>(item, 'addedDirs', 'off');
      if (mode === 'off') return base;
      const raw = ctx.payload.workspace?.added_dirs;
      const dirs = (Array.isArray(raw) ? raw : []).filter(
        (d): d is string => typeof d === 'string' && d.length > 0,
      );
      if (dirs.length === 0) return base;
      if (mode === 'count') return `${base} ${t('widget.cwd.addedDirs', { count: dirs.length })}`;
      const names = dirs
        .slice(0, MAX_NAMES)
        .map((d) => `+${truncate(sanitizeText(formatPath(d, 'basename')), NAME_COLS)}`);
      const more =
        dirs.length > MAX_NAMES ? ` ${t('widget.cwd.moreDirs', { count: dirs.length - MAX_NAMES })}` : '';
      return `${base} ${names.join(' ')}${more}`;
    },
  },
  {
    type: 'project-dir',
    name: 'Project directory',
    category: 'workspace',
    description: 'Directory Claude Code was started in',
    icon: { nerd: '', emoji: '🗂️' },
    color: 'blue',
    sample: 'acme-app',
    options: [styleOption, segmentsOption],
    render(ctx, item) {
      const dir = ctx.payload.workspace?.project_dir;
      if (!dir) return null;
      return formatPath(dir, opt<string>(item, 'style', 'basename'), opt(item, 'segments', 2));
    },
  },
];
