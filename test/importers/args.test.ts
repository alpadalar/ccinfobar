import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  binName,
  boolFlag,
  commandArgs,
  firstPathToken,
  flagValue,
  isBin,
  toolArgs,
} from '../../src/importers/args.js';

describe('commandArgs', () => {
  it('splits on whitespace and groups quotes', () => {
    expect(commandArgs(`"C:\\Program Files\\x\\cs.exe" render --theme 'nord dark'`)).toEqual([
      'C:\\Program Files\\x\\cs.exe',
      'render',
      '--theme',
      'nord dark',
    ]);
    expect(commandArgs('--x="a b" -y')).toEqual(['--x=a b', '-y']);
    expect(commandArgs('  a\t b  ')).toEqual(['a', 'b']);
    expect(commandArgs('')).toEqual([]);
    expect(commandArgs('a ""')).toEqual(['a', '']);
  });

  it('keeps backslashes literally', () => {
    expect(commandArgs('C:\\Users\\x\\.claude\\statusline.exe --theme nord')).toEqual([
      'C:\\Users\\x\\.claude\\statusline.exe',
      '--theme',
      'nord',
    ]);
    expect(commandArgs('a\\ b')).toEqual(['a\\', 'b']);
  });

  it('takes an unterminated quote to the end', () => {
    expect(commandArgs('x "a b')).toEqual(['x', 'a b']);
  });
});

describe('flagValue', () => {
  it('reads name value and name=value', () => {
    expect(flagValue(['--theme', 'nord'], ['--theme', '-t'])).toBe('nord');
    expect(flagValue(['-t=x'], ['--theme', '-t'])).toBe('x');
    expect(flagValue(['a', '--theme=', 'b'], ['--theme'])).toBe('');
  });

  it('returns the first match', () => {
    expect(flagValue(['-t', 'a', '--theme', 'b'], ['--theme', '-t'])).toBe('a');
  });

  it('returns null when missing or without a value', () => {
    expect(flagValue(['--other', 'x'], ['--theme'])).toBeNull();
    expect(flagValue(['--theme'], ['--theme'])).toBeNull();
    expect(flagValue([], ['--theme'])).toBeNull();
    expect(flagValue(['--themes', 'x'], ['--theme'])).toBeNull();
  });
});

describe('boolFlag', () => {
  const names = ['-cost', '--cost'];
  it('reads Go-style booleans', () => {
    expect(boolFlag(['-cost'], names)).toBe(true);
    expect(boolFlag(['-cost=false'], names)).toBe(false);
    expect(boolFlag(['--cost=1'], names)).toBe(true);
    expect(boolFlag(['--cost=0'], names)).toBe(false);
    expect(boolFlag(['--cost=TRUE'], names)).toBe(true);
    expect(boolFlag([], names)).toBeNull();
    expect(boolFlag(['-costs'], names)).toBeNull();
    expect(boolFlag(['-cost=maybe'], names)).toBeNull();
  });
});

describe('firstPathToken', () => {
  it('finds the first absolute path and expands ~', () => {
    expect(firstPathToken('bash ~/.claude/statusline.sh', '/h')).toBe(
      path.join('/h', '.claude/statusline.sh'),
    );
    const abs = path.resolve('/opt/x/bin');
    expect(firstPathToken(`"${abs}" --a`, '/h')).toBe(abs);
  });

  it('returns null without an absolute path', () => {
    expect(firstPathToken('ccstatusline', '/h')).toBeNull();
    expect(firstPathToken('./x/y.sh', '/h')).toBeNull();
    expect(firstPathToken('', '/h')).toBeNull();
  });
});

describe('toolArgs', () => {
  const ccsp = isBin('ccsp', 'claude-code-statusline-pro');

  it('names a program by its basename, without @version or .exe', () => {
    expect(binName('ccsp@latest')).toBe('ccsp');
    expect(binName('@owloops/claude-powerline@latest')).toBe('claude-powerline');
    expect(binName('C:\\Program Files\\x\\CS.EXE')).toBe('cs');
    expect(binName('/usr/bin/claudebar.cmd')).toBe('claudebar');
    expect(binName('')).toBe('');
  });

  it('starts at the tool token and reads nothing from other commands', () => {
    expect(toolArgs(commandArgs('npx -y ccsp@latest -c a.toml'), ccsp)).toEqual([
      'ccsp@latest',
      '-c',
      'a.toml',
    ]);
    expect(toolArgs(commandArgs('ccinfobar --config ~/work.json'), ccsp)).toBeNull();
    expect(toolArgs(commandArgs('node ~/ccsp-config/x.js -c a.toml'), ccsp)).toBeNull();
    expect(toolArgs([], ccsp)).toBeNull();
  });

  it('looks inside a quoted sh -c script', () => {
    expect(toolArgs(commandArgs('bash -c "npx ccsp@latest -c a.toml"'), ccsp)).toEqual([
      'ccsp@latest',
      '-c',
      'a.toml',
    ]);
    expect(toolArgs(commandArgs(`"C:\\Program Files\\ccsp.exe" -t nord`), ccsp)).toEqual([
      'C:\\Program Files\\ccsp.exe',
      '-t',
      'nord',
    ]);
    expect(toolArgs(commandArgs('bash -c "other -c a.toml"'), ccsp)).toBeNull();
  });
});
