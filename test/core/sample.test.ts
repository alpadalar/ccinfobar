import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { samplePayload, sampleSandbox } from '../../src/core/sample.js';
import type { StatusPayload } from '../../src/core/types.js';

describe('sample payload prompt_cache', () => {
  it('carries recache_tokens_if_cold and miss_causes', () => {
    const pc = samplePayload().prompt_cache!;
    expect(pc.recache_tokens_if_cold).toBeGreaterThan(0);
    expect(Object.values(pc.miss_causes ?? {}).length).toBeGreaterThan(0);
    for (const v of Object.values(pc.miss_causes!)) expect(typeof v).toBe('number');
  });

  it('allows a null recache_tokens_if_cold', () => {
    const p: StatusPayload = { prompt_cache: { recache_tokens_if_cold: null } };
    expect(p.prompt_cache?.recache_tokens_if_cold).toBeNull();
  });
});

describe('sampleSandbox', () => {
  it('is enabled and not strict', () => {
    expect(sampleSandbox()).toEqual({ enabled: true, strict: false });
  });
});

describe('data.sandbox', () => {
  it('is a source and honours an injected value', () => {
    const ctx = createContext({
      payload: samplePayload(),
      config: defaultConfig(),
      data: { sandbox: () => ({ enabled: false, strict: true }) },
    });
    expect(ctx.data.sandbox?.()).toEqual({ enabled: false, strict: true });
    const bare = createContext({ payload: samplePayload(), config: defaultConfig() });
    expect(typeof bare.data.sandbox).toBe('function');
  });
});
