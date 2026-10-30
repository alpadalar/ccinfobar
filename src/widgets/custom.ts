import path from 'node:path';
import { hyperlink, stripAnsi } from '../core/ansi.js';
import { keepSgrAndLinks, safeConfigUrl, sanitizeText } from '../core/sanitize.js';
import type { WidgetDef } from '../core/types.js';
import { cacheKey, readCache, writeCache } from '../data/cache.js';
import { execCommand } from '../data/exec.js';
import type { CommandValue } from '../data/jobs/command.js';
import { jobValue } from '../data/jobs/runner.js';
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
      {
        key: 'background',
        label: 'Run in background',
        kind: 'boolean',
        default: false,
        help: 'Run through the background worker every cacheSeconds; needs cacheSeconds > 0. The command then sees the last saved payload.',
      },
    ],
    render(ctx, item) {
      const command = opt(item, 'command', '').trim();
      if (!command) return null;
      const ttl = opt(item, 'cacheSeconds', 0) * 1000;
      const key = cacheKey(command, path.resolve(ctx.cwd));
      const name = `cmd-${key}.json`;
      const bg = ttl > 0 && opt(item, 'background', false);
      const hit = ttl > 0 && !bg ? readCache<Cached>(name, ctx.env) : null;
      const left = ctx.budget.deadline - ctx.clock();
      let out: string | null = null;
      if (bg) {
        const j = jobValue(ctx.data.jobs?.()?.job<CommandValue>(`cmd-${key}`) ?? null);
        out = typeof j?.value?.out === 'string' ? j.value.out : null;
      } else if (hit && ctx.clock() - hit.at < ttl) out = hit.out;
      else if (left < 50) out = hit?.out ?? null;
      else {
        const input = JSON.stringify({
          ...ctx.payload,
          terminal_width: ctx.terminalWidth ?? ctx.payload.terminal_width,
        });
        out = (ctx.data.exec ?? execCommand)(command, {
          input,
          cwd: ctx.cwd,
          env: ctx.env,
          timeout: Math.min(Math.max(50, opt(item, 'timeout', 1000)), left),
        });
        if (out !== null && ttl > 0) writeCache(name, { at: ctx.clock(), out } satisfies Cached, ctx.env);
      }
      if (out === null) return null;
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
