import { execSync } from 'node:child_process';
import { hyperlink, stripAnsi } from '../core/ansi.js';
import { keepSgrAndLinks, safeConfigUrl, sanitizeText } from '../core/sanitize.js';
import type { WidgetDef } from '../core/types.js';
import { cacheKey, readCache, writeCache } from '../data/cache.js';
import { opt } from './shared.js';

interface Cached {
  at: number;
  out: string;
}

export function formatCommandOutput(line: string, preserveColors: boolean): string {
  return preserveColors ? keepSgrAndLinks(line) : sanitizeText(stripAnsi(line));
}

export const widgets: WidgetDef[] = [
  {
    type: 'command',
    name: 'Custom command',
    category: 'custom',
    description: 'Runs a shell command and shows the first line of output; receives the payload on stdin',
    icon: { nerd: '', emoji: '⚙️' },
    color: 'white',
    sample: 'command output',
    sources: ['config:options.command'],
    options: [
      { key: 'command', label: 'Command', kind: 'text', default: '' },
      { key: 'timeout', label: 'Timeout (ms)', kind: 'number', default: 1000 },
      { key: 'cacheSeconds', label: 'Cache seconds', kind: 'number', default: 0 },
      { key: 'preserveColors', label: 'Keep ANSI colors', kind: 'boolean', default: false },
    ],
    render(ctx, item) {
      const command = opt(item, 'command', '').trim();
      if (!command) return null;
      const ttl = opt(item, 'cacheSeconds', 0) * 1000;
      const name = `cmd-${cacheKey(command, ctx.cwd)}.json`;
      const now = Date.now();
      let out: string | null = null;
      if (ttl > 0) {
        const hit = readCache<Cached>(name, ctx.env);
        if (hit && now - hit.at < ttl) out = hit.out;
      }
      if (out === null) {
        try {
          const input = JSON.stringify({
            ...ctx.payload,
            terminal_width: ctx.terminalWidth ?? ctx.payload.terminal_width,
          });
          out = execSync(command, {
            input,
            cwd: ctx.cwd,
            env: ctx.env,
            encoding: 'utf8',
            timeout: Math.max(50, opt(item, 'timeout', 1000)),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'ignore'],
          });
        } catch (e) {
          // the command exited without reading stdin
          const r = e as { code?: string; status?: number | null; stdout?: unknown };
          if (r.code !== 'EPIPE' || r.status !== 0 || typeof r.stdout !== 'string') return null;
          out = r.stdout;
        }
        if (ttl > 0) writeCache(name, { at: now, out } satisfies Cached, ctx.env);
      }
      const line = out
        .split(/\r?\n/)
        .find((l) => l.trim() !== '')
        ?.trim();
      if (!line) return null;
      const shown = formatCommandOutput(line, opt(item, 'preserveColors', false));
      return stripAnsi(shown).trim() ? shown : null;
    },
  },
  {
    type: 'link',
    name: 'Link',
    category: 'custom',
    description: 'Clickable hyperlink (OSC 8)',
    icon: { nerd: '󰌷', emoji: '🔗' },
    color: 'blue',
    sample: 'docs',
    options: [
      { key: 'text', label: 'Text', kind: 'text', default: 'link' },
      { key: 'url', label: 'URL', kind: 'text', default: '' },
    ],
    render(_ctx, item) {
      const url = opt(item, 'url', '');
      const text = opt(item, 'text', 'link');
      if (!text) return null;
      const href = url ? safeConfigUrl(url) : null;
      return href ? hyperlink(text, href) : text;
    },
  },
  {
    type: 'env',
    name: 'Environment variable',
    category: 'custom',
    description: 'Value of an environment variable',
    icon: { nerd: '', emoji: '🌍' },
    color: 'white',
    sample: 'production',
    options: [{ key: 'name', label: 'Variable name', kind: 'text', default: '' }],
    render(ctx, item) {
      const name = opt(item, 'name', '');
      const value = name ? ctx.env[name] : undefined;
      return (value && sanitizeText(value)) || null;
    },
  },
];
