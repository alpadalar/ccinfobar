import { defaultConfig } from '../src/core/config.js';
import { createContext } from '../src/core/context.js';
import { sampleGit, sampleGsd, samplePayload, sampleTranscript } from '../src/core/sample.js';
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
    width?: number | null;
  } = {},
): RenderContext {
  return createContext({
    payload: overrides.payload ?? samplePayload(NOW.getTime()),
    config: { ...defaultConfig(), colorLevel: 0, ...overrides.config },
    env: {},
    now: NOW,
    terminalWidth: overrides.width ?? null,
    data: {
      git: overrides.git ?? sampleGit,
      gsd: overrides.gsd ?? sampleGsd,
      transcript: overrides.transcript ?? (() => sampleTranscript(NOW.getTime())),
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
