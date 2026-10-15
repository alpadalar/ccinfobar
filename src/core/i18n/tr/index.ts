import { benchMessages } from './bench.js';
import { configMessages } from './config.js';
import { doctorMessages } from './doctor.js';
import { hookMessages } from './hooks.js';
import { installMessages } from './install.js';
import { jobsMessages } from './jobs.js';
import { previewMessages } from './preview.js';

export const tr = {
  ...installMessages,
  ...configMessages,
  ...doctorMessages,
  ...previewMessages,
  ...benchMessages,
  ...hookMessages,
  ...jobsMessages,
} as const;
