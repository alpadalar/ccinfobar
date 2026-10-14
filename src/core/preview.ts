import fs from 'node:fs';
import { createContext } from './context.js';
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
import type { Theme } from './themes.js';
import type { Config, StatusPayload } from './types.js';

export type PreviewSource = 'sample' | 'last';

export function readLastPayload(): StatusPayload | null {
  try {
    return ingestPayload(fs.readFileSync(lastPayloadPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function renderPreview(config: Config, source: PreviewSource, width: number, theme?: Theme): string[] {
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
