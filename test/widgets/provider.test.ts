import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { t } from '../../src/core/i18n/index.js';
import { inspectRows } from '../../src/core/inspect.js';
import { PRESETS, starterConfig } from '../../src/core/presets.js';
import { getScenario, SCENARIO_NOW, scenarioConfig } from '../../src/core/scenarios.js';
import type { RenderContext } from '../../src/core/types.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, renderWidget, withoutSideEffects } from '../helpers.js';

const glm = { id: 'glm-5.3', display_name: 'glm-5.3' };
const show = (env: NodeJS.ProcessEnv, options: Record<string, boolean> = {}, model = glm) =>
  renderWidget('provider', ctxWith({ env, payload: { model } }), { options });

function scenarioCtx(id: string): RenderContext {
  const b = getScenario(id)!.build(SCENARIO_NOW);
  return createContext({
    payload: b.payload,
    config: scenarioConfig({ ...defaultConfig(), colorLevel: 0 }, b),
    env: { ...b.env },
    now: new Date(SCENARIO_NOW),
    preview: true,
    data: b.data,
  });
}

describe('provider widget', () => {
  it('is an opt-in session widget with an option, sample and sources', () => {
    const def = getWidget('provider')!;
    expect(def.category).toBe('session');
    expect(def.sample).toBe('Bedrock');
    expect(def.sources?.length).toBeGreaterThan(0);
    const o = def.options?.find((x) => x.key === 'showFirstParty');
    expect(o).toMatchObject({ kind: 'boolean', default: false });
    expect(o?.help).toBeTruthy();
  });

  it('labels each cloud provider and API keys', () => {
    expect(show({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('Bedrock');
    expect(show({ CLAUDE_CODE_USE_VERTEX: '1' })).toBe('Vertex');
    expect(show({ CLAUDE_CODE_USE_FOUNDRY: '1' })).toBe('Foundry');
    expect(show({ CLAUDE_CODE_USE_MANTLE: '1' })).toBe('Mantle');
    expect(show({ CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' })).toBe('AWS');
    expect(show({ ANTHROPIC_API_KEY: 'sk-ant-secret-value' })).toBe('API key');
  });

  it('shows the vendor and host for a gateway', () => {
    expect(show({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' })).toBe('GLM via api.z.ai');
    expect(show({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' })).toBe('GLM via openrouter.ai');
    expect(
      show({ ANTHROPIC_BASE_URL: 'https://api.example.com/v1' }, {}, { id: 'x-1', display_name: 'x-1' }),
    ).toBe('api.example.com');
  });

  it('turns built-in vendors off with profiles.builtIn false', () => {
    const ctx = ctxWith({
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
      payload: { model: glm },
      config: { profiles: { builtIn: false } },
    });
    expect(renderWidget('provider', ctx)).toBe('api.z.ai');
  });

  it('never prints an escape sequence or a secret', () => {
    for (const url of ['https://a\u001b[31m.example.com/', 'https://xn--e1afmkfd.example/\u0007']) {
      const out = show({ ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'sk-ant-secret-value' });
      expect(out ?? '').not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(out ?? '').not.toContain('sk-ant-secret-value');
    }
    expect(show({ ANTHROPIC_AUTH_TOKEN: 'tok-secret' })).toBe('API key');
  });

  it('is hidden for first party unless showFirstParty', () => {
    expect(show({})).toBeNull();
    expect(show({}, { showFirstParty: true })).toBe(t('widget.provider.firstParty'));
    expect(show({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'o' })).toBeNull();
  });

  it('explains a first-party null', () => {
    const ctx = ctxWith({ env: {}, config: { lines: [[{ id: 'p', type: 'provider' }]] } });
    const row = withoutSideEffects(() => inspectRows(ctx))[0]!;
    expect(row.value).toBeNull();
    expect(row.empty?.text).toBe(t('explain.reason.providerFirstParty'));
  });

  it('renders under the provider scenarios', () => {
    const at = (id: string) => withoutSideEffects(() => renderWidget('provider', scenarioCtx(id)));
    expect(at('bedrock-user')).toBe('Bedrock');
    expect(at('gateway-glm')).toBe('GLM via api.z.ai');
    expect(at('api-key-user')).toBe('API key');
    expect(at('fresh-session')).toBeNull();
  });

  it('is in no preset and no default layout', () => {
    const configs = [
      defaultConfig(),
      starterConfig(true),
      starterConfig(false),
      ...PRESETS.map((p) => p.build()),
    ];
    for (const c of configs) expect(JSON.stringify(c)).not.toContain('"provider"');
  });
});

describe('model profileLabel', () => {
  const model = (id: string, options: Record<string, boolean>) =>
    withoutSideEffects(() => renderWidget('model', scenarioCtx(id), { options }));

  it('shows the profile model name under a gateway when on', () => {
    expect(model('gateway-glm', { profileLabel: true })).toBe('GLM-5.3');
    expect(model('gateway-glm', {})).toBe('glm-5.3');
    expect(model('gateway-glm', { profileLabel: false, showId: true })).toBe('glm-5.3');
  });

  it('leaves first-party sessions alone', () => {
    expect(model('fresh-session', { profileLabel: true })).toBe('Opus 5.5');
    expect(model('fresh-session', {})).toBe('Opus 5.5');
  });

  it('uses an override label for any provider', () => {
    const ctx = ctxWith({
      payload: { model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } },
      config: { profiles: { models: [{ match: 'claude-opus-*', label: 'Big Opus' }] } },
    });
    expect(renderWidget('model', ctx, { options: { profileLabel: true } })).toBe('Big Opus');
    expect(renderWidget('model', ctx)).toBe('Opus 5.5');
  });

  it('falls back when no profile matches', () => {
    const ctx = ctxWith({
      env: { ANTHROPIC_BASE_URL: 'https://api.example.com' },
      payload: { model: { id: 'mystery-1' } },
    });
    expect(renderWidget('model', ctx, { options: { profileLabel: true } })).toBe('mystery-1');
  });
});
