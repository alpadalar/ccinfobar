import { truncate } from '../core/ansi.js';
import { parseUrlTemplate } from '../core/http-spec.js';
import type { HttpPathResult, HttpValue } from '../core/job-values.js';
import { parsePath } from '../core/jsonpath.js';
import { sanitizeText } from '../core/sanitize.js';
import type { RenderContext, WidgetDef, WidgetItem, WidgetResult } from '../core/types.js';
import { httpKey } from '../data/jobs/keys.js';
import { jobValue } from '../data/jobs/runner.js';
import { opt } from './shared.js';

export const HTTP_GONE_MS = 86_400_000;
const MIN_STALE_MS = 900_000;

export const httpStaleMs = (intervalS: number): number => Math.max(3 * intervalS * 1000, MIN_STALE_MS);

export type HttpState =
  | { kind: 'no-url' }
  | { kind: 'bad-url'; error: string }
  | { kind: 'bad-path'; error: string }
  | { kind: 'pending'; key: string }
  | { kind: 'error'; key: string; error: string | null }
  | { kind: 'gone'; key: string; error: string | null }
  | { kind: 'miss'; key: string; code: string }
  | { kind: 'ok'; key: string; v: unknown; stale: boolean; error: string | null };

const pathOf = (item: WidgetItem): string => opt(item, 'path', '$') || '$';

function lookup(v: HttpValue, path: string): HttpPathResult | null {
  const paths = v.paths && typeof v.paths === 'object' ? v.paths : null;
  const r = paths && Object.hasOwn(paths, path) ? paths[path] : v.any;
  return r && typeof r === 'object' && typeof r.ok === 'boolean' ? r : null;
}

export function httpState(ctx: RenderContext, item: WidgetItem): HttpState {
  const url = opt(item, 'url', '');
  if (!url) return { kind: 'no-url' };
  const checked = parseUrlTemplate(url);
  if (!checked.ok) return { kind: 'bad-url', error: checked.error };
  const path = pathOf(item);
  const parsed = parsePath(path);
  if (!parsed.ok) return { kind: 'bad-path', error: parsed.error };
  const key = httpKey(url, opt(item, 'headers', ''));
  const j = jobValue(ctx.data.jobs?.()?.job<HttpValue>(key) ?? null);
  if (!j) return { kind: 'pending', key };
  const v = j.value;
  if (!v || typeof v !== 'object') return { kind: 'error', key, error: j.error };
  const age = ctx.now.getTime() - (j.at ?? 0);
  if (age > HTTP_GONE_MS) return { kind: 'gone', key, error: j.error };
  const r = lookup(v, path);
  if (!r) return { kind: 'pending', key };
  if (!r.ok) return { kind: 'miss', key, code: typeof r.code === 'string' ? r.code : 'not-scalar' };
  const interval = Math.max(30, opt(item, 'interval', 300));
  return { kind: 'ok', key, v: r.v, stale: age > httpStaleMs(interval), error: j.error };
}

function scalarText(v: unknown, item: WidgetItem): string | null {
  if (typeof v === 'string') {
    const max = Math.min(200, Math.max(1, Math.floor(opt(item, 'maxLength', 40))));
    return truncate(sanitizeText(v), max);
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const d = Math.floor(opt(item, 'decimals', -1));
    return d >= 0 ? v.toFixed(Math.min(10, d)) : String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v === null ? 'null' : null;
}

function render(ctx: RenderContext, item: WidgetItem): WidgetResult {
  const s = httpState(ctx, item);
  if (s.kind !== 'ok') return null;
  const value = scalarText(s.v, item);
  if (value === null) return null;
  const format = sanitizeText(opt(item, 'format', '{value}')) || '{value}';
  const text = format.split('{value}').join(value);
  if (!text) return null;
  return s.stale ? { text: `${text} ?`, color: ctx.theme?.colors.muted ?? 'brightBlack' } : text;
}

export const widgets: WidgetDef[] = [
  {
    type: 'http',
    timeBased: true,
    name: 'HTTP JSON value',
    category: 'custom',
    description: 'One value from a JSON endpoint, fetched in the background; the line never waits on it',
    icon: { nerd: '', emoji: '🌐' },
    color: 'cyan',
    sample: '$12.50',
    sources: ['config:options.url', 'job'],
    options: [
      {
        key: 'url',
        label: 'URL',
        kind: 'text',
        default: '',
        help: 'http or https JSON endpoint; ${VAR} is allowed only in query values, for example ?key=${API_KEY}',
      },
      {
        key: 'path',
        label: 'JSON path',
        kind: 'text',
        default: '$',
        help: 'Which value to show, for example $.data.balance or $.items[0].name',
      },
      {
        key: 'format',
        label: 'Format',
        kind: 'text',
        default: '{value}',
        help: '{value} is replaced by the value, the rest is shown as is, for example ${value}',
      },
      {
        key: 'interval',
        label: 'Fetch every (seconds)',
        kind: 'number',
        default: 300,
        help: 'Seconds between fetches, at least 30',
      },
      {
        key: 'timeout',
        label: 'Timeout (ms)',
        kind: 'number',
        default: 5000,
        help: 'Request timeout, 1000 to 15000 ms',
      },
      {
        key: 'headers',
        label: 'Headers',
        kind: 'text',
        default: '',
        help: 'Name=$VAR entries, comma-separated, for example Authorization=Bearer $RELAY_TOKEN; values come only from env vars and are sent only over https or to localhost',
      },
      {
        key: 'decimals',
        label: 'Decimals',
        kind: 'number',
        default: -1,
        help: 'Digits after the point for numbers; -1 shows them as is',
      },
      {
        key: 'maxLength',
        label: 'Max text length',
        kind: 'number',
        default: 40,
        help: 'Longer text values are cut with …',
      },
    ],
    render,
  },
];
