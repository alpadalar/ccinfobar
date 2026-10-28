import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import type { Config, StatusPayload } from '../../src/core/types.js';
import { renderWidget, withoutSideEffects } from '../helpers.js';

const NOW = new Date('2026-10-12T12:00:00Z');
const ENTRY = { match: 'glm-4.6-custom', label: 'GLM 4.6', contextWindow: 200000, input: 1, output: 2 };

const payload = (): StatusPayload => ({
  model: { id: 'glm-4.6-custom', display_name: 'glm-4.6-custom' },
  context_window: {
    total_input_tokens: 1_000_000,
    total_output_tokens: 500_000,
    current_usage: { input_tokens: 50_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
});

function render(config: Config, entry?: object): Record<string, string | null> {
  const cfg: Config = entry ? { ...config, profiles: { models: [entry as never] } } : config;
  const ctx = createContext({
    payload: payload(),
    config: { ...cfg, colorLevel: 0 },
    env: { ANTHROPIC_BASE_URL: 'https://gw.example.com' },
    now: NOW,
    preview: true,
    terminalWidth: 140,
    data: { transcript: () => null },
  });
  return withoutSideEffects(() => ({
    model: renderWidget('model', ctx, { options: { profileLabel: true } }),
    length: renderWidget('context-length', ctx, { options: { showMax: true } }),
    pct: renderWidget('context-percentage', ctx),
    cost: renderWidget('session-cost', ctx, { options: { basis: 'auto' } }),
  }));
}

describe('profiles.models on a gateway payload', () => {
  it('label, window and prices come from the override', () => {
    const out = render(defaultConfig(), ENTRY);
    expect(out.model).toBe('GLM 4.6');
    expect(out.length).toBe('50k/200k');
    expect(out.pct).toContain('25%');
    expect(out.cost).toBe('$2.00');
  });

  it('a larger override window is used', () => {
    const out = render(defaultConfig(), { ...ENTRY, contextWindow: 400000 });
    expect(out.length).toBe('50k/400k');
    expect(out.pct).toContain('13%');
  });

  it('without an override the widgets match a config with no profiles key', () => {
    const a = render(defaultConfig());
    const b = render({ ...defaultConfig(), profiles: undefined });
    expect(a).toEqual(b);
    expect(a.model).toBe('GLM-4.6');
  });
});
