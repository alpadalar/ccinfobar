import { resolveGlyphMode } from '../core/glyphs.js';
import { t } from '../core/i18n/index.js';
import { metricGetter } from '../core/metrics.js';
import type { RenderContext, WidgetDef } from '../core/types.js';
import { truncate } from '../core/width.js';
import { trustedTurn } from '../data/live.js';
import { opt } from './shared.js';

export type Mood = 'happy' | 'busy' | 'tired' | 'full' | 'asleep';

interface Frames {
  unicode: readonly string[];
  text: readonly string[];
}

type MoodSet = Record<Mood, Frames>;

const ASLEEP_MS = 30 * 60_000;
const FRAME_MS = 60_000;
const QUIP_MS = 30 * 60_000;

export const PETS: Record<'cat' | 'blob' | 'ghost', MoodSet> = {
  cat: {
    happy: { unicode: ['=(^·^)=', '=(^o^)='], text: ['=(^.^)=', '=(^o^)='] },
    busy: { unicode: ['=(°·°)=', '=(º·º)='], text: ['=(o.o)=', '=(O.O)='] },
    tired: { unicode: ['=(¬·¬)=', '=(-·-)='], text: ['=(-.-)=', '=(~.~)='] },
    full: { unicode: ['=(×·×)=', '=(ò·ó)='], text: ['=(x.x)=', '=(>.<)='] },
    asleep: { unicode: ['=(-·-)=z', '=(-·-)=Z'], text: ['=(-.-)=z', '=(-.-)=Z'] },
  },
  blob: {
    happy: { unicode: ['(·u·)', '(ºuº)'], text: ['(^u^)', '(^_^)'] },
    busy: { unicode: ['(°o°)', '(°O°)'], text: ['(o_o)', '(O_O)'] },
    tired: { unicode: ['(¬_¬)', '(-_-)'], text: ['(-_-)', '(~_~)'] },
    full: { unicode: ['(×_×)', '(ò_ó)'], text: ['(x_x)', '(>_<)'] },
    asleep: { unicode: ['(-.-)z', '(-.-)Z'], text: ['(-.-)z', '(-.-)Z'] },
  },
  ghost: {
    happy: { unicode: ['{°u°}~', '~{°u°}'], text: ['{^o^}~', '~{^o^}'] },
    busy: { unicode: ['{ºOº}~', '~{ºOº}'], text: ['{oOo}~', '~{oOo}'] },
    tired: { unicode: ['{¬_¬}~', '~{¬_¬}'], text: ['{-_-}~', '~{-_-}'] },
    full: { unicode: ['{×_×}~', '~{×_×}'], text: ['{x_x}~', '~{x_x}'] },
    asleep: { unicode: ['{-.-}z', '{-.-}Z'], text: ['{-.-}z', '{-.-}Z'] },
  },
};

export const FACES: Record<'cheerful' | 'grumpy' | 'stoic', MoodSet> = {
  cheerful: {
    happy: { unicode: ['(^_^)', '\\(^o^)/', '(ºuº)'], text: ['(^_^)', '\\(^o^)/', '(^u^)'] },
    busy: { unicode: ['(°o°)!', '(^_^)b', '(ºoº)'], text: ['(o_o)!', '(^_^)b', '(^o^)'] },
    tired: { unicode: ['(^_^;)', '(-_^)', '(·_·)'], text: ['(^_^;)', '(-_^)', '(._.)'] },
    full: { unicode: ['(ò_ó)', '(>_<)', '(°_°;)'], text: ['(>_<)', '(@_@)', '(o_o;)'] },
    asleep: { unicode: ['(-_-)zz', '(u_u)', '(-.-)zZ'], text: ['(-_-)zz', '(u_u)', '(-.-)zZ'] },
  },
  grumpy: {
    happy: { unicode: ['(¬_¬)', '(-_-)', "(-_-)'"], text: ['(-_-)', "(-_-)'", '(~_~)'] },
    busy: { unicode: ['(ò_ó)', '(>_>)', '(¬_¬)7'], text: ['(>_<)', '(>_>)', '(-_-)7'] },
    tired: { unicode: ['(-_-#)', '(×_×)', '(¬_¬;)'], text: ['(-_-#)', '(x_x)', '(-_-;)'] },
    full: { unicode: ['(ò_ó)#', '(>_<)#', '(×_×)#'], text: ['(>_<)#', '(#_#)', '(x_x)#'] },
    asleep: { unicode: ['(-_-)zz', '(¬_¬)zz', '(u_u)'], text: ['(-_-)zz', '(~_~)zz', '(u_u)'] },
  },
  stoic: {
    happy: { unicode: ['(·_·)', '(-_-)', '(._.)'], text: ['(._.)', '(-_-)', '(o_o)'] },
    busy: { unicode: ['(·_·)>', '(°_°)', '(o_o)'], text: ['(._.)>', '(o_o)', '(O_O)'] },
    tired: { unicode: ['(-_·)', '(-_-)', '(¯_¯)'], text: ['(-_.)', '(-_-)', '(=_=)'] },
    full: { unicode: ['(·_·;)', '(°_°;)', '(o_o;)'], text: ['(._.;)', '(o_o;)', '(O_O;)'] },
    asleep: { unicode: ['(-_-)z', '(-.-)z', '(u_u)'], text: ['(-_-)z', '(-.-)z', '(u_u)'] },
  },
};

