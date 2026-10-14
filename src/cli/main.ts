import path from 'node:path';
import { configPath } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { parseArgs } from './args.js';
import { runRender } from './render.js';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const cfgFile = typeof args.flags.config === 'string' ? path.resolve(args.flags.config) : configPath();

  if (args.flags.version) {
    console.log(VERSION);
    return;
  }
  if (args.flags.help || args.command === 'help') {
    process.stdout.write((await import('./help.js')).HELP);
    return;
  }

  switch (args.command) {
    case null: {
      if (process.stdin.isTTY && typeof args.flags.payload !== 'string') {
        process.stdout.write((await import('./help.js')).HELP);
        return;
      }
      await runRender(args, cfgFile);
      return;
    }
    case 'edit':
    case 'editor': {
      const { startEditor } = await import('../editor/server.js');
      const { queryTerminalColors } = await import('../editor/terminal-colors.js');
      const port = typeof args.flags.port === 'string' ? Number(args.flags.port) : undefined;
      const terminal = args.flags.detect === false ? null : await queryTerminalColors();
      await startEditor({ configPath: cfgFile, port, open: args.flags.open !== false, terminal });
      return;
    }
    case 'tui': {
      const { runTui } = await import('../tui/index.js');
      await runTui({ configPath: cfgFile });
      return;
    }
    case 'install': {
      const { runInstall } = await import('../commands/install-cli.js');
      await runInstall(args, cfgFile);
      return;
    }
    case 'import': {
      const { runImportCommand } = await import('../commands/manage.js');
      runImportCommand(args, cfgFile);
      return;
    }
    case 'uninstall': {
      const { runUninstall } = await import('../commands/install-cli.js');
      await runUninstall(args, cfgFile);
      return;
    }
    case 'init': {
      const { runInit } = await import('../commands/manage.js');
      runInit(args, cfgFile);
      return;
    }
    case 'preview': {
      const { runPreview } = await import('../commands/manage.js');
      runPreview(args, cfgFile);
      return;
    }
    case 'themes': {
      const { runThemes } = await import('../commands/manage.js');
      runThemes(args, cfgFile);
      return;
    }
    case 'theme': {
      const { runTheme } = await import('../commands/manage.js');
      runTheme(args, cfgFile);
      return;
    }
    case 'widgets': {
      const { runWidgets } = await import('../commands/manage.js');
      runWidgets(args, cfgFile);
      return;
    }
    case 'update': {
      const { runUpdate } = await import('../commands/update.js');
      await runUpdate(args, cfgFile);
      return;
    }
    case 'usage': {
      const { runUsage } = await import('../commands/manage.js');
      await runUsage(args, cfgFile);
      return;
    }
    case 'config': {
      const { runConfig } = await import('../commands/config-cmd.js');
      runConfig(args, cfgFile);
      return;
    }
    case 'doctor': {
      const { runDoctor } = await import('../commands/doctor.js');
      runDoctor(cfgFile);
      return;
    }
    case 'explain': {
      const { runExplain } = await import('../commands/explain.js');
      runExplain(args, cfgFile);
      return;
    }
    case 'bench': {
      const { runBenchCommand } = await import('../commands/bench.js');
      runBenchCommand(args, cfgFile);
      return;
    }
    default:
      console.error(`Unknown command "${args.command}". Run ccinfobar --help.`);
      process.exitCode = 1;
  }
}
