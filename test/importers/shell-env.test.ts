import { describe, expect, it } from 'vitest';
import { parseShellEnv } from '../../src/importers/shell-env.js';

const vars = (text: string) => ({ ...parseShellEnv(text).vars });

describe('parseShellEnv', () => {
  it('reads the documented assignment forms', () => {
    const r = parseShellEnv(
      [
        '# coralline config',
        'VL_SEGMENTS=dir\\ git\\ model',
        "VL_STYLE='lean'",
        'VL_LEAN_SEP="·"',
        'export PYCCSL_THEME="nord"',
        '. "$HOME/.claude/coralline/themes/nord.conf"',
        'VL_X=$(curl https://example.com)',
        'if [ -n "$X" ]; then',
        '',
      ].join('\n'),
    );
    expect({ ...r.vars }).toEqual({
      VL_SEGMENTS: 'dir git model',
      VL_STYLE: 'lean',
      VL_LEAN_SEP: '·',
      PYCCSL_THEME: 'nord',
    });
    expect(r.includes).toEqual([{ line: 6, name: 'nord' }]);
    expect(r.skipped).toEqual([7, 8]);
  });

  it('handles comments, ANSI-C quotes and double-quote escapes', () => {
    expect(
      vars(
        [
          'A="x # not comment" # comment',
          'B=plain # c',
          "C=$'a\\tb'",
          'D="a\\$b"',
          'E="$HOME/x"',
          'F="q\\"t\\\\\\`b"',
          'G="\\n stays"',
          "H=$'it\\'s \\x41\\101'",
          'I=pl#ain',
          'J=',
          'K=a"b c"\'d e\'',
        ].join('\n'),
      ),
    ).toEqual({
      A: 'x # not comment',
      B: 'plain',
      C: 'a\tb',
      D: 'a$b',
      E: '$HOME/x',
      F: 'q"t\\`b',
      G: '\\n stays',
      H: "it's AA",
      I: 'pl#ain',
      J: '',
      K: 'ab cd e',
    });
  });

  it('skips everything that could run a command', () => {
    const lines = [
      'F=`id`',
      'G=$(id)',
      'H=1; rm -rf /',
      'I=1 && x',
      'J=1 | x',
      'function k() {',
      'fi',
      'source <(curl x)',
      'L="$(id)"',
      'M="`id`"',
      'N=1 cmd',
      'O=$((1+2))',
      'echo hi',
      'export',
      '"P=1"',
      '1Q=2',
      'R=1 > /tmp/x',
    ];
    const r = parseShellEnv(lines.join('\n'));
    expect({ ...r.vars }).toEqual({});
    expect(r.includes).toEqual([]);
    expect(r.skipped).toEqual(lines.map((_, i) => i + 1));
  });

  it('reads export lists, source includes and the last assignment', () => {
    const r = parseShellEnv(
      [
        'export A=1 B=two',
        'A=3',
        'source ~/.claude/pyccsl.env',
        '. "C:\\Users\\me\\themes\\gruvbox-dark.sh"',
        '. a b',
      ].join('\n'),
    );
    expect({ ...r.vars }).toEqual({ A: '3', B: 'two' });
    expect(r.includes).toEqual([
      { line: 3, name: 'pyccsl' },
      { line: 4, name: 'gruvbox-dark' },
    ]);
    expect(r.skipped).toEqual([5]);
  });

  it('keeps __proto__ and constructor as own keys of a null-prototype object', () => {
    const r = parseShellEnv('__proto__=1\nconstructor=2\ntoString=3\n');
    expect(Object.getPrototypeOf(r.vars)).toBeNull();
    expect(Object.hasOwn(r.vars, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(r.vars, '__proto__')?.value).toBe('1');
    expect(r.vars.constructor).toBe('2');
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
    expect(Object.prototype).not.toHaveProperty('1');
  });

  it('parses CRLF and a BOM like LF and skips unterminated quotes', () => {
    const lf = 'A="x y"\n# c\nB=2\nC="open\nD=\'open\nE=a\\\n';
    const crlf = `\ufeff${lf.replace(/\n/g, '\r\n')}`;
    const a = parseShellEnv(lf);
    const b = parseShellEnv(crlf);
    expect({ ...b.vars }).toEqual({ ...a.vars });
    expect(b.skipped).toEqual(a.skipped);
    expect({ ...a.vars }).toEqual({ A: 'x y', B: '2' });
    expect(a.skipped).toEqual([4, 5, 6]);
  });

  it('skips very long lines', () => {
    const r = parseShellEnv(`A=${'x'.repeat(10_001)}\nB=1\n`);
    expect({ ...r.vars }).toEqual({ B: '1' });
    expect(r.skipped).toEqual([1]);
  });
});
