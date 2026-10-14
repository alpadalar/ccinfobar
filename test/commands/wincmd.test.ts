import { describe, expect, it } from 'vitest';
import { buildCommand, jsForWinBin, shQuote, winArg } from '../../src/commands/command.js';

const cmd = (r: ReturnType<typeof buildCommand>) => (r.ok ? r.command : `!${r.reason}`);

describe('rules', () => {
  describe('win32', () => {
    const npmBin = 'C:\\Users\\A B\\AppData\\Roaming\\npm\\ccinfobar.cmd';

    it('writes bare ccinfobar when it is on PATH', () => {
      expect(buildCommand({ kind: 'bin', bin: npmBin, onPath: true }, 'win32')).toEqual({
        ok: true,
        command: 'ccinfobar',
      });
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
