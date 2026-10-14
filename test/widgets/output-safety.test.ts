import { describe, expect, it } from 'vitest';
import type { StatusPayload } from '../../src/core/types.js';
import { formatCommandOutput } from '../../src/widgets/custom.js';
import { ctxWith, renderWidget } from '../helpers.js';

const pr = (url: string): StatusPayload => ({ pr: { number: 7, url, review_state: 'approved' } });

describe('command output', () => {
  it('keeps SGR and drops OSC 52 with preserveColors', () => {
    expect(formatCommandOutput('\x1b[32mok\x1b[0m\x1b]52;c;Zm9v\x07', true)).toBe('\x1b[32mok\x1b[0m');
  });

  it('strips everything without preserveColors', () => {
    expect(formatCommandOutput('\x1b[32mok\x1b[0m \u202ex', false)).toBe('ok x');
    expect(formatCommandOutput('a\x1b]0;title\x07b', false)).toBe('ab');
  });
});

describe('pr widget', () => {
  it('links a safe https url', () => {
    const out = renderWidget('pr', ctxWith({ payload: pr('https://github.com/o/r/pull/7') }), {
      options: { link: true },
    });
    expect(out).toContain('\x1b]8;;https://github.com/o/r/pull/7\x1b\\');
    expect(out).toContain('#7 approved');
  });

  it('renders text without a link for a hostile url', () => {
    const out = renderWidget('pr', ctxWith({ payload: pr('https://x/\x07\x1b]52;c;Zm9v\x07') }), {
      options: { link: true },
    });
    expect(out).not.toContain('\x1b]8');
    expect(out).toBe('#7 approved');
  });

  it('does not link non-http schemes', () => {
    const out = renderWidget('pr', ctxWith({ payload: pr('javascript:alert(1)') }), {
      options: { link: true },
    });
    expect(out).toBe('#7 approved');
  });
});

describe('link widget', () => {
  it('links config urls with custom schemes', () => {
    const out = renderWidget('link', ctxWith(), { options: { text: 'open', url: 'vscode://file/a' } });
    expect(out).toBe('\x1b]8;;vscode://file/a\x1b\\open\x1b]8;;\x1b\\');
  });

  it('renders plain text for javascript urls', () => {
    const out = renderWidget('link', ctxWith(), { options: { text: 'open', url: 'javascript:alert(1)' } });
    expect(out).toBe('open');
  });
});

describe('env widget', () => {
  it('sanitizes the value', () => {
    const out = renderWidget('env', ctxWith({ env: { FOO: 'a\x1b]0;t\x07b' } }), {
      options: { name: 'FOO' },
    });
    expect(out).toBe('ab');
  });

  it('returns null when nothing is left', () => {
    const out = renderWidget('env', ctxWith({ env: { FOO: '\x1b[2J' } }), { options: { name: 'FOO' } });
    expect(out).toBeNull();
  });
});
