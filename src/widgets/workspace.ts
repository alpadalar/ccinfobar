import os from 'node:os';
import path from 'node:path';
import type { OptionSpec, WidgetDef } from '../core/types.js';
import { opt } from './shared.js';

const SEP = /[\\/]+/;

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
    options: [styleOption, segmentsOption],
    render(ctx, item) {
      const dir = ctx.payload.workspace?.current_dir ?? ctx.payload.cwd ?? ctx.cwd;
      if (!dir) return null;
      return formatPath(dir, opt<string>(item, 'style', 'basename'), opt(item, 'segments', 2));
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
