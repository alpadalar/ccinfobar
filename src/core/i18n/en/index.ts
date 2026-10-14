import { configMessages } from './config.js';
import { doctorMessages } from './doctor.js';
import { installMessages } from './install.js';
import { widgetMessages } from './widgets.js';

export const en = {
  ...installMessages,
  ...configMessages,
  ...doctorMessages,
  ...widgetMessages,
} as const;
