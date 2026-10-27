import { describe, expect, it } from 'vitest';
import { samplePayload } from '../../src/core/sample.js';
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
