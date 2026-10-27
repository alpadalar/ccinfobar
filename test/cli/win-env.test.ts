import { describe, expect, it } from 'vitest';
import { noCwdLookup } from '../../src/cli/win-env.js';

describe('noCwdLookup', () => {
  it('sets the variable on win32', () => {
    const env: NodeJS.ProcessEnv = {};
    noCwdLookup(env, 'win32');
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });

  it('keeps a user value', () => {
    const env: NodeJS.ProcessEnv = { NoDefaultCurrentDirectoryInExePath: '0' };
    noCwdLookup(env, 'win32');
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('0');
  });

  it('leaves other platforms alone', () => {
    for (const p of ['linux', 'darwin']) {
      const env: NodeJS.ProcessEnv = {};
      noCwdLookup(env, p);
      expect(env).not.toHaveProperty('NoDefaultCurrentDirectoryInExePath');
    }
  });
});
