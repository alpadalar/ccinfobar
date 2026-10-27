import { spawn } from 'node:child_process';
import { safeCwd } from '../data/jobs/runner.js';

export function openBrowser(
  url: string,
  deps: { platform?: NodeJS.Platform; spawn?: typeof spawn } = {},
): void {
  const platform = deps.platform ?? process.platform;
  const run = deps.spawn ?? spawn;
  try {
    let child: ReturnType<typeof spawn>;
    if (platform === 'darwin') {
      child = run('open', [url], { detached: true, stdio: 'ignore' });
    } else if (platform === 'win32') {
      child = run('cmd', ['/c', 'start', '""', `"${url.replace(/&/g, '^&')}"`], {
        detached: true,
        stdio: 'ignore',
        cwd: safeCwd(),
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } else {
      child = run('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
  } catch {}
}
