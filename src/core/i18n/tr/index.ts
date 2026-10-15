import { benchMessages } from './bench.js';
import { configMessages } from './config.js';
import { displayMessages } from './display.js';
import { doctorMessages } from './doctor.js';
import { explainMessages } from './explain.js';
import { hookMessages } from './hooks.js';
import { installMessages } from './install.js';
import { jobsMessages } from './jobs.js';
import { previewMessages } from './preview.js';

export const tr = {
  ...installMessages,
  ...configMessages,
  ...doctorMessages,
  ...explainMessages,
  ...previewMessages,
  ...benchMessages,
  ...hookMessages,
  ...jobsMessages,
  ...displayMessages,
} as const;
