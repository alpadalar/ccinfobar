#!/usr/bin/env node
import { main } from './cli.js';

main().catch((err: unknown) => {
  if (process.stdin.isTTY) console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
