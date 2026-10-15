import { execFile } from 'node:child_process';
import type { ExecFileLike } from './runner.js';

// a leaf: loaded only by the worker, it imports no render module
export const defaultExecFile: ExecFileLike = (file, args, opts) =>
  new Promise((resolve) => {
    try {
      const child = execFile(
        file,
        args,
        {
          timeout: opts.timeout,
          env: opts.env,
          maxBuffer: opts.maxBuffer,
          windowsHide: true,
          encoding: 'utf8',
          // Windows looks up gh in the cwd first; callers pass safeCwd()
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (e, stdout, stderr) => {
          const code = (e as NodeJS.ErrnoException | null)?.code as unknown;
          resolve({
            code: e ? (typeof code === 'number' ? code : null) : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            ...(typeof code === 'string' ? { errno: code } : {}),
          });
        },
      );
      child.stdin?.end();
    } catch {
      resolve({ code: null, stdout: '', stderr: '', errno: 'spawn' });
    }
  });
