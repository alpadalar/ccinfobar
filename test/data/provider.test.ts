import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { detectProvider } from '../../src/data/provider.js';
import { needsUsage } from '../../src/data/usage.js';

describe('detectProvider', () => {
  it('defaults to first party', () => {
    expect(detectProvider({})).toEqual({ kind: 'firstParty', planLimits: true });
  });

  it('reads cloud provider flags', () => {
    expect(detectProvider({ CLAUDE_CODE_USE_BEDROCK: '1' })).toEqual({ kind: 'bedrock', planLimits: false });
    for (const v of ['true', 'YES', 'on']) {
      expect(detectProvider({ CLAUDE_CODE_USE_BEDROCK: v }).kind).toBe('bedrock');
    }
    for (const v of ['0', 'false', '']) {
      expect(detectProvider({ CLAUDE_CODE_USE_BEDROCK: v }).kind).toBe('firstParty');
    }
    expect(detectProvider({ CLAUDE_CODE_USE_MANTLE: '1' }).kind).toBe('mantle');
    expect(detectProvider({ CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' }).kind).toBe('anthropicAws');
    expect(detectProvider({ CLAUDE_CODE_USE_VERTEX: '1' }).kind).toBe('vertex');
    expect(detectProvider({ CLAUDE_CODE_USE_FOUNDRY: '1' }).kind).toBe('foundry');
  });

  it('applies the flag order', () => {
    expect(detectProvider({ CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_BEDROCK: '1' }).kind).toBe(
      'bedrock',
    );
    expect(detectProvider({ CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_USE_MANTLE: '1' }).kind).toBe('mantle');
  });

  it('detects gateways from the base URL', () => {
    expect(detectProvider({ ANTHROPIC_BASE_URL: 'https://gw.example.com/v1' })).toEqual({
      kind: 'gateway',
      host: 'gw.example.com',
      planLimits: false,
    });
    expect(detectProvider({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }).kind).toBe('firstParty');
    expect(detectProvider({ ANTHROPIC_BASE_URL: 'not a url' }).kind).toBe('firstParty');
  });

  it('detects API keys unless an OAuth token is set', () => {
    expect(detectProvider({ ANTHROPIC_API_KEY: 'sk-x' })).toEqual({ kind: 'apiKey', planLimits: false });
    expect(detectProvider({ ANTHROPIC_AUTH_TOKEN: 't' }).kind).toBe('apiKey');
    expect(detectProvider({ ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_OAUTH_TOKEN: 'o' }).kind).toBe('firstParty');
  });

  it('never returns the key', () => {
    expect(JSON.stringify(detectProvider({ ANTHROPIC_API_KEY: 'sk-secret' }))).not.toContain('sk-secret');
  });
});

// D-36: Claude Code passes settings env to the status line, so only the process env is read
describe('detectProvider env source', () => {
  it('ignores a settings.json env block and reads no file', () => {
    const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'provider-settings-'));
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://api.z.ai' } }),
    );
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      expect(detectProvider({ CLAUDE_CONFIG_DIR: dir }).kind).toBe('firstParty');
      expect(detectProvider({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_USE_BEDROCK: '1' }).kind).toBe('bedrock');
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('has no file reader in its module', () => {
    const src = fs.readFileSync(path.resolve('src/data/provider.ts'), 'utf8');
    expect(src).not.toMatch(/node:fs|readFileSync|settings\.json/);
  });
});

describe('needsUsage provider gate', () => {
  const config = { ...defaultConfig(), lines: [[{ id: 'f', type: 'five-hour-usage' }]] };

  it('skips the OAuth fetch for non-first-party sessions', () => {
    expect(needsUsage(config, {}, { ANTHROPIC_API_KEY: 'x' })).toBe(false);
    expect(needsUsage(config, {}, { CLAUDE_CODE_USE_VERTEX: '1' })).toBe(false);
    expect(needsUsage(config, {}, { ANTHROPIC_BASE_URL: 'https://gw.example.com' })).toBe(false);
  });

  it('keeps first party unchanged', () => {
    expect(needsUsage(config, {}, {})).toBe(true);
  });
});
