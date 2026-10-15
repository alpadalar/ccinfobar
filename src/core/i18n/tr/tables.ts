import type { LanguageTables } from '../types.js';
import { tr } from './index.js';
import { trMeta } from './meta/index.js';

export const tables: LanguageTables = { messages: tr, meta: trMeta };
