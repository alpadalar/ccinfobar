#!/usr/bin/env node
import module from 'node:module';
import { retryOnce } from './cli/retry.js';
import { silence } from './cli/silence.js';
import { noCwdLookup } from './cli/win-env.js';

module.enableCompileCache?.();
noCwdLookup(process.env, process.platform);
const argv = process.argv;
// `hook ...` or `[--flags] [--config <f>] hook <Event>`
const pre = argv.slice(2, -2);
const isHook =
  argv[2] === 'hook' ||
  (argv.length >= 4 &&
    argv[argv.length - 2] === 'hook' &&
    /^[A-Z][A-Za-z]+$/.test(argv[argv.length - 1] ?? '') &&
    pre.every((a, i) => a.startsWith('--') || pre[i - 1] === '--config'));
const isSubagent =
  argv[2] === 'subagent-line' ||
  (argv.length >= 4 &&
    argv[argv.length - 1] === 'subagent-line' &&
    argv.slice(2, -1).every((a, i, arr) => a.startsWith('--') || arr[i - 1] === '--config'));

if (isHook) {
  // silent before any import
  silence();
  const bye = () => process.exit(0);
  import('./cli/hook.js').then((m) => m.hookMain(argv.slice(2)), bye).catch(bye);
} else if (isSubagent) {
  // subagent rows: stdout is NDJSON, never a help text
  const bye = () => process.exit(0);
  process.on('uncaughtException', bye);
  process.on('unhandledRejection', bye);
  import('./cli/subagent-line.js').then((m) => m.subagentMain(argv.slice(2)), bye).catch(bye);
} else {
  const { main } = await retryOnce(() => import('./cli.js'));

  main().catch((err: unknown) => {
    if (process.stdin.isTTY) console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
