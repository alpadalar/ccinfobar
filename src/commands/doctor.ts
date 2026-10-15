import fs from 'node:fs';
import type { LoadResult } from '../core/config.js';
import { needsRefresh } from '../core/edit.js';
import { t } from '../core/i18n/index.js';
import { type InspectRow, inspectRows, lineReport, sessionNotes } from '../core/inspect.js';
import { loadForUse } from '../core/load.js';
import { titleWidgets } from '../core/panel.js';
import { cacheDir, claudeSettingsPath, lastPayloadPath, tildify } from '../core/paths.js';
import { readLastPayload } from '../core/preview.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionSpec, StatusPayload } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { readHookState } from '../data/hooks.js';
import { jobFor } from '../data/jobs/index.js';
import {
  blockedByTraffic,
  type JobEnvelope,
  jobsDir,
  jobsDisabled,
  readEnvelope,
  SAFE_KEY,
} from '../data/jobs/runner.js';
import { pruneTmp } from '../data/store.js';
import { cachedTerminalWidth } from '../data/terminal.js';
import {
  availableUpdate,
  installKind,
  nonessentialTrafficOff,
  readUpdateState,
  selfCommand,
  updatesDisabled,
} from '../data/update-state.js';
import { readUsageCache, type UsageCache, usageApiDisabled } from '../data/usage.js';
import { getWidget } from '../widgets/index.js';
import { loadInspectInput, redactValue, shortAge } from './explain.js';
import {
  commandResolves,
  entryCommand,
  hookEntryState,
  hookGateWarnings,
  managedSettingsFiles,
  readSettingsLayer,
  type SettingsLayer,
} from './hooks-doctor.js';
import { currentStatusLine, projectOverride, projectSettingsPath } from './install.js';
import {
  classifyOwner,
  findHookEntries,
  type Manifest,
  manifestFile,
  owns,
  readManifest,
} from './manifest.js';
import { backupsDir } from './settings-file.js';

export { hasReplies } from '../core/payload.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function validOption(spec: OptionSpec, v: unknown): boolean {
  if (spec.kind === 'select') return !spec.choices || spec.choices.some((c) => c.value === String(v));
  if (spec.kind === 'number')
    return (typeof v === 'number' || typeof v === 'string') && Number.isFinite(Number(v)) && v !== '';
  if (spec.kind === 'boolean') return typeof v === 'boolean' || v === 'true' || v === 'false';
  return true;
}

const safe = (v: unknown): string => sanitizeText(typeof v === 'string' ? v : String(JSON.stringify(v)));

export function configWarnings(raw: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.lines)) return out;
  raw.lines.forEach((items: unknown, index) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isRecord(item) || typeof item.type !== 'string' || !item.type) continue;
      const type = item.type;
      const def = getWidget(type);
      if (!def) {
        out.push(t('doctor.unknownWidget', { type: safe(type), line: index + 1 }));
        continue;
      }
      if (!isRecord(item.options)) continue;
      for (const [key, v] of Object.entries(item.options)) {
        const spec = def.options?.find((o) => o.key === key);
        if (spec && !validOption(spec, v))
          out.push(t('doctor.badOption', { type: safe(type), key: safe(key) }));
      }
    }
  });
  return out;
}

