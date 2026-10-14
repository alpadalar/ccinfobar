import fs from 'node:fs';
import { createContext } from './context.js';
import { t } from './i18n/index.js';
import { lastPayloadPath } from './paths.js';
import { ingestPayload } from './payload.js';
import { render } from './renderer.js';
import {
  sampleAgents,
  sampleGit,
  sampleGsd,
  sampleHistory,
  samplePayload,
  sampleTranscript,
} from './sample.js';
import { sanitizeText } from './sanitize.js';
import { getScenario, SCENARIO_NOW, scenarioEnv, scenarioList } from './scenarios.js';
import type { Theme } from './themes.js';
import type { Config, StatusPayload } from './types.js';

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
    description: sanitizeText(s.description),
  }));
  const pad = Math.max(0, ...list.map((s) => s.id.length));
  return [
    t('preview.scenariosHeader'),
    ...list.map((s) => t('preview.scenarioLine', { id: s.id.padEnd(pad), description: s.description })),
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
  if (typeof source === 'object') {
    const scenario = getScenario(source.scenario);
    if (!scenario) throw new Error('unknown scenario');
    const bundle = scenario.build(SCENARIO_NOW);
    return render(
      createContext({
        payload: bundle.payload,
        config,
        env: scenarioEnv(process.env, bundle.env),
        now: new Date(SCENARIO_NOW),
        preview: true,
        terminalWidth: width,
        ...(theme ? { theme } : {}),
        data: bundle.data,
      }),
    );
  }
  const last = source === 'last' ? readLastPayload() : null;
  const env = { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined };
  if (last) {
    return render(
      createContext({
        payload: last,
        config,
        env,
        preview: true,
        terminalWidth: width,
        ...(theme ? { theme } : {}),
      }),
    );
  }
  const now = Date.now();
  return render(
    createContext({
      payload: samplePayload(now),
      config,
      env,
      preview: true,
      terminalWidth: width,
      ...(theme ? { theme } : {}),
      data: {
        git: sampleGit,
        gsd: sampleGsd,
        transcript: () => sampleTranscript(now),
        history: () => sampleHistory(now),
        agents: () => sampleAgents(now),
      },
    }),
  );
}
