export const cliMessages = {
  'cli.unknownCommand': 'Unknown command "{command}". Run ccinfobar --help.',
  'cli.invalidJson': 'ccinfobar: invalid JSON on stdin',
  'cli.edit.notCode':
    'That is not a share code. Use --port <n> to pick a port and --open to open the browser; make a code with ccinfobar share',
  'cli.badInt': '{flag} needs a whole number from {min} to {max}',
} as const;
