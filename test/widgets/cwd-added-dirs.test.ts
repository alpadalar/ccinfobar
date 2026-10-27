import { describe, expect, it } from 'vitest';
import { visibleWidth } from '../../src/core/width.js';
import { ctxWith, renderWidget, withLang } from '../helpers.js';

const CUR = '/home/dev/projects/acme-app';

function cwd(dirs: unknown, options: Record<string, string> = {}, current: string | undefined = CUR) {
  const workspace: Record<string, unknown> = {};
  if (current) workspace.current_dir = current;
  if (dirs !== undefined) workspace.added_dirs = dirs;
  return renderWidget('cwd', ctxWith({ payload: { workspace } as never }), { options });
}

describe('cwd addedDirs', () => {
  it('off by default and explicit', () => {
    expect(cwd(['/a/x', '/b/y'])).toBe('acme-app');
    expect(cwd(['/a/x', '/b/y'], { addedDirs: 'off' })).toBe('acme-app');
  });

  it('empty or absent array renders the base', () => {
    for (const addedDirs of ['count', 'names']) {
      expect(cwd([], { addedDirs })).toBe('acme-app');
      expect(cwd(undefined, { addedDirs })).toBe('acme-app');
    }
  });

  it('count singular and plural', () => {
    expect(cwd(['/a/x'], { addedDirs: 'count' })).toBe('acme-app +1 dir');
    expect(cwd(['/a/x', '/b/y'], { addedDirs: 'count' })).toBe('acme-app +2 dirs');
  });

  it('names', () => {
    expect(cwd(['/a/shared-lib', '/b/docs'], { addedDirs: 'names' })).toBe('acme-app +shared-lib +docs');
  });

  it('caps at five names with +N more', () => {
    const dirs = Array.from({ length: 7 }, (_, i) => `/p/d${i}`);
    expect(cwd(dirs, { addedDirs: 'names' })).toBe('acme-app +d0 +d1 +d2 +d3 +d4 +2 more');
  });

  it('truncates long names to 24 columns', () => {
    const out = cwd([`/p/${'a'.repeat(30)}`], { addedDirs: 'names' })!;
    const part = out.split(' ')[1]!;
    expect(visibleWidth(part)).toBeLessThanOrEqual(25);
    expect(part.endsWith('…')).toBe(true);
  });

  it('truncates wide characters by columns', () => {
    const out = cwd([`/p/${'漢'.repeat(20)}`], { addedDirs: 'names' })!;
    const part = out.split(' ')[1]!;
    expect(visibleWidth(part)).toBeLessThanOrEqual(25);
    expect(part.length).toBeLessThan(20);
  });

  it('strips escapes and bidi marks', () => {
    const out = cwd(['/p/\x1b[31mred‮evil'], { addedDirs: 'names' })!;
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('‮');
    expect(out).toContain('+red');
  });

  it('skips non-string entries', () => {
    expect(cwd([1, null, '/x/ok'], { addedDirs: 'names' })).toBe('acme-app +ok');
  });

  it('returns null without a current dir', () => {
    const ctx = ctxWith({ payload: { workspace: { added_dirs: ['/a/x', '/b/y'] } } as never });
    ctx.cwd = '';
    expect(renderWidget('cwd', ctx, { options: { addedDirs: 'count' } })).toBeNull();
  });

  it('turkish', () => {
    withLang('tr', () => {
      expect(cwd(['/a/x', '/b/y'], { addedDirs: 'count' })).toBe('acme-app +2 klasör');
      const dirs = Array.from({ length: 7 }, (_, i) => `/p/d${i}`);
      expect(cwd(dirs, { addedDirs: 'names' })!.endsWith('+2 daha')).toBe(true);
    });
  });

  it('honours the base style', () => {
    expect(cwd(['/a/x', '/b/y'], { addedDirs: 'count', style: 'full' })).toBe(`${CUR} +2 dirs`);
  });
});
