import fs from 'node:fs';
import { detectLevel, style } from '../core/ansi.js';
import { createContext, lazy, resolveCwd } from '../core/context.js';
import { t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { lastPayloadPath } from '../core/paths.js';
import { ingestPayload } from '../core/payload.js';
import { finalizeLine, render } from '../core/renderer.js';
import type { Config, DataSources, StatusPayload } from '../core/types.js';
import { VERSION } from '../core/version.js';
import {
  ledgerOn,
  ledgerView,
  projectRoot,
  RENDER_BUDGET,
  readLedger,
  recordLedger,
} from '../data/ledger.js';
import { accountKey, recordLimits } from '../data/limits.js';
import { readRepos, repoDirtyWanted, scheduleRepoDirty } from '../data/repos.js';
import { writeAtomic } from '../data/store.js';
import { terminalWidth } from '../data/terminal.js';
import { readTranscript } from '../data/transcript.js';
import { scheduleCheck, updateNotice } from '../data/update-state.js';
import { effectiveUsage, scheduleUsage, usageDue } from '../data/usage.js';
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
    writeAtomic(lastPayloadPath(), JSON.stringify(payload), { mode: 0o600 });
  } catch {}
}

export function renderStatus(
  config: Config,
  payload: StatusPayload,
  widthFlag?: number,
  data?: Partial<DataSources>,
): string[] {
  const width = widthFlag ?? terminalWidth(payload.session_id, payload.terminal_width ?? payload.columns);
  return render(createContext({ payload, config, terminalWidth: width, ...(data ? { data } : {}) }));
}

function safeLine(text: string): void {
  process.stdout.write(`${style(text, { dim: true }, detectLevel('auto'))}\n`);
}

export async function runRender(args: Args, cfgFile: string): Promise<void> {
  try {
    await renderOnce(args, cfgFile);
  } catch {
    try {
      safeLine(t('safe.render'));
    } catch {}
  }
}

async function renderOnce(args: Args, cfgFile: string): Promise<void> {
  const loaded = loadForUse(cfgFile);
  if (loaded.issue) {
    safeLine(t('safe.line', { line: loaded.issue.line }));
    return;
  }
  const config = loaded.config;
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
  const transcript = lazy(() => readTranscript(payload.transcript_path));
  const eff = effectiveUsage(config, payload, process.env, { transcript });
  const cwd = resolveCwd(eff.payload);
  const repos = lazy(() => readRepos(cwd, process.env));
  const data: Partial<DataSources> = { transcript, limits: () => eff.limits, repos };
  const ledgerUsed = ledgerOn(config);
  const ledger = lazy(() => readLedger(process.env, Date.now(), { budget: RENDER_BUDGET }));
  if (ledgerUsed) {
    data.ledger = lazy(() => {
      const read = ledger();
      return read
        ? ledgerView(read.summary, accountKey(process.env), projectRoot(payload), Date.now(), {
            session: payload.session_id,
            c: payload.cost?.total_cost_usd,
          })
        : null;
    });
  }
  const lines = renderStatus(config, eff.payload, width, data);
  let notice: string | null = null;
  try {
    notice = updateNotice(config, VERSION);
  } catch {}
  if (notice && lines.length) {
    const level = detectLevel(config.colorLevel);
    lines[lines.length - 1] += ` ${style(notice, { fg: 'yellow' }, level)}`;
  }
  process.stdout.write(lines.map(finalizeLine).join('\n') + (lines.length ? '\n' : ''));
  try {
    if (eff.limitsOn) recordLimits(process.env, payload, eff.captureAt, Date.now());
    if (ledgerUsed) {
      const read = ledger();
      if (read) recordLedger(process.env, payload, read, Date.now());
    }
    scheduleCheck(config, payload.session_id);
    if (eff.usageOn && usageDue(eff.usage)) scheduleUsage();
    if (repoDirtyWanted(config)) scheduleRepoDirty(cwd, repos(), process.env, Date.now());
  } catch {}
}
