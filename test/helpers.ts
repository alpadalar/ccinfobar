import { defaultConfig } from '../src/core/config.js';
import { createContext } from '../src/core/context.js';
import {
  sampleAgents,
  sampleEnvironment,
  sampleGit,
  sampleGsd,
  sampleHistory,
  sampleHooks,
  sampleJobs,
  sampleLedger,
  sampleLimits,
  samplePayload,
  sampleTranscript,
} from '../src/core/sample.js';
import type { Config, RenderContext, StatusPayload, WidgetItem } from '../src/core/types.js';
import { getWidget } from '../src/widgets/index.js';

export const NOW = new Date('2026-10-12T12:00:00Z');

export function ctxWith(
  overrides: {
    payload?: StatusPayload;
    config?: Partial<Config>;
    git?: RenderContext['data']['git'];
    gsd?: RenderContext['data']['gsd'];
    transcript?: RenderContext['data']['transcript'];
    history?: RenderContext['data']['history'];
    limits?: RenderContext['data']['limits'];
    ledger?: RenderContext['data']['ledger'];
    agents?: RenderContext['data']['agents'];
    repos?: RenderContext['data']['repos'];
    hooks?: RenderContext['data']['hooks'];
    environment?: RenderContext['data']['environment'];
    jobs?: RenderContext['data']['jobs'];
    width?: number | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): RenderContext {
  return createContext({
    payload: overrides.payload ?? samplePayload(NOW.getTime()),
    config: { ...defaultConfig(), colorLevel: 0, ...overrides.config },
    env: overrides.env ?? {},
    now: NOW,
    terminalWidth: overrides.width ?? null,
    data: {
      git: overrides.git ?? sampleGit,
      gsd: overrides.gsd ?? sampleGsd,
      transcript: overrides.transcript ?? (() => sampleTranscript(NOW.getTime())),
      history: overrides.history ?? (() => sampleHistory(NOW.getTime())),
      agents: overrides.agents ?? (() => sampleAgents(NOW.getTime())),
      limits: overrides.limits ?? (() => sampleLimits(NOW.getTime())),
      ledger: overrides.ledger ?? (() => sampleLedger(NOW.getTime())),
      repos: overrides.repos ?? (() => null),
      hooks: overrides.hooks ?? (() => sampleHooks(NOW.getTime())),
      environment: overrides.environment ?? sampleEnvironment,
      jobs: overrides.jobs ?? (() => sampleJobs(NOW.getTime())),
    },
  });
}

export function renderWidget(
  type: string,
  ctx: RenderContext,
  item: Partial<WidgetItem> = {},
): string | null {
  const def = getWidget(type);
  if (!def) throw new Error(`unknown widget ${type}`);
  const out = def.render(ctx, { id: type, type, ...item });
  if (out === null || out === undefined) return null;
  return typeof out === 'string' ? out : out.text;
}

export function withoutSideEffects<T>(fn: () => T): T {
  globalThis.__ccibRenderGuard = true;
  try {
    return fn();
  } finally {
    globalThis.__ccibRenderGuard = false;
  }
}

export async function withoutSideEffectsAsync<T>(fn: () => Promise<T>): Promise<T> {
  globalThis.__ccibRenderGuard = true;
  try {
    return await fn();
  } finally {
    globalThis.__ccibRenderGuard = false;
  }
}
