import { benchMessages } from './bench.js';
import { configMessages } from './config.js';
import { doctorMessages } from './doctor.js';
import { explainMessages } from './explain.js';
import { installMessages } from './install.js';
import { previewMessages } from './preview.js';
import { widgetMessages } from './widgets.js';

export const en = {
  ...installMessages,
  ...configMessages,
  ...doctorMessages,
  ...explainMessages,
  ...previewMessages,
  ...benchMessages,
  ...widgetMessages,
} as const;
