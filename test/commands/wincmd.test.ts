import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCommand, jsForWinBin, shQuote, winArg } from '../../src/commands/command.js';

const cmd = (r: ReturnType<typeof buildCommand>) => (r.ok ? r.command : `!${r.reason}`);

describe('rules', () => {
  describe('win32', () => {
    const npmBin = 'C:\\Users\\A B\\AppData\\Roaming\\npm\\ccinfobar.cmd';

    it('runs the package js through node even when ccinfobar is on PATH', () => {
      expect(cmd(buildCommand({ kind: 'bin', bin: npmBin, onPath: true }, 'win32', () => true))).toBe(
        'node "C:/Users/A B/AppData/Roaming/npm/node_modules/ccinfobar/dist/ccinfobar.js"',
      );
    });

    it('falls back to bare ccinfobar on PATH when the package js is not found', () => {
      expect(buildCommand({ kind: 'bin', bin: npmBin, onPath: true }, 'win32', () => false)).toEqual({
        ok: true,
        command: 'ccinfobar',
      });
    });

    it.each(['$', '%', '`', '"'])('falls back to bare ccinfobar on PATH when the js path has %s', (ch) => {
      const bin = `C:\\Users\\svc${ch}\\AppData\\Roaming\\npm\\ccinfobar.cmd`;
      expect(buildCommand({ kind: 'bin', bin, onPath: true }, 'win32', () => true)).toEqual({
        ok: true,
        command: 'ccinfobar',
      });
      expect(buildCommand({ kind: 'bin', bin, onPath: false }, 'win32', () => true).ok).toBe(false);
    });

    it('runs the npm global js through node when the bin is off PATH', () => {
      expect(cmd(buildCommand({ kind: 'bin', bin: npmBin, onPath: false }, 'win32'))).toBe(
        'node "C:/Users/A B/AppData/Roaming/npm/node_modules/ccinfobar/dist/ccinfobar.js"',
      );
    });

    it('maps a node_modules/.bin shim to the package js without quotes', () => {
      const bin = 'C:\\cfg\\app\\node_modules\\.bin\\ccinfobar.cmd';
      expect(cmd(buildCommand({ kind: 'bin', bin, onPath: false }, 'win32'))).toBe(
        'node C:/cfg/app/node_modules/ccinfobar/dist/ccinfobar.js',
      );
    });

    it('runs a script with bare node, never process.execPath', () => {
      const script = 'D:\\src\\ccinfobar\\dist\\ccinfobar.js';
      expect(cmd(buildCommand({ kind: 'script', script }, 'win32'))).toBe(
        'node D:/src/ccinfobar/dist/ccinfobar.js',
      );
      expect(
        cmd(buildCommand({ kind: 'script', script, node: 'C:\\Program Files\\nodejs\\node.exe' }, 'win32')),
      ).toBe('node D:/src/ccinfobar/dist/ccinfobar.js');
    });

    it.each(['"', '`', '$', '%'])('refuses a path containing %s', (ch) => {
      const script = `C:\\a${ch}b\\dist\\ccinfobar.js`;
      expect(buildCommand({ kind: 'script', script }, 'win32')).toEqual({
        ok: false,
        reason: 'unsafe-path',
        path: script,
        chars: ch,
      });
    });

    it('reports each offending char once', () => {
      const r = buildCommand({ kind: 'script', script: 'C:\\$x\\%y%\\$z.js' }, 'win32');
      expect(r.ok ? '' : r.chars).toBe('$%');
    });

    it('refuses control chars and reports them escaped', () => {
      const r = buildCommand({ kind: 'script', script: 'C:\\a\nb\\x.js' }, 'win32');
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.chars).toBe('\\n');
    });

    it('quotes shell punctuation as well as spaces', () => {
      expect(winArg('C:\\a&b\\x.js')).toEqual({ ok: true, command: '"C:/a&b/x.js"' });
      expect(winArg('C:\\a,b\\x.js')).toEqual({ ok: true, command: '"C:/a,b/x.js"' });
      expect(winArg('C:\\a;b(1)\\x.js')).toEqual({ ok: true, command: '"C:/a;b(1)/x.js"' });
    });

    it('never emits a backslash or a .cmd first token', () => {
      const targets = [
        { kind: 'bin' as const, bin: npmBin, onPath: false },
        { kind: 'bin' as const, bin: npmBin, onPath: true },
        { kind: 'bin' as const, bin: 'C:\\x y\\app\\node_modules\\.bin\\ccinfobar.cmd', onPath: false },
        { kind: 'script' as const, script: 'C:\\x y\\dist\\ccinfobar.js' },
      ];
      for (const t of targets) {
        const c = cmd(buildCommand(t, 'win32'));
        expect(c).not.toContain('\\');
        expect(c.split(' ')[0]).not.toMatch(/\.cmd"?$/i);
      }
    });

    it('locates the package js from either bin layout', () => {
      expect(jsForWinBin('C:\\p\\npm\\ccinfobar.cmd').replace(/\\/g, '/')).toBe(
        'C:/p/npm/node_modules/ccinfobar/dist/ccinfobar.js',
      );
      expect(jsForWinBin('C:\\p\\Node_Modules\\.bin\\ccinfobar.cmd').replace(/\\/g, '/')).toBe(
        'C:/p/Node_Modules/ccinfobar/dist/ccinfobar.js',
      );
    });
  });

  describe('posix', () => {
    it('keeps a plain absolute path as is', () => {
      expect(buildCommand({ kind: 'bin', bin: '/usr/local/bin/ccinfobar', onPath: true }, 'linux')).toEqual({
        ok: true,
        command: '/usr/local/bin/ccinfobar',
      });
    });

    it('single-quotes a path with a space', () => {
      expect(
        cmd(buildCommand({ kind: 'bin', bin: '/home/a b/.npm/bin/ccinfobar', onPath: false }, 'linux')),
      ).toBe("'/home/a b/.npm/bin/ccinfobar'");
    });

    it("escapes a single quote as '\\''", () => {
      expect(shQuote("/home/o'neil/bin/ccinfobar")).toBe("'/home/o'\\''neil/bin/ccinfobar'");
      expect(shQuote('')).toBe("''");
    });

    it('quotes the node path of a script target', () => {
      expect(
        cmd(
          buildCommand(
            { kind: 'script', script: '/src/dist/ccinfobar.js', node: '/opt/node 20/bin/node' },
            'darwin',
          ),
        ),
      ).toBe("'/opt/node 20/bin/node' /src/dist/ccinfobar.js");
    });

    it('defaults the node path to process.execPath', () => {
      expect(cmd(buildCommand({ kind: 'script', script: '/src/dist/ccinfobar.js' }, 'linux'))).toBe(
        `${shQuote(process.execPath)} /src/dist/ccinfobar.js`,
      );
    });

    it('accepts $ and backtick paths because single quotes stop expansion', () => {
      expect(cmd(buildCommand({ kind: 'bin', bin: '/a$b/`c`/ccinfobar', onPath: true }, 'linux'))).toBe(
        "'/a$b/`c`/ccinfobar'",
      );
    });
  });
});

