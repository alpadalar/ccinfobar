import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { parentTty, TTY_RE, type TtyDeps, tmuxWrap, writeTty } from '../../src/cli/progress-tty.js';
import { runRender } from '../../src/cli/render.js';
import { progressSeq } from '../../src/data/progress.js';

const SEQ = progressSeq(4, 72);
const WT = { WT_SESSION: '1' };
const ON = { tmuxPassthrough: false, always: false };

interface Fake extends TtyDeps {
  calls: string[];
  opened: number[];
  written: string[];
}

function fake(over: Partial<TtyDeps> = {}, links: Record<string, string> = {}): Fake {
  const calls: string[] = [];
  const opened: number[] = [];
  const written: string[] = [];
  const d: Fake = {
    calls,
    opened,
    written,
    platform: 'linux',
    ppid: 100,
    readlink: (p) => {
      calls.push(`readlink ${p}`);
      const v = links[p] ?? (p === '/proc/100/fd/0' ? '/dev/pts/3' : undefined);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    readFile: (p) => {
      calls.push(`readFile ${p}`);
      const pid = Number(p.split('/')[2]);
      return `${pid} (my (odd) comm) S ${pid + 1} 1 1 0`;
    },
    exec: (file, argv) => {
      calls.push(`exec ${file} ${argv.join(' ')}`);
      return 'ttys004\n';
    },
    stat: (p) => {
      calls.push(`stat ${p}`);
      return { isCharacterDevice: () => true };
    },
    open: (p, flags) => {
      calls.push(`open ${p}`);
      opened.push(flags);
      return 7;
    },
    write: (fd, s) => {
      calls.push(`write ${fd}`);
      written.push(s);
    },
    close: (fd) => {
      calls.push(`close ${fd}`);
    },
    ...over,
  };
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('TTY_RE', () => {
  it('accepts terminal devices only', () => {
    for (const ok of ['/dev/pts/3', '/dev/ttys004', '/dev/tty1']) expect(TTY_RE.test(ok), ok).toBe(true);
    for (const bad of [
      '/dev/tty',
      '/dev/pts/x',
      '/home/u/x',
      '/dev/pts/3/../../etc',
      'pipe:[123]',
      '/dev/null',
    ])
      expect(TTY_RE.test(bad), bad).toBe(false);
  });
});

describe('parentTty', () => {
  it('reads the parent stdin link on linux', () => {
    const d = fake();
    expect(parentTty(d)).toBe('/dev/pts/3');
    expect(d.calls).toEqual(['readlink /proc/100/fd/0']);
  });

  it('walks to the next ancestor past a pipe', () => {
    const d = fake({}, { '/proc/100/fd/0': 'pipe:[123]', '/proc/101/fd/0': '/dev/pts/9' });
    expect(parentTty(d)).toBe('/dev/pts/9');
    expect(d.calls).toEqual([
      'readlink /proc/100/fd/0',
      'readFile /proc/100/stat',
      'readlink /proc/101/fd/0',
    ]);
  });

  it('rejects a regular file and reads at most 3 ancestors', () => {
    const d = fake(
      {},
      {
        '/proc/100/fd/0': '/home/u/x',
        '/proc/101/fd/0': 'pipe:[1]',
        '/proc/102/fd/0': 'socket:[2]',
        '/proc/103/fd/0': '/dev/pts/1',
      },
    );
    expect(parentTty(d)).toBeNull();
    expect(d.calls.filter((c) => c.startsWith('readlink'))).toHaveLength(3);
    expect(d.calls.join(' ')).not.toContain('103');
  });

  it('asks ps once on macOS', () => {
    const d = fake({ platform: 'darwin', ppid: 4242 });
    expect(parentTty(d)).toBe('/dev/ttys004');
    expect(d.calls).toEqual(['exec ps -o tty= -p 4242']);
    expect(parentTty(fake({ platform: 'darwin', exec: () => '??\n' }))).toBeNull();
    expect(parentTty(fake({ platform: 'darwin', exec: () => '../etc/x' }))).toBeNull();
  });

  it('gives null on other platforms and bad pids', () => {
    for (const platform of ['win32', 'freebsd', 'aix'] as const) {
      const d = fake({ platform });
      expect(parentTty(d)).toBeNull();
      expect(d.calls).toEqual([]);
    }
    expect(parentTty(fake({ ppid: 1 }))).toBeNull();
    expect(parentTty(fake({ ppid: Number.NaN }))).toBeNull();
  });
});

describe('tmuxWrap', () => {
  it('wraps in DCS passthrough and doubles ESC', () => {
    expect(tmuxWrap(SEQ)).toBe('\u001bPtmux;\u001b\u001b]9;4;4;72\u0007\u001b\\');
  });
});

describe('writeTty', () => {
  it('opens the device write-only, writes once and closes', () => {
    const d = fake();
    expect(writeTty(SEQ, WT, ON, d)).toBe(true);
    expect(d.written).toEqual([SEQ]);
    expect(d.calls.slice(-4)).toEqual(['stat /dev/pts/3', 'open /dev/pts/3', 'write 7', 'close 7']);
    const c = fs.constants;
    const flags = d.opened[0]!;
    expect(flags & (c.O_CREAT ?? 0)).toBe(0);
    expect(flags & (c.O_TRUNC ?? 0)).toBe(0);
    expect(flags & (c.O_APPEND ?? 0)).toBe(0);
    expect(flags).toBe((c.O_WRONLY ?? 0) | (c.O_NOCTTY ?? 0) | (c.O_NONBLOCK ?? 0));
  });

  it('never writes on win32', () => {
    const d = fake({ platform: 'win32' });
    expect(writeTty(SEQ, WT, { tmuxPassthrough: true, always: true }, d)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  it('skips a path that is not a character device', () => {
    const d = fake({ stat: () => ({ isCharacterDevice: () => false }) });
    expect(writeTty(SEQ, WT, ON, d)).toBe(false);
    expect(d.opened).toEqual([]);
  });

  it('gives false when no device is found', () => {
    const d = fake({}, { '/proc/100/fd/0': 'pipe:[1]' });
    expect(writeTty(SEQ, WT, ON, d)).toBe(false);
    expect(d.opened).toEqual([]);
  });

  it('refuses tmux unless passthrough is on', () => {
    const env = { ...WT, TMUX: '/tmp/tmux-1/default,1,0' };
    const d = fake();
    expect(writeTty(SEQ, env, ON, d)).toBe(false);
    expect(d.calls).toEqual([]);
    const e = fake();
    expect(writeTty(SEQ, env, { tmuxPassthrough: true, always: false }, e)).toBe(true);
    expect(e.written).toEqual([tmuxWrap(SEQ)]);
  });

  it('applies the terminal allowlist', () => {
    const xterm = { TERM: 'xterm-256color' };
    const d = fake();
    expect(writeTty(SEQ, xterm, ON, d)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(writeTty(SEQ, xterm, { tmuxPassthrough: false, always: true }, fake())).toBe(true);
    expect(writeTty(SEQ, WT, ON, fake())).toBe(true);
  });

  it('never throws', () => {
    const boom = () => {
      throw new Error('EIO');
    };
    for (const k of ['readlink', 'readFile', 'stat', 'open', 'write', 'close', 'exec'] as const) {
      const links: Record<string, string> = k === 'readFile' ? { '/proc/100/fd/0': 'pipe:[1]' } : {};
      const d = fake({ [k]: boom, platform: k === 'exec' ? 'darwin' : 'linux' }, links);
      expect(() => writeTty(SEQ, WT, ON, d), k).not.toThrow();
      expect(writeTty(SEQ, WT, ON, d), k).toBe(false);
    }
    const closes: number[] = [];
    const d = fake({ write: boom, close: (fd) => closes.push(fd) });
    expect(writeTty(SEQ, WT, ON, d)).toBe(false);
    expect(closes).toEqual([7]);
  });
});

describe('render tty channel', () => {
  const tmp = (p: string) => fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, p));
  let n = 0;

  function setup(progress: Record<string, unknown> | undefined, used = 64) {
    const dir = tmp('progress-tty-');
    const sid = `tty-${process.pid}-${n++}`;
    const file = path.join(dir, 'p.json');
    const body = (u: number) =>
      JSON.stringify({
        session_id: sid,
        model: { display_name: 'Opus' },
        context_window: { context_window_size: 200_000, used_percentage: u },
      });
    fs.writeFileSync(file, body(used));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfg,
      JSON.stringify({ lines: [[{ id: 'm', type: 'model' }]], ...(progress ? { progress } : {}) }),
    );
    const want = path.join(process.env.CCINFOBAR_CACHE_DIR!, 'hooks', `${sid}.progress.json`);
    return { file, cfg, want, setUsed: (u: number) => fs.writeFileSync(file, body(u)) };
  }

  async function run(s: ReturnType<typeof setup>, d: Fake): Promise<string> {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((v) => {
      out.push(String(v));
      return true;
    });
    try {
      await runRender(parseArgs(['--payload', s.file]), s.cfg, d);
    } finally {
      spy.mockRestore();
    }
    return out.join('');
  }

  const TTY = { enabled: true, channel: 'tty', terminals: 'always' };

  it('writes once per change', async () => {
    vi.stubEnv('TMUX', '');
    const s = setup(TTY);
    try {
      const d = fake();
      await run(s, d);
      expect(d.written).toEqual([progressSeq(4, 64)]);
      await run(s, d);
      expect(d.written).toHaveLength(1);
      s.setUsed(90);
      await run(s, d);
      expect(d.written).toEqual([progressSeq(4, 64), progressSeq(2, 90)]);
    } finally {
      fs.rmSync(s.want, { force: true });
    }
  });

  it('never writes on the hook channel or on win32', async () => {
    vi.stubEnv('TMUX', '');
    const a = setup({ enabled: true, channel: 'hook', terminals: 'always' });
    const b = setup(TTY);
    try {
      const d = fake();
      await run(a, d);
      const w = fake({ platform: 'win32' });
      await run(b, w);
      expect(d.calls).toEqual([]);
      expect(w.calls).toEqual([]);
    } finally {
      fs.rmSync(a.want, { force: true });
      fs.rmSync(b.want, { force: true });
    }
  });

  it('leaves stdout unchanged', async () => {
    vi.stubEnv('TMUX', '');
    const plain = setup(undefined);
    const s = setup(TTY);
    const fail = setup(TTY);
    try {
      const d = fake();
      const base = await run(plain, fake());
      expect(await run(s, d)).toBe(base);
      expect(d.written).toHaveLength(1);
      const bad = fake({
        open: () => {
          throw new Error('ENXIO');
        },
      });
      expect(await run(fail, bad)).toBe(base);
      expect(base).not.toContain('\u001b]9;');
    } finally {
      fs.rmSync(s.want, { force: true });
      fs.rmSync(fail.want, { force: true });
    }
  });
});
