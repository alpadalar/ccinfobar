import fs from 'node:fs';
import path from 'node:path';
import { detectLevel, style } from '../core/ansi.js';
import { createContext, lazy, resolveCwd } from '../core/context.js';
import { needsWidth } from '../core/display-opts.js';
import { t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { lastPayloadPath } from '../core/paths.js';
import { ingestPayload } from '../core/payload.js';
import { finalizeLine, render } from '../core/renderer.js';
import { resolveTheme, withActiveTheme } from '../core/themes.js';
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
import { cachedTerminalWidth, terminalWidth } from '../data/terminal.js';
import { readTranscript } from '../data/transcript.js';
import { rejectedUpdate, updateNotice, updatesDisabled } from '../data/update-state.js';
import { effectiveUsage } from '../data/usage.js';
import type { Args } from './args.js';
import { intFlag } from './flags.js';
import { prepareLanguage } from './lang.js';
import { syncProgress } from './progress.js';
import { type TtyDeps, writeTty } from './progress-tty.js';

// own copy: importing core/version.ts costs the render one more chunk
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

type StdinStream = NodeJS.ReadableStream & { unref?: () => void };

export function readStdin(
  timeoutMs = 3000,
  capBytes = 4 * 1024 * 1024,
  stream: StdinStream = process.stdin,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (text: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onEnd);
      stream.pause();
      stream.unref?.();
      resolve(text);
    };
    const onData = (chunk: Buffer | string): void => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (size + b.length > capBytes) {
        finish(null);
        return;
      }
      size += b.length;
      chunks.push(b);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(onEnd, timeoutMs);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onEnd);
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
  const now = new Date();
  const cfg = withActiveTheme(config, now);
  const theme = resolveTheme(cfg.theme);
  const hint = payload.terminal_width ?? payload.columns;
  const width =
    widthFlag ??
    (needsWidth(cfg)
      ? terminalWidth(payload.session_id, hint)
      : cachedTerminalWidth(payload.session_id, hint));
  return createContext({
    payload,
    config: cfg,
    theme,
    now,
    terminalWidth: width,
    ...(data ? { data } : {}),
  });
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
    await prepareLanguage();
    safeLine(t('safe.line', { line: loaded.issue.line }));
    return;
  }
  const config = loaded.config;
  await prepareLanguage(config);
  let width: number | undefined;
  try {
    width = intFlag(args, 'width', 1, 10000);
  } catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  let raw: string | null;
  if (typeof args.flags.payload === 'string') raw = fs.readFileSync(args.flags.payload, 'utf8');
  else raw = await readStdin();
  if (raw === null) {
    process.stdout.write(`${t('cli.invalidJson')}\n`);
    return;
  }
  const payload = ingestPayload(raw);
  if (!payload) {
    process.stdout.write(`${t('cli.invalidJson')}\n`);
    return;
  }
  if (config.savePayload && typeof args.flags.payload !== 'string') savePayload(payload);
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
  let notice: string | null = null;
  try {
    notice = updateNotice(config, VERSION);
    if (!updatesDisabled(config)) {
      const rej = rejectedUpdate(VERSION);
      if (rej) notice = t('update.rejected', { version: rej.rejected, current: VERSION });
    }
  } catch {}
  const lines = render(ctx, { notice: notice ?? undefined });
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