const INPUT = '{"x":1}';
const LEN_JS =
  "let n = 0;\nprocess.stdin.on('data', (d) => { n += d.length; }).on('end', () => console.log(n));\n";

function envWith(prepend: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  let base = '';
  for (const [k, v] of Object.entries(process.env)) {
    if (/^path$/i.test(k)) base = v ?? '';
    else env[k] = v;
  }
  env.PATH = [...prepend, base].join(path.delimiter);
  return env;
}

function built(target: Parameters<typeof buildCommand>[0]): string {
  const r = buildCommand(target, process.platform);
  if (!r.ok) throw new Error(`unsafe test path: ${r.path}`);
  return r.command;
}

describe.skipIf(process.platform === 'win32')('posix shell', () => {
  const sh = (command: string, cwd: string) =>
    spawnSync('/bin/sh', ['-c', command], {
      input: INPUT,
      encoding: 'utf8',
      cwd,
      env: envWith([]),
      timeout: 30_000,
    });

  it.each(['a b', "it's a b"])('runs a bin under %s', (name) => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-wincmd-')), name);
    const bin = path.join(dir, 'bin', 'ccinfobar');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\nwc -c | tr -d ' '\n", { mode: 0o755 });
    const res = sh(built({ kind: 'bin', bin, onPath: false }), dir);
    expect(res.stderr).toBe('');
    expect({ status: res.status, out: res.stdout.trim() }).toEqual({ status: 0, out: '7' });
  });

  it('runs a script target with node', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-wincmd-')), 'a b');
    const script = path.join(dir, 'dist', 'ccinfobar.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, LEN_JS);
    const res = sh(built({ kind: 'script', script }), dir);
    expect(res.stderr).toBe('');
    expect({ status: res.status, out: res.stdout.trim() }).toEqual({ status: 0, out: '7' });
  });
});

