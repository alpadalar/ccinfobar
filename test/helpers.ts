import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { resetLanguageCache } from '../src/cli/lang.js';
import { defaultConfig } from '../src/core/config.js';
import { createContext } from '../src/core/context.js';
import {
  activeLanguage,
  type LanguageDef,
  type LanguageId,
  setLanguage,
  withLanguage,
} from '../src/core/i18n/index.js';
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

export function withLang<T>(lang: LanguageId | LanguageDef, fn: () => T): T {
  return withLanguage(lang, fn);
}

// keeps the language across awaits
export async function withLangAsync<T>(lang: LanguageId | LanguageDef, fn: () => Promise<T>): Promise<T> {
  const prev = setLanguage(lang);
  try {
    return await fn();
  } finally {
    setLanguage(prev);
  }
}

// CCINFOBAR_LANG for code that resolves the env language itself
export function withEnvLang<T>(lang: string, fn: () => T): T {
  const prev = process.env.CCINFOBAR_LANG;
  process.env.CCINFOBAR_LANG = lang;
  resetLanguageCache();
  try {
    return withLanguage(activeLanguage(), fn);
  } finally {
    if (prev === undefined) delete process.env.CCINFOBAR_LANG;
    else process.env.CCINFOBAR_LANG = prev;
    resetLanguageCache();
  }
}

export function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

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

// an empty ccinfobar.js as argv[1]: spawnSelf starts a worker that exits at once, so its locks stay
export function useIdleEntry(): void {
  let prev: string | undefined;
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT ?? os.tmpdir(), 'entry-'));
    fs.writeFileSync(path.join(dir, 'ccinfobar.js'), '');
    prev = process.argv[1];
    process.argv[1] = path.join(dir, 'ccinfobar.js');
  });
  afterAll(() => {
    if (prev !== undefined) process.argv[1] = prev;
  });
}

// node 26 children ignore a replaced process.env object
export function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}
