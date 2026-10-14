import fs from 'node:fs';
import { detectLevel, style } from '../core/ansi.js';
import { createContext } from '../core/context.js';
import { loadForUse } from '../core/load.js';
import { lastPayloadPath } from '../core/paths.js';
import { ingestPayload } from '../core/payload.js';
import { finalizeLine, render } from '../core/renderer.js';
import type { Config, StatusPayload } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { writeAtomic } from '../data/store.js';
import { terminalWidth } from '../data/terminal.js';
import { scheduleCheck, updateNotice } from '../data/update-state.js';
import {
  mergeUsage,
  needsUsage,
  readUsageCache,
  scheduleUsage,
  usageApiDisabled,
  usageDue,
} from '../data/usage.js';
import type { Args } from './args.js';

export function readStdin(timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

export function savePayload(payload: StatusPayload): void {
  try {
    writeAtomic(lastPayloadPath(), JSON.stringify(payload));
  } catch {}
}

export function renderStatus(config: Config, payload: StatusPayload, widthFlag?: number): string[] {
  const width = widthFlag ?? terminalWidth(payload.session_id, payload.terminal_width ?? payload.columns);
  return render(createContext({ payload, config, terminalWidth: width }));
}

export async function runRender(args: Args, cfgFile: string): Promise<void> {
  const config = loadForUse(cfgFile).config;
  let raw: string;
  if (typeof args.flags.payload === 'string') raw = fs.readFileSync(args.flags.payload, 'utf8');
  else raw = await readStdin();
  const payload = ingestPayload(raw);
  if (!payload) {
    process.stdout.write('ccinfobar: invalid JSON on stdin\n');
    return;
  }
  if (config.savePayload && typeof args.flags.payload !== 'string') savePayload(payload);
  const width = typeof args.flags.width === 'string' ? Number(args.flags.width) : undefined;
  const usageOn = !usageApiDisabled(config) && needsUsage(config, payload);
  const usage = usageOn ? readUsageCache() : null;
  const lines = renderStatus(config, usage ? mergeUsage(payload, usage) : payload, width);
  const notice = updateNotice(config, VERSION);
  if (notice && lines.length) {
    const level = detectLevel(config.colorLevel);
    lines[lines.length - 1] += ` ${style(notice, { fg: 'yellow' }, level)}`;
  }
  process.stdout.write(lines.map(finalizeLine).join('\n') + (lines.length ? '\n' : ''));
  scheduleCheck(config, payload.session_id);
  if (usageOn && usageDue(usage)) scheduleUsage();
}
