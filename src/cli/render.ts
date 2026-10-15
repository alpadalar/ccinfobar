import fs from 'node:fs';
import path from 'node:path';
import { detectLevel, style } from '../core/ansi.js';
import { createContext, lazy, resolveCwd } from '../core/context.js';
import { t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { lastPayloadPath } from '../core/paths.js';
import { ingestPayload } from '../core/payload.js';
import { finalizeLine, render } from '../core/renderer.js';
import type { Config, DataSources, RenderContext, StatusPayload } from '../core/types.js';
import { scheduleJobs } from '../data/jobs/index.js';
import {
  ledgerOn,
  ledgerView,
  projectRoot,
  RENDER_BUDGET,
  readLedger,
  recordLedger,
} from '../data/ledger.js';
import { accountKey, recordLimits } from '../data/limits.js';
import { progressFiles, progressSeq } from '../data/progress.js';
import { readRepos } from '../data/repos.js';
import { writeAtomic } from '../data/store.js';
import { terminalWidth } from '../data/terminal.js';
import { readTranscript } from '../data/transcript.js';
import { updateNotice } from '../data/update-state.js';
import { effectiveUsage } from '../data/usage.js';
import type { Args } from './args.js';
import { applyLanguage } from './lang.js';
import { syncProgress } from './progress.js';
import { type TtyDeps, writeTty } from './progress-tty.js';

// own copy: importing core/version.ts costs the render one more chunk
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

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

function statusContext(
  config: Config,
  payload: StatusPayload,
  widthFlag?: number,
  data?: Partial<DataSources>,
): RenderContext {
  const width = widthFlag ?? terminalWidth(payload.session_id, payload.terminal_width ?? payload.columns);
  return createContext({ payload, config, terminalWidth: width, ...(data ? { data } : {}) });
}

export function renderStatus(
  config: Config,
  payload: StatusPayload,
  widthFlag?: number,
  data?: Partial<DataSources>,
): string[] {
  return render(statusContext(config, payload, widthFlag, data));
}

function safeLine(text: string): void {
  process.stdout.write(`${style(text, { dim: true }, detectLevel('auto'))}\n`);
}

export async function runRender(args: Args, cfgFile: string, tty?: TtyDeps): Promise<void> {
  try {
    await renderOnce(args, cfgFile, tty);
  } catch {
    try {
      safeLine(t('safe.render'));
    } catch {}
  }
}

async function renderOnce(args: Args, cfgFile: string, tty?: TtyDeps): Promise<void> {
  const loaded = loadForUse(cfgFile);
  if (loaded.issue) {
    safeLine(t('safe.line', { line: loaded.issue.line }));
    return;
  }
  const config = loaded.config;
  applyLanguage(config);
  let raw: string;
  if (typeof args.flags.payload === 'string') raw = fs.readFileSync(args.flags.payload, 'utf8');
  else raw = await readStdin();
  const payload = ingestPayload(raw);
  if (!payload) {
    process.stdout.write(`${t('cli.invalidJson')}\n`);
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
  const ctx = statusContext(config, eff.payload, width, data);
  const lines = render(ctx);
  let notice: string | null = null;
  try {
    notice = updateNotice(config, VERSION);
  } catch {}
  if (notice && lines.length) {
    const level = detectLevel(config.colorLevel);
    lines[lines.length - 1] += ` ${style(notice, { fg: 'yellow' }, level)}`;
  }
  // NBSP in every mode: Claude Code trims and collapses plain spaces (WR-05)
  process.stdout.write(lines.map((l) => finalizeLine(l)).join('\n') + (lines.length ? '\n' : ''));
  try {
    if (eff.limitsOn) recordLimits(process.env, payload, eff.captureAt, Date.now());
    if (ledgerUsed) {
      const read = ledger();
      if (read) recordLedger(process.env, payload, read, Date.now());
    }
    scheduleJobs(config, payload, process.env, path.resolve(cwd), cfgFile, { repos });
  } catch {}
  try {
    const p = config.progress;
    const sync = p ? syncProgress(ctx, process.env, tty?.platform) : null;
    if (p && sync?.changed && sync.want?.channel === 'tty') {
      const cache = progressFiles(payload.session_id ?? '', process.env)?.tty;
      const opts = { tmuxPassthrough: p.tmuxPassthrough === true, always: sync.want.always, cache };
      writeTty(progressSeq(sync.want.state, sync.want.pct), process.env, opts, tty);
    }
  } catch {}
}