function rawConfig(file: string): unknown {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

export function commandWarnings(command: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [];
  const first = command.trimStart()[0];
  return command.includes('\\') || first === '"' || first === "'" ? [t('doctor.winCommand')] : [];
}

export function usageLine(
  config: Config,
  payload: StatusPayload,
  usage: UsageCache | null,
  now = Date.now(),
): string {
  if (payload.rate_limits?.five_hour && payload.rate_limits.seven_day)
    return 'Usage limits: from Claude Code';
  if (usageApiDisabled(config)) return 'Usage limits: usage API off (usageApi: false)';
  if (!usage) return 'Usage limits: usage API not called yet';
  const age = Math.round((now - usage.fetchedAt) / 60_000);
  const data = usage.rate_limits ? `from the usage API, ${age} min old` : 'no data from the usage API';
  return `Usage limits: ${data}${usage.error ? ` (last error: ${safe(usage.error)})` : ''}`;
}

function widgetRow(r: InspectRow): string | null {
  const name = safe(`${r.type}${r.id !== r.type ? ` (${r.id})` : ''}`);
  const at = `L${r.line + 1} ${name}`;
  const why = safe(r.empty?.text ?? '');
  switch (r.status) {
    case 'shown':
    case 'loading':
      return `  ✓ ${at}: ${safe(redactValue(r) ?? '')}`;
    case 'hidden':
      if (r.empty?.code === 'workspace-mode') return `  ✗ ${at}: ${t('doctor.row.workspaceHidden')}, ${why}`;
      if (getWidget(r.type)?.hideWhenEmpty) return `  ✗ ${at}: hidden, ${why}`;
      return `  ✗ ${at}: hidden (hideEmpty), ${why}`;
    case 'error':
      return `  ✗ ${at}: error, ${safe(r.error ?? '')}`;
    case 'skipped':
      return null;
    default:
      return `  – ${at}: shows —, ${why}`;
  }
}

const doctorWidth = (p: StatusPayload | null): number | null =>
  cachedTerminalWidth(p?.session_id, p?.terminal_width ?? p?.columns);

export function printWidgetReport(cfgFile: string, loaded?: LoadResult): void {
  console.log('\nWidgets');
  const data = loadInspectInput({
    cfgFile,
    fallback: 'none',
    widthOf: doctorWidth,
    ...(loaded ? { loaded } : {}),
  });
  if (!data) {
    console.log(t('doctor.noPayload'));
    return;
  }
  try {
    const payload = data.raw;
    const keys = Object.keys(payload).filter((k) => (payload as Record<string, unknown>)[k] !== undefined);
    console.log(
      `  Last payload: Claude Code ${safe(payload.version ?? 'unknown version')}, fields: ${safe(keys.sort().join(', '))}`,
    );
    for (const n of sessionNotes(payload)) console.log(`  ℹ ${n}`);
    console.log(`  ${usageLine(data.config, payload, readUsageCache())}`);
    const rows = inspectRows(data.ctx, {
      meta: data.meta,
      ...(data.commandEnv ? { commandEnv: data.commandEnv } : {}),
    });
    for (const r of rows) {
      const l = widgetRow(r);
      if (l !== null) console.log(l);
    }
    const lines = lineReport(data.commandEnv ? { ...data.ctx, env: data.commandEnv } : data.ctx);
    console.log(
      `\n  Width: ${data.width ?? 'unknown'} columns detected, ${lines[0]?.max ?? 'no'} usable after widthOffset`,
    );
    for (const l of lines.filter((x) => x.cut)) {
      console.log(
        `  ⚠ Line ${l.line + 1} needs ${l.width} columns and is cut with "…". Lower widthOffset, set autoWrap, or move widgets to another line.`,
      );
    }
    console.log(t('doctor.explainPointer'));
  } finally {
    data.cleanup();
  }
}

function printHooks(
  manifest: Manifest,
  settingsFile: string,
  dirs: Set<string>,
  last: StatusPayload | null,
  managedFiles: string[],
): void {
  const entries = manifest.readOnly ? [] : findHookEntries(manifest, settingsFile);
  if (!manifest.readOnly && entries.length === 0) console.log(t('doctor.hooks.off'));
  if (entries.length) {
    const versions = [...new Set(entries.map((e) => safe(e.claudeCode ?? 'unknown')))].join(', ');
    console.log(t('doctor.hooks.summary', { count: entries.length, versions }));
    const user = readSettingsLayer('user', settingsFile).data ?? {};
    const missing = new Map<string, number>();
    for (const e of entries) {
      console.log(
        t('doctor.hooks.entry', { event: safe(e.event), claudeCode: safe(e.claudeCode ?? 'unknown') }),
      );
      if (hookEntryState(e, user) === 'edited')
        console.log(t('doctor.hooks.edited', { event: safe(e.event) }));
      const cmd = entryCommand(e);
      if (cmd !== null && !commandResolves(cmd)) missing.set(cmd, (missing.get(cmd) ?? 0) + 1);
    }
    for (const [command, count] of missing)
      console.log(t('doctor.hooks.missingBinary', { command: safe(command), count }));
  }
  const layers: SettingsLayer[] = [readSettingsLayer('user', settingsFile)];
  for (const dir of dirs) {
    layers.push(readSettingsLayer('project', projectSettingsPath(dir, false)));
    layers.push(readSettingsLayer('local', projectSettingsPath(dir, true)));
  }
  for (const f of managedFiles) layers.push(readSettingsLayer('managed', f));
  for (const w of hookGateWarnings(layers)) {
    const params = Object.fromEntries(Object.entries(w.params).map(([k, v]) => [k, safe(tildify(v))]));
    console.log(t(w.key, params));
  }
  console.log(t('doctor.hooks.managedNote'));
  if (!last?.session_id) return;
  const at = readHookState(last.session_id, process.env, { persist: false })?.lastEventAt;
  if (typeof at === 'number') console.log(t('doctor.hooks.lastEvent', { age: shortAge(Date.now() - at) }));
  else if (entries.length) console.log(t('doctor.hooks.noEvents'));
}

function readJobs(env: NodeJS.ProcessEnv): JobEnvelope<unknown>[] {
  let names: string[];
  try {
    names = fs.readdirSync(jobsDir(env));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter((k) => SAFE_KEY.test(k))
    .sort()
    .map((k) => readEnvelope(k, env))
    .filter((e): e is JobEnvelope<unknown> => e !== null);
}

function jobLine(e: JobEnvelope<unknown>, env: NodeJS.ProcessEnv, now: number): string {
  const key = safe(e.key);
  const age = shortAge(now - e.fetchedAt);
  let line = e.ok
    ? t('doctor.jobs.ok', { key, age })
    : t('doctor.jobs.error', { key, age, error: safe(e.error ?? '') || t('doctor.jobs.unknownError') });
  if (e.blockedUntil !== undefined && e.blockedUntil > now)
    line += t('doctor.jobs.retry', { in: shortAge(e.blockedUntil - now) });
  const job = jobFor(e.key);
  if (jobsDisabled(env)) line += t('doctor.jobs.offAll');
  else if (job && blockedByTraffic(job.network, env)) line += t('doctor.jobs.offTraffic');
  return line;
}

function printJobs(env: NodeJS.ProcessEnv, now: number): void {
  console.log(t('doctor.jobs.heading'));
  const jobs = readJobs(env);
  if (!jobs.length) console.log(t('doctor.jobs.none'));
  for (const e of jobs) console.log(jobLine(e, env, now));
  if (jobsDisabled(env)) console.log(t('doctor.jobs.disabled'));
  else if (nonessentialTrafficOff(env)) console.log(t('doctor.jobs.nonessential'));
}

export function runDoctor(cfgFile: string, opts: { managedFiles?: string[] } = {}): void {
  const ok = (b: boolean) => (b ? '✓' : '✗');
  const loaded = loadForUse(cfgFile);
  const sl = (() => {
    try {
      return currentStatusLine();
    } catch {
      return null;
    }
  })();
  const settingsFile = claudeSettingsPath();
  const manifest = readManifest();
  const usesUs =
    owns(manifest, settingsFile, sl) || classifyOwner(manifest, settingsFile, sl, null) === 'legacy-ours';
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(`ccinfobar ${VERSION}`);
  console.log(`${ok(nodeMajor >= 20)} Node.js ${process.versions.node} (needs 20+)`);
  console.log(
    `${ok(loaded.exists && !loaded.error)} Config ${tildify(loaded.path)}${loaded.exists ? '' : ' (not created yet, defaults in use)'}`,
  );
  if (loaded.issue) {
    console.log(t('doctor.configIssue', { ...loaded.issue }));
    console.log(t('doctor.columnNote'));
  } else if (loaded.error) console.log(`  ${safe(loaded.error)}`);
  else if (loaded.exists) for (const w of configWarnings(rawConfig(loaded.path))) console.log(w);
  console.log(
    `${ok(usesUs)} Claude Code statusLine in ${tildify(settingsFile)}: ${sl?.command !== undefined ? safe(sl.command) : 'not set'}`,
  );
  if (typeof sl?.command === 'string') for (const w of commandWarnings(sl.command)) console.log(w);
  if (sl?.refreshInterval === undefined) {
    const cfg = loaded.config;
    const extra = cfg.tui ? titleWidgets(cfg.tui) : [];
    const timed = needsRefresh(cfg, (type) => getWidget(type)?.timeBased === true, extra);
    if (timed.length) console.log(t('doctor.refreshHint', { widgets: timed.join(', ') }));
  }
  if (manifest.readOnly) console.log(`⚠ ${t('install.manifestReadOnly', { file: tildify(manifestFile()) })}`);
  else {
    console.log(t('doctor.manifest', { file: tildify(manifestFile()), count: manifest.entries.length }));
    for (const e of manifest.entries) {
      console.log(t('doctor.manifestEntry', { kind: safe(e.kind), file: safe(tildify(String(e.file))) }));
    }
  }
  const dirs = new Set([process.cwd()]);
  const last = readLastPayload();
  const lastDir = last?.workspace?.project_dir ?? last?.workspace?.current_dir ?? last?.cwd;
  if (lastDir && fs.existsSync(lastDir)) dirs.add(lastDir);
  printHooks(
    manifest,
    settingsFile,
    dirs,
    last,
    opts.managedFiles ?? managedSettingsFiles(process.platform, process.env),
  );
  console.log(t('doctor.backups', { dir: tildify(backupsDir()) }));
  for (const dir of dirs) {
    const o = projectOverride(dir);
    if (!o) continue;
    console.log(`✗ ${tildify(o.file)} overrides it with: ${safe(o.command)}`);
    console.log(`  Run \`${selfCommand()} install --project\` in ${tildify(dir)} to use ccinfobar there.`);
  }
  console.log(`${ok(fs.existsSync(lastPayloadPath()))} Last payload ${tildify(lastPayloadPath())}`);
  console.log(`  Cache dir ${tildify(cacheDir())}`);
  const pruned = pruneTmp(cacheDir(), 3_600_000) + pruneTmp(jobsDir(), 3_600_000);
  if (pruned > 0) console.log(t('doctor.tmpPruned', { count: pruned }));
  console.log(`  Detected width ${doctorWidth(last) ?? 'unknown'}`);
  const upd = readUpdateState();
  const newer = availableUpdate(VERSION);
  if (loaded.config.gitHardening === false) console.log(t('doctor.gitHardeningOff'));
  if (nonessentialTrafficOff()) console.log(t('doctor.noTraffic'));
  if (updatesDisabled(loaded.config)) console.log('  Update checks off');
  else if (newer) console.log(`✗ Update available: ${VERSION} → ${newer} (run \`ccinfobar update\`)`);
  else {
    const when = upd ? `last checked ${new Date(upd.checkedAt).toLocaleString()}` : 'not checked yet';
    console.log(`✓ Up to date (${loaded.config.update} mode, ${installKind()} install, ${when})`);
  }
  if (upd?.error) console.log(`  Last update check failed: ${safe(upd.error)}`);
  printJobs(process.env, Date.now());
  printWidgetReport(cfgFile, loaded);
  if (!usesUs) console.log(`\nRun \`${selfCommand()} install\` to enable it in Claude Code.`);
}
