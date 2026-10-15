import { truncate } from '../core/ansi.js';
import { t } from '../core/i18n/index.js';
import type { StatusIncident, StatusIndicator, StatusValue } from '../core/job-values.js';
import type { RenderContext, WidgetDef, WidgetItem, WidgetResult } from '../core/types.js';
import { jobValue, nonessentialTrafficOff } from '../data/jobs/runner.js';
import { opt } from './shared.js';

export const STATUS_STALE_MS = 30 * 60_000;

const RANK: Record<StatusIndicator, number> = { critical: 4, major: 3, minor: 2, maintenance: 1, none: 0 };
const COLOR: Record<StatusIndicator, string> = {
  critical: 'red',
  major: 'red',
  minor: 'yellow',
  maintenance: 'blue',
  none: 'green',
};

const isLevel = (v: unknown): v is StatusIndicator => typeof v === 'string' && Object.hasOwn(RANK, v);

const isIncident = (v: unknown): v is StatusIncident => {
  const i = v as StatusIncident | null;
  return !!i && typeof i === 'object' && typeof i.name === 'string' && isLevel(i.impact);
};

const time = (i: StatusIncident): number => {
  const n = typeof i.updatedAt === 'string' ? Date.parse(i.updatedAt) : Number.NaN;
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
};

const terms = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const matches = (i: StatusIncident, want: string[]): boolean =>
  Array.isArray(i.components) &&
  i.components.some((c) => typeof c === 'string' && want.some((w) => c.toLowerCase().includes(w)));

export interface ServiceState {
  indicator: StatusIndicator;
  description: string;
  incidents: StatusIncident[];
  stale: boolean;
}

// null when there is nothing current to show
export function serviceState(ctx: RenderContext, item: WidgetItem): ServiceState | null {
  if (nonessentialTrafficOff(ctx.env)) return null;
  const j = jobValue(ctx.data.jobs?.()?.job<StatusValue>('status') ?? null);
  const v = j?.value;
  if (!j || !v || typeof v !== 'object' || !isLevel(v.indicator)) return null;
  if (j.at === null || ctx.now.getTime() - j.at > STATUS_STALE_MS) return null;
  const want = terms(opt(item, 'components', ''));
  const all = (Array.isArray(v.incidents) ? v.incidents : []).filter(isIncident);
  const incidents = (want.length ? all.filter((i) => matches(i, want)) : all).sort(
    (a, b) => RANK[b.impact] - RANK[a.impact] || time(b) - time(a),
  );
  const worst = incidents[0]?.impact ?? 'none';
  const indicator = want.length || v.indicator === 'none' ? worst : v.indicator;
  const description = typeof v.description === 'string' ? v.description : '';
  return { indicator, description, incidents, stale: j.stale };
}

function render(ctx: RenderContext, item: WidgetItem): WidgetResult {
  const s = serviceState(ctx, item);
  if (!s) return null;
  const ascii = ctx.config.charset === 'text';
  if (s.indicator === 'none') {
    if (s.stale || !opt(item, 'showOk', false)) return null;
    return { text: ascii ? t('widget.status.okText') : t('widget.status.ok'), color: COLOR.none };
  }
  let text = `${ascii ? '!' : '⚠'} ${t(`widget.status.level.${s.indicator}`)}`;
  if (opt(item, 'showName', true)) {
    const max = Math.max(1, Math.floor(opt(item, 'maxLength', 40)));
    const name = s.incidents[0]?.name || s.description;
    if (name) text += `: ${truncate(name, max)}`;
    if (s.incidents.length > 1) text += ` +${s.incidents.length - 1}`;
  }
  if (s.stale) text += ' ?';
  return { text, color: COLOR[s.indicator] };
}

export const widgets: WidgetDef[] = [
  {
    type: 'service-status',
    timeBased: true,
    hideWhenEmpty: true,
    name: 'Service status',
    category: 'system',
    description: 'Claude status page indicator and the active incident, checked in the background',
    color: 'yellow',
    sample: '⚠ major: Elevated errors on Opus +1',
    options: [
      {
        key: 'interval',
        label: 'Check every (seconds)',
        kind: 'number',
        default: 180,
        help: 'Seconds between checks, 120 to 600',
      },
      {
        key: 'components',
        label: 'Components',
        kind: 'text',
        default: '',
        help: 'Only count incidents on these components, comma-separated, for example Claude Code, API',
      },
      {
        key: 'showName',
        label: 'Show incident name',
        kind: 'boolean',
        default: true,
        help: 'Off shows only the indicator, for example ⚠ major',
      },
      {
        key: 'showOk',
        label: 'Show when all is well',
        kind: 'boolean',
        default: false,
        help: 'Shows ✓ Claude OK instead of hiding the widget',
      },
      {
        key: 'maxLength',
        label: 'Max name length',
        kind: 'number',
        default: 40,
        help: 'Longer incident names are cut with …',
      },
    ],
    render,
  },
];
