import { en } from './en/index.js';

export type MessageId = keyof typeof en;

export function t(id: MessageId, params?: Record<string, string | number>): string {
  const text: string = en[id];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(params, k) ? String(params[k]) : m));
}
