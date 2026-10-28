import fs from 'node:fs';
import { lastPayloadPath } from '../../core/paths.js';
import { sanitizeText } from '../../core/sanitize.js';
import type { Config, OptionValue } from '../../core/types.js';
import { cacheKey } from '../cache.js';
import { defaultDue, failEnvelope, type Job, okEnvelope } from './runner.js';

export interface CommandValue {
  out: string;
}

export interface CommandGroup {
  key: string;
  command: string;
  timeoutMs: number;
  ttlMs: number;
}

const RETRY_MS = 60_000;
const MAX_OUT = 1024;
const DEFAULT_TIMEOUT = 1000;
const MAX_TIMEOUT = 60_000;

const num = (raw: OptionValue | undefined, fallback: number): number => {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

export function commandGroups(config: Pick<Config, 'lines'>, cwd: string): Map<string, CommandGroup> {
  const out = new Map<string, CommandGroup>();
  const lines = Array.isArray(config?.lines) ? config.lines : [];
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    for (const item of line) {
      const bg = item?.options?.background;
      if (item?.type !== 'command' || !(bg === true || bg === 'true')) continue;
      const command = typeof item.options?.command === 'string' ? item.options.command.trim() : '';
      const ttlMs = num(item.options?.cacheSeconds, 0) * 1000;
      if (!command || ttlMs <= 0) continue;
      const key = `cmd-${cacheKey(command, cwd)}`;
      const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(50, num(item.options?.timeout, DEFAULT_TIMEOUT)));
      const g = out.get(key);
      if (!g) out.set(key, { key, command, timeoutMs, ttlMs });
      else {
        g.ttlMs = Math.min(g.ttlMs, ttlMs);
        g.timeoutMs = Math.max(g.timeoutMs, timeoutMs);
      }
    }
  }
  return out;
}

function payloadText(env: NodeJS.ProcessEnv): string {
  try {
    return fs.readFileSync(lastPayloadPath(env), 'utf8') || '{}';
  } catch {
    return '{}';
  }
}

export const commandJob: Job<CommandValue> = {
  id: 'command',
  network: 'none',
  lockMs: 90_000,
  timeoutMs: 70_000,
  retryMs: RETRY_MS,
  keyRe: /^cmd-[0-9a-f]{20}$/,
  keys({ config, cwd }) {
    return [...commandGroups(config, cwd).values()].map((g) => ({ key: g.key, ttlMs: g.ttlMs }));
  },
  accepts(req, { config, cwd }) {
    return commandGroups(config, cwd).has(req.key);
  },
  due(e, now, req) {
    return defaultDue(e, now, req.ttlMs ?? RETRY_MS);
  },
  async run(req, ctx) {
    const group = commandGroups(ctx.config, ctx.cwd).get(req.key);
    if (!group) return failEnvelope(req.key, ctx.prev, 'not-configured', ctx.now, { retryMs: RETRY_MS });
    const input = payloadText(ctx.env);
    // child_process loads only in the worker
    const exec = ctx.execFile ?? (await import('./gh-exec.js')).defaultExecFile;
    const r = await exec(group.command, [], {
      shell: true,
      windowsHide: true,
      cwd: ctx.cwd,
      env: ctx.env,
      timeout: group.timeoutMs,
      maxBuffer: 1 << 20,
      input,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (r.code !== 0) {
      const error = r.code === null ? 'timeout' : `exit-${r.code}`;
      return failEnvelope(req.key, ctx.prev, error, ctx.now, { retryMs: RETRY_MS });
    }
    const line = r.stdout.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
    return okEnvelope(req.key, { out: sanitizeText(line.trim()).slice(0, MAX_OUT) }, ctx.now);
  },
};
