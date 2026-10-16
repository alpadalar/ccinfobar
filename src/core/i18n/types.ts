import type { MessageId } from './index.js';

export type Plural = { one: string; other: string };
export type Message = string | Plural;
export type Params = Record<string, string | number>;
export interface OptionMeta {
  label?: string;
  help?: string;
  choices?: Record<string, string>;
}

export interface WidgetMeta {
  name: string;
  description: string;
  label?: string;
  hint?: string;
  sample?: string;
  options?: Record<string, OptionMeta>;
}

export interface MetaFile {
  widgets: Record<string, WidgetMeta>;
  options?: Record<string, string>;
}

export interface CatalogMeta {
  themes?: Record<string, { description: string }>;
  styles?: Record<string, { name: string; description: string }>;
  presets?: Record<string, { name: string; description: string }>;
  scenarios?: Record<string, { label: string; description: string }>;
  styleGroups?: Record<string, string>;
}

export interface MetaTable {
  widgets: Record<string, WidgetMeta>;
  options: Record<string, string>;
  categories: Record<string, string>;
  catalog: CatalogMeta;
}

export interface LanguageDef {
  id: string;
  name: string;
  aliases: readonly string[];
  locale: string;
  messages: Partial<Record<MessageId, Message>>;
  meta?: MetaTable;
  // command-only areas, installed by i18n/lazy.ts
  lazy?: Partial<Record<MessageId, Message>>;
}

export interface LanguageTables {
  messages: LanguageDef['messages'];
  meta?: MetaTable;
}
