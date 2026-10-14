export interface Args {
  command: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = ['config', 'payload', 'width', 'refresh', 'command', 'port', 'from', 'file'];

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      args.positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h') args.flags.help = true;
    else if (a === '-v') args.flags.version = true;
    else if (a === '-y') args.flags.yes = true;
    else if (a.startsWith('--no-')) args.flags[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      const next = argv[i + 1];
      if (inline !== undefined) args.flags[k] = inline;
      else if (next !== undefined && !next.startsWith('-') && VALUE_FLAGS.includes(k)) {
        args.flags[k] = next;
        i++;
      } else args.flags[k] = true;
    } else if (!args.command) args.command = a;
    else args.positional.push(a);
  }
  return args;
}
