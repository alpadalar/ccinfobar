import { importMessages } from './import.js';
import { reportMessages } from './report.js';
import { tomlMessages } from './toml.js';

// report, import and TOML text, loaded only by the commands that print it
export const lazyMessages = {
  ...reportMessages,
  ...tomlMessages,
  ...importMessages,
} as const;
