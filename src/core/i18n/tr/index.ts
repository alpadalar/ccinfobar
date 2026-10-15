import { configMessages } from './config.js';
import { installMessages } from './install.js';

export const tr = {
  ...installMessages,
  ...configMessages,
} as const;