const QUIP_TIERS = {
  context: ['calm', 'warm', 'hot', 'full'],
  usage: ['fresh', 'steady', 'tight', 'limit'],
} as const;

type Basis = keyof typeof QUIP_TIERS;
type QuipKey = {
  [B in Basis]: `fun.quip.${B}.${(typeof QUIP_TIERS)[B][number]}.${0 | 1 | 2}`;
}[Basis];

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function pick<T>(list: readonly T[], ctx: RenderContext, tier: string, bucketMs: number): T {
  const key = `${ctx.payload.session_id ?? ''}|${tier}|${Math.floor(ctx.now.getTime() / bucketMs)}`;
  return list[fnv1a(key) % list.length]!;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function running(ctx: RenderContext, now: number): boolean {
  const tr = ctx.data.transcript();
  const turn = trustedTurn(ctx.data.hooks?.() ?? null, tr, ctx.payload.prompt_id, now);
  if (turn && turn.end === null) return true;
  const last = tr?.lastAssistantAt ?? null;
  const start = tr?.turnStart ?? null;
  return num(start) && (last === null || start > last);
}

export function moodTier(ctx: RenderContext): Mood | null {
  const get = metricGetter(ctx);
  const context = get('context.pct');
  const tr = ctx.data.transcript();
  if (!num(context) && !tr) return null;
  const now = ctx.now.getTime();
  const last = tr?.lastAssistantAt;
  // a new turn after a long idle is not asleep (IN-07)
  if (num(last) && now - last > ASLEEP_MS && !running(ctx, now)) return 'asleep';
  if (num(context) && context >= 90) return 'full';
  const usage = get('usage.5h');
  if (num(usage) && usage >= 80) return 'tired';
  return running(ctx, now) ? 'busy' : 'happy';
}

function ascii(ctx: RenderContext): boolean {
  return ctx.config.charset === 'text' || resolveGlyphMode(ctx.config, ctx.env) === 'paste-safe';
}

function frame<K extends string>(ctx: RenderContext, sets: Record<K, MoodSet>, key: K): string | null {
  const mood = moodTier(ctx);
  if (!mood) return null;
  const f = sets[key][mood];
  return pick(ascii(ctx) ? f.text : f.unicode, ctx, mood, FRAME_MS);
}

function quipTier(basis: Basis, v: number): number {
  const [a, b, c] = basis === 'context' ? [50, 80, 90] : [50, 80, 95];
  return v >= c ? 3 : v >= b ? 2 : v >= a ? 1 : 0;
}

export const widgets: WidgetDef[] = [
  {
    type: 'pet',
    name: 'Pet',
    category: 'fun',
    description: 'A small creature that reacts to context, 5h usage and idle time',
    color: 'magenta',
    sample: '=(°·°)=',
    timeBased: true,
    options: [
      {
        key: 'species',
        label: 'Species',
        kind: 'select',
        default: 'cat',
        choices: [
          { value: 'cat', label: 'Cat' },
          { value: 'blob', label: 'Blob' },
          { value: 'ghost', label: 'Ghost' },
        ],
      },
    ],
    render(ctx, item) {
      const s = opt(item, 'species', 'cat');
      return frame(ctx, PETS, Object.hasOwn(PETS, s) ? (s as keyof typeof PETS) : 'cat');
    },
  },
  {
    type: 'kaomoji',
    name: 'Kaomoji',
    category: 'fun',
    description: 'A face for the mood: happy, busy, tired, full or asleep',
    color: 'yellow',
    sample: '(°o°)!',
    timeBased: true,
    options: [
      {
        key: 'personality',
        label: 'Personality',
        kind: 'select',
        default: 'cheerful',
        choices: [
          { value: 'cheerful', label: 'Cheerful' },
          { value: 'grumpy', label: 'Grumpy' },
          { value: 'stoic', label: 'Stoic' },
        ],
      },
    ],
    render(ctx, item) {
      const p = opt(item, 'personality', 'cheerful');
      return frame(ctx, FACES, Object.hasOwn(FACES, p) ? (p as keyof typeof FACES) : 'cheerful');
    },
  },
  {
    type: 'quip',
    name: 'Quip',
    category: 'fun',
    description: 'A short line for the context or 5h usage level, new every 30 minutes',
    color: 'cyan',
    sample: 'Plenty of room to think',
    options: [
      {
        key: 'basis',
        label: 'Based on',
        kind: 'select',
        default: 'context',
        choices: [
          { value: 'context', label: 'Context window' },
          { value: 'usage', label: '5h usage' },
        ],
      },
      { key: 'maxLength', label: 'Max length', kind: 'number', default: 32, help: 'Longer lines are cut' },
    ],
    render(ctx, item) {
      const basis: Basis = opt<string>(item, 'basis', 'context') === 'usage' ? 'usage' : 'context';
      const v = metricGetter(ctx)(basis === 'usage' ? 'usage.5h' : 'context.pct');
      if (!num(v)) return null;
      const tier = QUIP_TIERS[basis][quipTier(basis, v)]!;
      const n = pick([0, 1, 2] as const, ctx, `${basis}.${tier}`, QUIP_MS);
      const text = t(`fun.quip.${basis}.${tier}.${n}` as QuipKey);
      const max = Math.max(4, Math.floor(Number(opt(item, 'maxLength', 32)) || 32));
      return truncate(text, max, ascii(ctx) ? '.' : '…');
    },
  },
];
