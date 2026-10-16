import { catalogMessages } from './catalog.js';
import { importMessages } from './import.js';
import { reportMessages } from './report.js';
import { tomlMessages } from './toml.js';

// report, import, TOML and catalog text, loaded only where it is shown
export const lazyMessages = {
  ...reportMessages,
  ...tomlMessages,
  ...importMessages,
  ...catalogMessages,
} as const;
