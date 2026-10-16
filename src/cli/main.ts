import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { t } from '../core/i18n/index.js';
import { loadLanguages } from '../core/i18n/languages.js';
import { configPath } from '../core/paths.js';
import { globMatch, PROFILES } from '../core/profiles.js';
import type { ReportDeps } from '../core/report-types.js';
import { JOBS } from '../data/jobs/index.js';
import { ledgerDir, monthFiles, rebuildSummary, stepText } from '../data/ledger.js';
import { accountKeysForDir } from '../data/limits.js';
import { type Args, parseArgs } from './args.js';
import { applyLanguage, configLanguage, prepareLanguage } from './lang.js';
import { runRender } from './render.js';

// own copy: importing core/version.ts costs the render one more chunk
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

// report code reaches no render chunk of its own
function reportDeps(): ReportDeps {
  return {
    loadConfig,
    applyLanguage,
    ledgerDir,
    monthFiles,
    stepText,
    rebuildSummary,
    accountKeysForDir,
    profiles: { vendors: PROFILES, globMatch },
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  // the render, hooks and the worker load only what they show
  const command = args.command !== null && args.command !== 'hook' && args.command !== 'worker';
  if (command) await loadLanguages();
  else if (args.flags.help) await prepareLanguage();
  const cfgFile = typeof args.flags.config === 'string' ? path.resolve(args.flags.config) : configPath();
  // help follows the env (D-36)
  const help = args.flags.help || args.command === 'help';
  applyLanguage(command && !help ? configLanguage(cfgFile) : undefined);

  if (args.flags.version) {
    console.log(VERSION);
    return;
  }
  if (args.flags.help || args.command === 'help') {
    process.stdout.write((await import('./help.js')).help());
    return;
  }

  try {
    await run(args, cfgFile, argv);
  } catch (err) {
    // bin.ts stays quiet without a tty; a command must say why it failed
    if (args.command === null) throw err;
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function run(args: Args, cfgFile: string, argv: string[]): Promise<void> {
  switch (args.command) {
    case null: {
      if (process.stdin.isTTY && typeof args.flags.payload !== 'string') {
        await prepareLanguage();
        process.stdout.write((await import('./help.js')).help());
        return;
      }
      await runRender(args, cfgFile);
      return;
    }
    case 'edit':
    case 'editor': {
      const port = typeof args.flags.port === 'string' ? Number(args.flags.port) : undefined;
      if (args.flags.detach === true) {
        const { runDetach } = await import('../editor/detach.js');
        process.exitCode = await runDetach({ configPath: cfgFile, port, open: args.flags.open !== false });
        return;
      }
      const { startEditor } = await import('../editor/server.js');
      if (args.flags['serve-detached'] === true) {
        const { editorStateFile } = await import('../editor/detach.js');
        const detached = { idleMs: 30 * 60_000, stateFile: editorStateFile() };
        await startEditor({ configPath: cfgFile, port, open: false, terminal: null, detached });
        return;
      }
      const { queryTerminalColors } = await import('../editor/terminal-colors.js');
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
      await runImportCommand(args, cfgFile);
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
    case 'repos': {
      const { runRepos } = await import('../commands/repos.js');
      await runRepos(args, cfgFile, JOBS);
      return;
    }
    case 'worker': {
      const { runWorker } = await import('../commands/worker.js');
      await runWorker(args, cfgFile, { jobs: JOBS });
      return;
    }
    case 'usage': {
      const { runUsage } = await import('../commands/manage.js');
      await runUsage(args, cfgFile, JOBS);
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
    case 'hook': {
      const { hookMain } = await import('./hook.js');
      await hookMain(argv);
      return;
    }
    case 'report': {
      const { runReport } = await import('../commands/report.js');
      runReport(args, cfgFile, reportDeps());
      return;
    }
    case 'catalog': {
      const { runCatalog } = await import('../commands/catalog.js');
      await runCatalog(args, cfgFile);
      return;
    }
    case 'bench': {
      const { runBenchCommand } = await import('../commands/bench.js');
      runBenchCommand(args, cfgFile);
      return;
    }
    default:
      console.error(t('cli.unknownCommand', { command: args.command }));
      process.exitCode = 1;
  }
}
