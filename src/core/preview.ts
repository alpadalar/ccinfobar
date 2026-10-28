import fs from 'node:fs';
import { readAgents } from '../data/agents.js';
import { readEnvironment } from '../data/environment.js';
import { readHookState } from '../data/hooks.js';
import { ledgerOn, ledgerView, projectRoot, readLedger } from '../data/ledger.js';
import { accountKey } from '../data/limits.js';
import { hookTurnStart } from '../data/live.js';
import { readRepos } from '../data/repos.js';
import { readSandbox } from '../data/sandbox.js';
import { readTranscript } from '../data/transcript.js';
import { effectiveUsage } from '../data/usage.js';
import { createContext, lazy, resolveCwd } from './context.js';
import { scenarioText } from './i18n/catalog-text.js';
import { t } from './i18n/index.js';
import { hasItemRules } from './metrics.js';
import { lastPayloadPath } from './paths.js';
import { ingestPayload } from './payload.js';
import { overflowOf, render } from './renderer.js';
import {
  sampleAgents,
  sampleEnvironment,
  sampleGit,
  sampleGsd,
  sampleHistory,
  sampleHooks,
  sampleJj,
  sampleJobs,
  sampleLedger,
  sampleLimits,
  samplePayload,
  sampleSandbox,
  sampleTranscript,
} from './sample.js';
import { sanitizeText } from './sanitize.js';
import { getScenario, SCENARIO_NOW, scenarioConfig, scenarioEnv, scenarioList } from './scenarios.js';
import { type Theme, withActiveTheme } from './themes.js';
import type { Config, RenderContext, StatusPayload } from './types.js';
import { padVisible, visibleWidth } from './width.js';

export type PreviewSource = 'sample' | 'last' | { scenario: string };

export type ScenarioFlag =
  | { kind: 'none' }
  | { kind: 'list' }
  | { kind: 'scenario'; id: string }
  | { kind: 'unknown'; name: string };

export function scenarioFlag(value: string | boolean | undefined): ScenarioFlag {
  if (value === undefined || value === false) return { kind: 'none' };
  if (value === true || value === '') return { kind: 'list' };
  return getScenario(value) ? { kind: 'scenario', id: value } : { kind: 'unknown', name: value };
}

export function scenarioListLines(): string[] {
  const list = scenarioList().map((s) => ({
    id: sanitizeText(s.id),
    description: sanitizeText(scenarioText(s, 'description')),
  }));
  const pad = Math.max(0, ...list.map((s) => visibleWidth(s.id)));
  return [
    t('preview.scenariosHeader'),
    ...list.map((s) => t('preview.scenarioLine', { id: padVisible(s.id, pad), description: s.description })),
  ];
}

export function readLastPayload(env: NodeJS.ProcessEnv = process.env): StatusPayload | null {
  try {
    return ingestPayload(fs.readFileSync(lastPayloadPath(env), 'utf8'));
  } catch {
    return null;
  }
}

export function renderPreview(config: Config, source: PreviewSource, width: number, theme?: Theme): string[] {
  return render({ ...previewContext(config, source, width, theme), values: new Map() });
}

export interface PreviewHidden {
  hidden: string[];
  dropped: string[];
}

// WR-08: one render gives the lines and what rules or priority overflow hid
export function renderPreviewReport(
  config: Config,
  source: PreviewSource,
  width: number,
  theme?: Theme,
): PreviewHidden & { lines: string[] } {
  const sink = { hidden: [] as string[], dropped: [] as string[] };
  const lines = render({ ...previewContext(config, source, width, theme), values: new Map(), sink });
  const order = new Map(config.lines.flat().map((i, n) => [i.id, n]));
  const sorted = (ids: string[]) =>
    [...new Set(ids)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { lines, hidden: sorted([...sink.hidden, ...sink.dropped]), dropped: sorted(sink.dropped) };
}

// dropped: the hidden ids that priority overflow removed
export function previewHiddenBy(
  config: Config,
  source: PreviewSource,
  width: number,
  theme?: Theme,
): PreviewHidden {
  if (overflowOf(config) !== 'priority' && !config.lines.some((l) => l.some(hasItemRules))) {
    return { hidden: [], dropped: [] };
  }
  const { hidden, dropped } = renderPreviewReport(config, source, width, theme);
  return { hidden, dropped };
}

export function previewHidden(config: Config, source: PreviewSource, width: number, theme?: Theme): string[] {
  return previewHiddenBy(config, source, width, theme).hidden;
}

function previewContext(raw: Config, source: PreviewSource, width: number, theme?: Theme): RenderContext {
  const config = theme ? raw : withActiveTheme(raw, new Date());
  if (typeof source === 'object') {
    const scenario = getScenario(source.scenario);
    if (!scenario) throw new Error(t('err.preview.unknownScenario'));
    const bundle = scenario.build(SCENARIO_NOW);
    return createContext({
      payload: bundle.payload,
      config: scenarioConfig(config, bundle),
      env: scenarioEnv(process.env, bundle.env),
      now: new Date(SCENARIO_NOW),
      preview: true,
      terminalWidth: width,
      ...(theme ? { theme } : {}),
      data: bundle.data,
    });
  }
  const last = source === 'last' ? readLastPayload() : null;
  const env = { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined };
  if (last) {
    const transcript = lazy(() => readTranscript(last.transcript_path, env, { persist: false }));
    const eff = effectiveUsage(config, last, env, { transcript });
    const hooks = lazy(() =>
      last.session_id ? readHookState(last.session_id, env, { persist: false }) : null,
    );
    return createContext({
      payload: eff.payload,
      config,
      env,
      preview: true,
      terminalWidth: width,
      ...(theme ? { theme } : {}),
      data: {
        transcript,
        agents: lazy(() => {
          const h = hooks();
          const t = transcript();
          const n = Date.now();
          const turnStart = hookTurnStart(h, t, last.prompt_id, n);
          return readAgents(last.transcript_path, t, n, env, { persist: false, hooks: h, turnStart });
        }),
        limits: () => eff.limits,
        repos: lazy(() => readRepos(resolveCwd(last), env, { persist: false })),
        hooks,
        environment: lazy(() => {
          const cwd = resolveCwd(last);
          return readEnvironment(last.workspace?.project_dir ?? cwd, cwd, env, { persist: false });
        }),
        sandbox: lazy(() => readSandbox(last.workspace?.project_dir ?? resolveCwd(last), env)),
        ...(ledgerOn(config)
          ? {
              ledger: lazy(() => {
                const now = Date.now();
                const read = readLedger(env, now, { persist: false });
                return ledgerView(read.summary, accountKey(env), projectRoot(last), now, {
                  session: last.session_id,
                  c: last.cost?.total_cost_usd,
                });
              }),
            }
          : {}),
      },
    });
  }
  const now = Date.now();
  const payload = samplePayload(now);
  return createContext({
    payload,
    config,
    env,
    preview: true,
    terminalWidth: width,
    ...(theme ? { theme } : {}),
    data: {
      git: sampleGit,
      gsd: sampleGsd,
      jj: sampleJj,
      transcript: () => sampleTranscript(now),
      history: () => sampleHistory(now),
      agents: () => sampleAgents(now),
      limits: () => sampleLimits(now, payload.rate_limits ?? null),
      ledger: () => sampleLedger(now),
      repos: () => null,
      hooks: () => sampleHooks(now),
      environment: sampleEnvironment,
      sandbox: sampleSandbox,
      jobs: () => sampleJobs(now),
    },
  });
}