describe.skipIf(process.platform !== 'win32')('win32 shells', () => {
  let npm = '';
  let env: NodeJS.ProcessEnv = {};

  beforeAll(() => {
    npm = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-wincmd-')), 'a b', 'npm');
    const js = path.join(npm, 'node_modules', 'ccinfobar', 'dist', 'ccinfobar.js');
    fs.mkdirSync(path.dirname(js), { recursive: true });
    fs.writeFileSync(js, LEN_JS);
    fs.writeFileSync(
      path.join(npm, 'ccinfobar.cmd'),
      '@ECHO off\r\nnode "%~dp0\\node_modules\\ccinfobar\\dist\\ccinfobar.js" %*\r\n',
    );
    fs.writeFileSync(
      path.join(npm, 'ccinfobar'),
      [
        '#!/bin/sh',
        'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
        'case `uname` in',
        '  *CYGWIN*|*MINGW*|*MSYS*)',
        '    if command -v cygpath > /dev/null 2>&1; then basedir=`cygpath -w "$basedir"`; fi',
        '  ;;',
        'esac',
        'exec node "$basedir/node_modules/ccinfobar/dist/ccinfobar.js" "$@"',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(npm, 'ccinfobar.ps1'),
      [
        '$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent',
        'if ($MyInvocation.ExpectingInput) {',
        '  $input | & node "$basedir/node_modules/ccinfobar/dist/ccinfobar.js" $args',
        '} else {',
        '  & node "$basedir/node_modules/ccinfobar/dist/ccinfobar.js" $args',
        '}',
        'exit $LASTEXITCODE',
        '',
      ].join('\r\n'),
    );
    env = envWith([npm, path.dirname(process.execPath)]);
  });

  type Shell = { name: string; file: string; args: (c: string) => string[]; verbatim?: boolean };

  function shells(): Shell[] {
    const out: Shell[] = [];
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (fs.existsSync(bash)) out.push({ name: 'git bash', file: bash, args: (c) => ['-c', c] });
    const ps = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
    out.push({ name: 'powershell', file: 'powershell.exe', args: (c) => [...ps, c] });
    if (spawnSync('where', ['pwsh'], { windowsHide: true }).status === 0)
      out.push({ name: 'pwsh', file: 'pwsh', args: (c) => [...ps, c] });
    out.push({ name: 'cmd', file: 'cmd.exe', args: (c) => ['/d', '/s', '/c', `"${c}"`], verbatim: true });
    return out;
  }

  it.each([
    ['bare ccinfobar', true],
    ['node "<fwd path>"', false],
  ])(
    'runs %s in every shell',
    (_label, onPath) => {
      const command = built({ kind: 'bin', bin: path.join(npm, 'ccinfobar.cmd'), onPath });
      expect(command).not.toContain('\\');
      for (const s of shells()) {
        const run = () =>
          spawnSync(s.file, s.args(command), {
            input: INPUT,
            encoding: 'utf8',
            env,
            timeout: 30_000,
            windowsHide: true,
            windowsVerbatimArguments: s.verbatim ?? false,
          });
        // a cold PowerShell on a busy runner can miss the timeout once
        let res = run();
        if (res.status === null) res = run();
        expect({
          shell: s.name,
          command,
          status: res.status,
          out: (res.stdout ?? '').trim(),
          err: res.stderr,
        }).toEqual({
          shell: s.name,
          command,
          status: 0,
          out: '7',
          err: expect.any(String),
        });
      }
    },
    150_000,
  );
});
