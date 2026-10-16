import { importMessages } from './import.js';
import { reportMessages } from './report.js';
import { tomlMessages } from './toml.js';

export const lazyMessages = {
  ...reportMessages,
  ...tomlMessages,
  ...importMessages,
} as const;
