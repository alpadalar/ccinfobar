import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isProgressEvent,
  markSent,
  type ProgressState,
  progressFiles,
  progressSeq,
  readSent,
  readWant,
  SEQ_BODY_RE,
  terminalAllowed,
} from '../../src/data/progress.js';
import { writeSmall } from '../../src/data/store.js';

const tmp = (p: string) => fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, p));
const body = (s: string) => s.slice('\u001b]9;'.length, -1);

describe('progressSeq', () => {
  it('always matches the Claude Code validator', () => {
    for (const state of [0, 1, 2, 4] as ProgressState[]) {
      for (const pct of [-5, 0, 7.4, 42, 99.6, 100, 250, Number.NaN]) {
        const seq = progressSeq(state, pct);
        expect(seq.startsWith('\u001b]9;'), seq).toBe(true);
        expect(seq.endsWith('\u0007'), seq).toBe(true);
        expect(body(seq), seq).toMatch(SEQ_BODY_RE);
      }
    }
  });

  it('builds the clear form and clamps', () => {
    expect(progressSeq(0, 55)).toBe('\u001b]9;4;0;\u0007');
    expect(progressSeq(1, 7.4)).toBe('\u001b]9;4;1;7\u0007');
    expect(progressSeq(4, 99.6)).toBe('\u001b]9;4;4;100\u0007');
    expect(progressSeq(2, 250)).toBe('\u001b]9;4;2;100\u0007');
    expect(progressSeq(1, -5)).toBe('\u001b]9;4;1;0\u0007');
    expect(progressSeq(1, Number.NaN)).toBe('\u001b]9;4;1;0\u0007');
  });

  it('knows the progress events', () => {
    expect(isProgressEvent('Stop')).toBe(true);
    expect(isProgressEvent('StopFailure')).toBe(true);
    expect(isProgressEvent('UserPromptSubmit')).toBe(true);
    expect(isProgressEvent('SessionStart')).toBe(false);
    expect(isProgressEvent(1)).toBe(false);
  });
});

describe('terminalAllowed', () => {
  it('follows the allowlist', () => {
    expect(terminalAllowed({ WT_SESSION: 'x' }, false)).toBe(true);
    expect(terminalAllowed({ ConEmuPID: '1' }, false)).toBe(true);
    expect(terminalAllowed({ ConEmuANSI: 'ON' }, false)).toBe(true);
    const g = (v: string) => ({ TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: v });
    expect(terminalAllowed(g('1.1.9'), false)).toBe(false);
    expect(terminalAllowed(g('1.2.0'), false)).toBe(true);
    expect(terminalAllowed(g('1.10.0-main+abc'), false)).toBe(true);
    expect(terminalAllowed({ TERM_PROGRAM: 'ghostty' }, false)).toBe(false);
    const i = (v: string) => ({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: v });
    expect(terminalAllowed(i('3.6.5'), false)).toBe(false);
    expect(terminalAllowed(i('3.6.6'), false)).toBe(true);
    expect(terminalAllowed(i('3.10.0'), false)).toBe(true);
    expect(terminalAllowed({ TERM_PROGRAM: 'WezTerm' }, false)).toBe(true);
    expect(terminalAllowed({ TERM_PROGRAM: 'xterm' }, false)).toBe(false);
    expect(terminalAllowed({}, false)).toBe(false);
    expect(terminalAllowed({ TERM_PROGRAM: 'xterm' }, true)).toBe(true);
  });
});

describe('progress files', () => {
  it('validates the session id', () => {
    const env = { CCINFOBAR_CACHE_DIR: '/x' };
    expect(progressFiles('../x', env)).toBeNull();
    expect(progressFiles('', env)).toBeNull();
    const f = progressFiles('abc-123', env)!;
    expect(path.basename(f.want)).toBe('abc-123.progress.json');
    expect(path.basename(f.sent)).toBe('abc-123.progress-sent.json');
    expect(path.dirname(f.want)).toBe(path.join('/x', 'hooks'));
  });

  it('reads only well-formed state', () => {
    const dir = tmp('progress-read-');
    const f = path.join(dir, 'w.json');
    fs.writeFileSync(f, JSON.stringify({ v: 1, state: 4, pct: 72, channel: 'hook', always: false }));
    expect(readWant(f)).toEqual({ v: 1, state: 4, pct: 72, channel: 'hook', always: false });
    for (const bad of [
      { v: 1, state: 3, pct: 72, channel: 'hook', always: false },
      { v: 1, state: 1, pct: 101, channel: 'hook', always: false },
      { v: 1, state: 1, pct: 1.5, channel: 'hook', always: false },
      { v: 1, state: 1, pct: 5, channel: 'x', always: false },
      { v: 2, state: 1, pct: 5, channel: 'hook', always: false },
      [],
    ]) {
      fs.writeFileSync(f, JSON.stringify(bad));
      expect(readWant(f), JSON.stringify(bad)).toBeNull();
    }
    expect(readWant(path.join(dir, 'missing.json'))).toBeNull();
    const s = path.join(dir, 's.json');
    expect(readSent(s)).toBeNull();
    expect(markSent(s, { state: 2, pct: 90 })).toBe(true);
    expect(readSent(s)).toEqual({ state: 2, pct: 90 });
    fs.writeFileSync(s, '{"state":"2","pct":90}');
    expect(readSent(s)).toBeNull();
  });
});

describe('writeSmall', () => {
  it('writes atomically and leaves no temp file', () => {
    const dir = tmp('progress-small-');
    const f = path.join(dir, 'sub', 'a.json');
    expect(writeSmall(f, 'one')).toBe(true);
    expect(writeSmall(f, 'two')).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('two');
    expect(fs.readdirSync(path.dirname(f))).toEqual(['a.json']);
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('returns false without throwing on an unwritable target', () => {
    const dir = tmp('progress-bad-');
    const file = path.join(dir, 'plain');
    fs.writeFileSync(file, 'x');
    expect(writeSmall(path.join(file, 'a.json'), 'x')).toBe(false);
    const target = path.join(dir, 'isdir');
    fs.mkdirSync(path.join(target, 'inner'), { recursive: true });
    expect(writeSmall(target, 'x')).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(['isdir', 'plain']);
  });
});

describe('progress module imports', () => {
  it('stays safe for the hook path', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../src/data/progress.ts'), 'utf8');
    expect(text).not.toMatch(/node:crypto/);
    expect(text).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'node:fs'/m);
    expect(text).not.toMatch(/core\/config|widgets\/|core\/renderer|writeAtomic/);
    const specs = [...text.matchAll(/^import\s+(?!type\b)[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(specs.every((s) => ['node:path', './store.js', './hook-line.js'].includes(s!))).toBe(true);
  });
});
