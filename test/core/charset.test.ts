import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { render, resolveCharset } from '../../src/core/renderer.js';
import { samplePayload } from '../../src/core/sample.js';
import type { Config, WidgetItem } from '../../src/core/types.js';

const text = (t: string): WidgetItem => ({ id: t, type: 'text', options: { text: t } });
const run = (config: Partial<Config>, env: NodeJS.ProcessEnv) =>
  render(
    createContext({
      payload: samplePayload(),
      config: { ...defaultConfig(), colorLevel: 0, ...config },
      env,
      data: { git: () => null, gsd: () => null, transcript: () => null },
    }),
  ).map(stripAnsi);
const apple = { TERM_PROGRAM: 'Apple_Terminal' };
const PRIVATE_USE = /[-]/;

describe('charset', () => {
  it('auto picks unicode in Apple Terminal and nerd elsewhere', () => {
    expect(resolveCharset({ ...defaultConfig() }, apple)).toBe('unicode');
    expect(resolveCharset({ ...defaultConfig() }, { TERM_PROGRAM: 'iTerm.app' })).toBe('nerd');
    expect(resolveCharset({ ...defaultConfig(), charset: 'nerd' }, apple)).toBe('nerd');
  });

  it('never prints Nerd Font glyphs in Apple Terminal by default', () => {
    for (const theme of ['powerline', 'nord', 'catppuccin', 'bubblegum', 'dark']) {
      const out = run(
        { theme, icons: 'nerd', lines: [[text('a'), text('b'), { id: 'm', type: 'model' }]] },
        apple,
      );
      expect(out.join('\n')).not.toMatch(PRIVATE_USE);
    }
  });

  it('draws unicode capsules with half blocks and powerline as plain blocks', () => {
    expect(run({ theme: 'catppuccin', lines: [[text('a')]] }, apple)).toEqual(['▐ a ▌']);
    expect(run({ theme: 'nord', lines: [[text('a'), text('b')]] }, apple)).toEqual([' a  b ']);
  });

  it('keeps arrows when nerd is chosen explicitly', () => {
    const out = run({ theme: 'nord', charset: 'nerd', lines: [[text('a'), text('b')]] }, apple);
    expect(out[0]).toMatch(PRIVATE_USE);
  });
});
