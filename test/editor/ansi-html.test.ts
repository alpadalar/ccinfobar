import { describe, expect, it } from 'vitest';
import { ansi256ToHex, ansiToHtml, escapeHtml } from '../../src/editor/web/ansi-html.js';

describe('ansiToHtml', () => {
  it('passes plain text through escaped', () => {
    expect(ansiToHtml('a <b> & "c"')).toBe('a &lt;b&gt; &amp; &quot;c&quot;');
    expect(escapeHtml('<')).toBe('&lt;');
  });

  it('applies basic foreground and resets', () => {
    const html = ansiToHtml('\x1b[31mred\x1b[0m plain');
    expect(html).toContain('color:var(--ansi-1, #cd3131)');
    expect(html).toContain('>red</span> plain');
  });

  it('supports bright colors and backgrounds', () => {
    expect(ansiToHtml('\x1b[91mx')).toContain('color:var(--ansi-9, #f14c4c)');
    expect(ansiToHtml('\x1b[44mx')).toContain('background:var(--ansi-4, #2472c8)');
    expect(ansiToHtml('\x1b[101mx')).toContain('background:var(--ansi-9, #f14c4c)');
  });

  it('supports 256 and truecolor', () => {
    expect(ansiToHtml('\x1b[38;5;196mx')).toContain('color:#ff0000');
    expect(ansiToHtml('\x1b[48;5;232mx')).toContain('background:#080808');
    expect(ansiToHtml('\x1b[38;5;3mx')).toContain('color:var(--ansi-3, #e5e510)');
    expect(ansiToHtml('\x1b[38;2;18;52;86mx')).toContain('color:#123456');
    expect(ansiToHtml('\x1b[48;2;1;2;3mx')).toContain('background:#010203');
  });

  it('handles bold, dim, italic and their resets', () => {
    const html = ansiToHtml('\x1b[1;3mA\x1b[22mB\x1b[23mC');
    expect(html).toContain('font-weight:700;font-style:italic">A');
    expect(html).toContain('font-style:italic">B');
    expect(html).toContain('>C');
    expect(html).not.toContain('>C</span>');
    expect(ansiToHtml('\x1b[2mx')).toContain('opacity:.6');
  });

  it('resets fg and bg individually', () => {
    const html = ansiToHtml('\x1b[31;42mA\x1b[39mB\x1b[49mC');
    expect(html).toContain('background:var(--ansi-2, #0dbc79)">B');
    expect(html).toMatch(/>C$/);
  });

  it('renders OSC 8 links', () => {
    const html = ansiToHtml('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ after');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('link</a> after');
  });

  it('drops unsafe link schemes', () => {
    expect(ansiToHtml('\x1b]8;;javascript:alert(1)\x07x\x1b]8;;\x07')).not.toContain('<a');
  });

  it('strips unknown escape sequences', () => {
    expect(ansiToHtml('a\x1b[2Kb')).toBe('ab');
  });

  it('maps 256 palette ends', () => {
    expect(ansi256ToHex(0)).toBe('#000000');
    expect(ansi256ToHex(231)).toBe('#ffffff');
    expect(ansi256ToHex(255)).toBe('#eeeeee');
  });
});

describe('powerline glyphs', () => {
  it('draws glyphs as css shapes with fg and bg', () => {
    const html = ansiToHtml('\x1b[38;2;1;2;3;48;2;4;5;6m\x1b[0m');
    expect(html).toBe(
      '<span class="pl pl-e0b0" style="--pl:#010203;background:#040506"> </span><span class="pl pl-e0b6"> </span>',
    );
  });

  it('keeps surrounding text styled', () => {
    expect(ansiToHtml('\x1b[31mab')).toBe(
      '<span style="color:var(--ansi-1, #cd3131)">a</span><span class="pl pl-e0b1" style="--pl:var(--ansi-1, #cd3131)"> </span><span style="color:var(--ansi-1, #cd3131)">b</span>',
    );
  });
});
