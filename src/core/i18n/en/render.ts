import { cliMessages } from './cli.js';
import { configMessages } from './config.js';
import { displayMessages } from './display.js';
import { errorMessages } from './errors.js';
import { funMessages } from './fun.js';
import { updateMessages } from './update.js';
import { widgetMessages } from './widgets.js';

export const renderMessages = {
  ...configMessages,
  ...widgetMessages,
  ...displayMessages,
  ...funMessages,
  ...cliMessages,
  ...errorMessages,
  ...updateMessages,
} as const;
