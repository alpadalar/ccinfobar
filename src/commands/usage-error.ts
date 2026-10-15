import { type MessageId, t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';

// exact texts src/data/usage.ts persists
const KNOWN: Record<string, MessageId> = {
  'no Claude login found': 'cmd.usage.err.noLogin',
  'rate limited by the usage API': 'cmd.usage.err.rateLimited',
  'usage API sent no limits': 'cmd.usage.err.noLimits',
};

export function usageErrorText(error: string): string {
  const id = Object.hasOwn(KNOWN, error) ? KNOWN[error] : undefined;
  if (id) return t(id);
  const status = /^usage API returned (\d{3})$/.exec(error);
  if (status) return t('cmd.usage.err.status', { status: status[1]! });
  return sanitizeText(error);
}
