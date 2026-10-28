import { t } from '../core/i18n/index.js';
import type { Args } from './args.js';

export function intFlag(args: Args, name: string, min: number, max: number): number | undefined {
  const v = args.flags[name];
  if (v === undefined || v === false) return undefined;
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n) && n >= min && n <= max) return n;
  }
  throw new Error(t('cli.badInt', { flag: `--${name}`, min, max }));
}
