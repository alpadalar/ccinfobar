import { benchMessages } from './bench.js';
import { cliMessages } from './cli.js';
import { commandsMessages } from './commands.js';
import { configMessages } from './config.js';
import { displayMessages } from './display.js';
import { doctorMessages } from './doctor.js';
import { editorMessages } from './editor.js';
import { errorMessages } from './errors.js';
import { explainMessages } from './explain.js';
import { funMessages } from './fun.js';
import { hookMessages } from './hooks.js';
import { inspectorMessages } from './inspector.js';
import { installMessages } from './install.js';
import { jobsMessages } from './jobs.js';
import { previewMessages } from './preview.js';
import { widgetMessages } from './widgets.js';

export const tr = {
  ...installMessages,
  ...configMessages,
  ...doctorMessages,
  ...explainMessages,
  ...previewMessages,
  ...benchMessages,
  ...widgetMessages,
  ...hookMessages,
  ...jobsMessages,
  ...displayMessages,
  ...funMessages,
  ...cliMessages,
  ...commandsMessages,
  ...errorMessages,
  ...inspectorMessages,
  ...editorMessages,
} as const;
