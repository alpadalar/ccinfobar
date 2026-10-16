import { catalogMessages } from './catalog.js';
import { importMessages } from './import.js';
import { reportMessages } from './report.js';
import { tomlMessages } from './toml.js';

export const lazyMessages = {
  ...reportMessages,
  ...tomlMessages,
  ...importMessages,
  ...catalogMessages,
} as const;
