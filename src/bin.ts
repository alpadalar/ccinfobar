#!/usr/bin/env node
import module from 'node:module';

module.enableCompileCache?.();
const argv = process.argv;
// only `[--flags] [--config <f>] hook <Event>`
const pre = argv.slice(2, -2);
const isHook =
  argv.length >= 4 &&
  argv[argv.length - 2] === 'hook' &&
  /^[A-Z][A-Za-z]+$/.test(argv[argv.length - 1] ?? '') &&
  pre.every((a, i) => a.startsWith('--') || pre[i - 1] === '--config');

if (isHook) {
  // silent before any import
  const noop = (() => true) as typeof process.stdout.write;
  process.stdout.write = noop;
  process.stderr.write = noop;
  process.removeAllListeners('warning');
  const bye = () => process.exit(0);
  process.on('uncaughtException', bye);
  process.on('unhandledRejection', bye);
  setTimeout(bye, 2000);
  import('./cli/hook.js').then((m) => m.hookMain(argv.slice(2)), bye).catch(bye);
} else {
  const { main } = await import('./cli.js');

  main().catch((err: unknown) => {
    if (process.stdin.isTTY) console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
