import { execSync } from 'node:child_process';

export interface ExecOptions {
  input: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
}

export function execCommand(command: string, opts: ExecOptions): string | null {
  try {
    return execSync(command, {
      input: opts.input,
      cwd: opts.cwd,
      env: opts.env,
      encoding: 'utf8',
      timeout: Math.max(50, opts.timeout),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (e) {
    // the command exited without reading stdin
    const r = e as { code?: string; status?: number | null; stdout?: unknown };
    if (r.code !== 'EPIPE' || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout;
  }
}
