import fs from 'node:fs';
import { createContext } from './context.js';
import { lastPayloadPath } from './paths.js';
import { render } from './renderer.js';
import { sampleGit, sampleGsd, samplePayload, sampleTranscript } from './sample.js';
import type { Theme } from './themes.js';
import type { Config, StatusPayload } from './types.js';

export type PreviewSource = 'sample' | 'last';

export function readLastPayload(): StatusPayload | null {
  try {
    return JSON.parse(fs.readFileSync(lastPayloadPath(), 'utf8')) as StatusPayload;
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
      data: { git: sampleGit, gsd: sampleGsd, transcript: () => sampleTranscript(now) },
    }),
  );
}
