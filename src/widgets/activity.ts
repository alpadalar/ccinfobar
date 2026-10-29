import type { WidgetDef } from '../core/types.js';
import { SLOT_MS, slotKey } from '../data/ledger.js';
import { fillOption, opt, SPARK, SPARK_ASCII } from './shared.js';

type Size = 15 | 30 | 60;
const SIZES: readonly number[] = [15, 30, 60];

const localOffset = (ms: number) => -new Date(ms).getTimezoneOffset();

export function groupSlots(
  slots: Record<number, number>,
  now: number,
  count: number,
  size: Size,
  offsetMin: (ms: number) => number = localOffset,
): number[] {
  const gid = (k: number) => Math.floor((k * 15 + offsetMin(k * SLOT_MS)) / size);
  const per = size / 15;
  const out: number[] = [];
  let k = slotKey(now);
  let g = gid(k);
  let n = 0;
  let sum = 0;
  while (out.length < count) {
    const v = slots[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) sum += v;
    n++;
    k--;
    const next = gid(k);
    // a repeated local hour keeps its group id
    if (next !== g || n >= per) {
      out.push(sum);
      g = next;
      n = 0;
      sum = 0;
    }
  }
  return out.reverse();
}

export const widgets: WidgetDef[] = [
  {
    type: 'activity-strip',
    name: 'Activity strip',
    category: 'charts',
    description: 'When Claude was busy across all your sessions, in 15-minute slots (from the local ledger)',
    label: 'Activity ',
    icon: { nerd: '\u{f0128}', emoji: '\u{1f4ca}' },
    color: 'cyan',
    sample: '··▂▅▇▄···▁▃▆██▅▂·····▃▄▆▅▃▂··▁▄▆▇▄▂▂',
    timeBased: true,
    options: [
      {
        key: 'slots',
        label: 'Slots',
        kind: 'number',
        default: 36,
        help: 'How many cells (4 to 96); 36 cells of 15 minutes is 9 hours',
      },
      {
        key: 'size',
        label: 'Slot size',
        kind: 'select',
        default: '15',
        choices: [
          { value: '15', label: '15 minutes' },
          { value: '30', label: '30 minutes' },
          { value: '60', label: '1 hour' },
        ],
      },
      {
        key: 'show',
        aliases: ['mode'],
        label: 'Mode',
        kind: 'select',
        default: 'intensity',
        choices: [
          { value: 'intensity', label: 'Intensity' },
          { value: 'presence', label: 'Presence' },
        ],
      },
      fillOption,
    ],
    render(ctx, item) {
      const view = ctx.data.ledger?.();
      if (!view) return null;
      const cells = Math.max(4, Math.min(96, Math.floor(opt(item, 'slots', 36))));
      const extra = opt(item, 'fill', false) ? Math.max(0, Math.min(400, ctx.extra ?? 0)) : 0;
      const size = Number(opt(item, 'size', '15'));
      const groups = groupSlots(
        view.slots ?? {},
        ctx.now.getTime(),
        cells + extra,
        (SIZES.includes(size) ? size : 15) as Size,
      );
      const text = ctx.config.charset === 'text';
      if (opt<string>(item, 'show', 'intensity') === 'presence') {
        return groups.map((v) => (v > 0 ? (text ? '#' : '▪') : text ? '.' : '·')).join('');
      }
      const ramp = text ? SPARK_ASCII : SPARK;
      const idle = text ? ' ' : '·';
      const max = Math.max(...groups);
      return groups
        .map((v) => (v > 0 ? ramp[Math.max(0, Math.ceil((v / max) * ramp.length) - 1)]! : idle))
        .join('');
    },
  },
];
