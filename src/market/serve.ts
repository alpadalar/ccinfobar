import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMarketServer } from './server.js';

export interface ServeArgs {
  dataDir: string;
  port: number;
  host: string;
  allowOverwrite: boolean;
}

const USAGE = 'usage: ccinfobar-market --data <dir> [--port <n>] [--host <h>] [--no-overwrite]';

export function parseServeArgs(argv: string[]): ServeArgs | string {
  const out: ServeArgs = { dataDir: '', port: 8787, host: '127.0.0.1', allowOverwrite: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--no-overwrite') {
      out.allowOverwrite = false;
      continue;
    }
    const v = argv[i + 1];
    if (a !== '--data' && a !== '--port' && a !== '--host') return `unknown option: ${a}`;
    if (v === undefined || v === '' || v.startsWith('--')) return `missing value for ${a}`;
    i++;
    if (a === '--data') out.dataDir = path.resolve(v);
    else if (a === '--host') out.host = v;
    else {
      const n = /^\d{1,5}$/.test(v) ? Number(v) : -1;
      if (n < 0 || n > 65535) return `bad port: ${v}`;
      out.port = n;
    }
  }
  return out.dataDir ? out : 'missing --data <dir>';
}

export async function runServe(
  argv: string[],
  write: (line: string) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const args = parseServeArgs(argv);
  if (typeof args === 'string') throw new Error(args);
  const server = await startMarketServer(args);
  write(`listening on ${server.url}\n`);
  return server;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(`${USAGE}\n`);
  } else {
    runServe(argv, (l) => process.stdout.write(l)).then(
      (server) => {
        const stop = () => void server.close().then(() => process.exit(0));
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      },
      (err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}\n`);
        process.exitCode = 1;
      },
    );
  }
}
