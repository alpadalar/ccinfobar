import type { MessageId } from './index.js';

export type Plural = { one: string; other: string };
export type Message = string | Plural;
export type Params = Record<string, string | number>;
export type MetaTable = Record<string, unknown>;

export interface LanguageDef {
  id: string;
  name: string;
  aliases: readonly string[];
  locale: string;
  messages: Partial<Record<MessageId, Message>>;
  meta?: MetaTable;
}
