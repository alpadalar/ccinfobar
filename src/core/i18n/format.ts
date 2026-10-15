const formats = new Map<string, Intl.DateTimeFormat>();

const MONTH_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: 'short' };
const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
};

function formatter(locale: string, kind: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${kind}`;
  let f = formats.get(key);
  if (!f) {
    const o = { ...opts, timeZone: 'UTC' };
    try {
      f = new Intl.DateTimeFormat(locale, o);
    } catch {
      f = new Intl.DateTimeFormat('en', o);
    }
    formats.set(key, f);
  }
  return f;
}

// local wall time as UTC, so cached formatters follow TZ changes
function wall(d: Date): Date {
  return new Date(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()),
  );
}

function format(d: Date, locale: string, kind: string, opts: Intl.DateTimeFormatOptions): string {
  if (Number.isNaN(d.getTime())) return '';
  return formatter(locale, kind, opts).format(wall(d));
}

export function formatMonthDay(d: Date, locale: string): string {
  return format(d, locale, 'md', MONTH_DAY);
}

export function formatWeekday(d: Date, locale: string): string {
  return format(d, locale, 'wd', WEEKDAY);
}

export function formatDateTime(d: Date, locale: string): string {
  return format(d, locale, 'dt', DATE_TIME);
}

function lower(s: string, locale: string): string {
  try {
    return s.toLocaleLowerCase(locale);
  } catch {
    return s.toLowerCase();
  }
}

export function foldSearch(s: string, locale: string): string {
  return lower(s, locale).normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
}

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
