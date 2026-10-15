import { execFileSync } from 'node:child_process';
import { fs } from '../core/builtins.js';
import { terminalAllowed } from '../data/progress.js';

export const TTY_RE = /^\/dev\/(pts\/\d+|tty[A-Za-z0-9]+)$/;

export interface TtyDeps {
  platform: NodeJS.Platform;
  ppid: number;
  readlink(p: string): string;
  readFile(p: string): string;
  exec(file: string, argv: string[]): string;
  stat(p: string): { isCharacterDevice(): boolean };
  open(p: string, flags: number): number;
  write(fd: number, s: string): void;
  close(fd: number): void;
}

export const ttyDeps = (): TtyDeps => ({
  platform: process.platform,
  ppid: process.ppid,
  readlink: (p) => fs.readlinkSync(p),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  exec: (file, argv) =>
    execFileSync(file, argv, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
      windowsHide: true,
    }),
  stat: (p) => fs.statSync(p),
  open: (p, flags) => fs.openSync(p, flags),
  write: (fd, s) => {
    fs.writeSync(fd, s);
  },
  close: (fd) => fs.closeSync(fd),
});

const validPid = (n: number): boolean => Number.isInteger(n) && n > 1;

// field 4 of /proc/<pid>/stat; comm may hold spaces or parens
function parentOf(d: TtyDeps, pid: number): number {
  const stat = d.readFile(`/proc/${pid}/stat`);
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(rest[1]);
}

export function parentTty(d: TtyDeps): string | null {
  try {
    if (!validPid(d.ppid)) return null;
    if (d.platform === 'linux') {
      let pid = d.ppid;
      for (let i = 0; i < 3 && validPid(pid); i++) {
        let link = '';
        try {
          link = d.readlink(`/proc/${pid}/fd/0`);
        } catch {}
        if (TTY_RE.test(link)) return link;
        if (i < 2) pid = parentOf(d, pid);
      }
      return null;
    }
    if (d.platform === 'darwin') {
      const dev = `/dev/${d.exec('ps', ['-o', 'tty=', '-p', String(d.ppid)]).trim()}`;
      return TTY_RE.test(dev) ? dev : null;
    }
  } catch {}
  return null;
}

export function tmuxWrap(seq: string): string {
  return `\x1bPtmux;${seq.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

export function writeTty(
  seq: string,
  env: NodeJS.ProcessEnv,
  opts: { tmuxPassthrough: boolean; always: boolean },
  d: TtyDeps = ttyDeps(),
): boolean {
  try {
    if (d.platform === 'win32') return false;
    if (!terminalAllowed(env, opts.always)) return false;
    if (env.TMUX && !opts.tmuxPassthrough) return false;
    const dev = parentTty(d);
    if (!dev || !d.stat(dev).isCharacterDevice()) return false;
    const c = fs.constants;
    const fd = d.open(dev, (c.O_WRONLY ?? 0) | (c.O_NOCTTY ?? 0) | (c.O_NONBLOCK ?? 0));
    try {
      d.write(fd, env.TMUX ? tmuxWrap(seq) : seq);
    } finally {
      d.close(fd);
    }
    return true;
  } catch {
    return false;
  }
}
