#!/usr/bin/env node
import module from 'node:module';

module.enableCompileCache?.();
const { main } = await import('./cli.js');

main().catch((err: unknown) => {
  if (process.stdin.isTTY) console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
