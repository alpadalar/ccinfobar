import fs from 'node:fs';
import { applyLanguage } from '../cli/lang.js';
import { describeRuleError, validateRule } from '../core/conditions.js';
import type { LoadResult } from '../core/config.js';
import { refreshReasons, timeRuleFeed } from '../core/edit.js';
import { describeHeaders, redactUrl } from '../core/http-report.js';
import { httpRefusal, isLoopback, parseHeaderSpec, parseUrlTemplate } from '../core/http-spec.js';
import { formatDateTime } from '../core/i18n/format.js';
import { languageLocale, type MessageId, type Resolved, t } from '../core/i18n/index.js';
import { LANGUAGE_SETTINGS, nativeName } from '../core/i18n/languages.js';
import { type InspectRow, inspectRows, lineReport, sessionNotes } from '../core/inspect.js';
import { parsePath } from '../core/jsonpath.js';
import { loadForUse } from '../core/load.js';
import { titleWidgets } from '../core/panel.js';
import { cacheDir, claudeSettingsPath, lastPayloadPath, tildify } from '../core/paths.js';
import { readLastPayload } from '../core/preview.js';
import { overflowOf, resolveAppearance } from '../core/renderer.js';
import { rotationIds } from '../core/rotation.js';
import { sanitizeText } from '../core/sanitize.js';
import { themeExists } from '../core/themes.js';
import type { Config, OptionSpec, StatusPayload } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { readHookState } from '../data/hooks.js';
import { GH_HOSTS_KEY, httpGroups, keyNetwork } from '../data/jobs/keys.js';
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
  BREW_UPGRADE,
  type InstallKind,
  installKind,
  localPrefix,
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
  progressWarnings,
  readSettingsLayer,
  type SettingsLayer,
} from './hooks-doctor.js';
import { parseClaudeVersion } from './hooks-install.js';
import { currentStatusLine, projectOverride, projectSettingsPath } from './install.js';
import { rotationStatus } from './manage.js';
import {
  classifyOwner,
  findHookEntries,
  findSubagentLineEntry,
  type Manifest,
  manifestFile,
  ownedEqual,
  owns,
  readManifest,
} from './manifest.js';
import { backupsDir } from './settings-file.js';
import { usageErrorText } from './usage-error.js';

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

function subagentSetting(file: string): { command: string } | null {
  const v = readSettingsLayer('user', file).data?.subagentStatusLine;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const command = (v as { command?: unknown }).command;
  return typeof command === 'string' ? { command } : null;
}

const FROM: Partial<Record<Resolved['source'], MessageId>> = {
  config: 'doctor.languageFrom.config',
  Intl: 'doctor.languageFrom.Intl',
  default: 'doctor.languageFrom.default',
};

export function languageLine(r: Resolved): string {
  const id = FROM[r.source];
  return t('doctor.language', { name: nativeName(r.id), id: r.id, source: id ? t(id) : r.source });
}

export function droppedLanguage(raw: unknown, config: Config): string | null {
  if (!isRecord(raw) || raw.language === undefined || config.language !== undefined) return null;
  return t('doctor.languageDropped', { value: safe(raw.language), values: LANGUAGE_SETTINGS.join(', ') });
}

export function configWarnings(raw: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.lines)) return out;
  raw.lines.forEach((items: unknown, index) => {
    if (!Array.isArray(items)) return;
    items.forEach((item: unknown, i) => {
      if (!isRecord(item) || typeof item.type !== 'string' || !item.type) return;
      const type = item.type;
      const def = getWidget(type);
      if (!def) {
        out.push(t('doctor.unknownWidget', { type: safe(type), line: index + 1 }));
        return;
      }
      const id = typeof item.id === 'string' && item.id ? item.id : `${type}-${i}`;
      for (const key of ['showWhen', 'hideWhen'] as const) {
        const e = item[key] === undefined ? null : validateRule(item[key]);
        if (e) out.push(t('doctor.badRule', { id: safe(id), key, problem: safe(describeRuleError(e)) }));
      }
      if (!isRecord(item.options)) return;
      for (const [key, v] of Object.entries(item.options)) {
        const spec = def.options?.find((o) => o.key === key);
        if (spec && !validOption(spec, v))
          out.push(t('doctor.badOption', { type: safe(type), key: safe(key) }));
      }
    });
  });
  return out;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function plainHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && !isLoopback(u.hostname) ? u.hostname : null;
  } catch {
    return null;
  }
}

function httpItemLines(
  opts: Record<string, unknown>,
  line: number,
  env: Record<string, string | undefined>,
  ghHosts?: readonly string[],
): string[] {
  const url = text(opts.url);
  const headers = text(opts.headers);
  const checked = url ? parseUrlTemplate(url) : null;
  const vars = [
    ...describeHeaders(headers, env),
    ...(checked?.ok
      ? checked.vars.map((v) => t(env[v] ? 'doctor.http.envSet' : 'doctor.http.envUnset', { name: `$${v}` }))
      : []),
  ];
  const out = [
    t('doctor.http.item', {
      line,
      url: safe(checked?.ok ? redactUrl(url) : '-'),
      env: safe(vars.join(', ')) || t('doctor.http.noEnv'),
    }),
  ];
  const refused = url ? httpRefusal(url, headers, ghHosts) : null;
  if (!url) out.push(t('doctor.http.noUrl', { line }));
  else if (refused?.key === 'headers' && refused.code !== 'insecure-url')
    out.push(t('doctor.http.refusedHeader', { line, error: safe(refused.message) }));
  else if (refused) out.push(t('doctor.http.badUrl', { line, error: safe(refused.message) }));
  else {
    const host = plainHost(url);
    if (host) out.push(t('doctor.http.plain', { line, host: safe(host) }));
  }
  for (const error of parseHeaderSpec(headers).errors)
    out.push(t('doctor.http.badHeader', { line, error: safe(error) }));
  const path = parsePath(text(opts.path) || '$');
  if (!path.ok) out.push(t('doctor.http.badPath', { line, error: safe(path.error) }));
  return out;
}

// raw config: normalize already dropped bad urls and literal headers
export function httpReport(raw: unknown, env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.lines)) return out;
  const hosts = readEnvelope<{ hosts?: unknown }>(GH_HOSTS_KEY, env as NodeJS.ProcessEnv)?.value?.hosts;
  const ghHosts = Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string') : undefined;
  raw.lines.forEach((items: unknown, index) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isRecord(item) || item.type !== 'http') continue;
      out.push(...httpItemLines(isRecord(item.options) ? item.options : {}, index + 1, env, ghHosts));
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
  if (payload.rate_limits?.five_hour && payload.rate_limits.seven_day) return t('doctor.usage.claudeCode');
  if (usageApiDisabled(config)) return t('doctor.usage.off');
  if (!usage) return t('doctor.usage.notCalled');
  const age = Math.round((now - usage.fetchedAt) / 60_000);
  const error = usage.error ? usageErrorText(usage.error) : '';
  if (usage.rate_limits) return t(error ? 'doctor.usage.freshError' : 'doctor.usage.fresh', { age, error });
  return t(error ? 'doctor.usage.noDataError' : 'doctor.usage.noData', { error });
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
      if (r.empty?.code === 'hidden-by-rule') return `  ✗ ${at}: ${t('doctor.hiddenByRule')}, ${why}`;
      if (getWidget(r.type)?.hideWhenEmpty) return `  ✗ ${at}: ${t('doctor.row.hidden')}, ${why}`;
      return `  ✗ ${at}: ${t('doctor.row.hiddenEmpty')}, ${why}`;
    case 'error':
      return `  ✗ ${at}: ${t('doctor.row.error')}, ${safe(r.error ?? '')}`;
    case 'skipped':
      return null;
    default:
      return `  – ${at}: ${t('doctor.row.empty')}, ${why}`;
  }
}

const doctorWidth = (p: StatusPayload | null): number | null =>
  cachedTerminalWidth(p?.session_id, p?.terminal_width ?? p?.columns);

export function printWidgetReport(cfgFile: string, loaded?: LoadResult): void {
  console.log(t('doctor.widgets.heading'));
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
      t('doctor.lastPayloadFields', {
        version: safe(payload.version ?? t('doctor.unknownVersion')),
        fields: safe(keys.sort().join(', ')),
      }),
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
    const usable = lines[0]?.max ?? t('doctor.widthNone');
    console.log(
      data.width == null
        ? t('doctor.widthLineUnknown', { usable })
        : t('doctor.widthLine', { width: data.width, usable }),
    );
    for (const l of lines.filter((x) => x.cut))
      console.log(
        l.overflow
          ? t('doctor.lineCutMode', { line: l.line + 1, need: l.width, mode: l.overflow })
          : t('doctor.lineCut', { line: l.line + 1, need: l.width }),
      );
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
  progress: Config['progress'],
): void {
  const entries = manifest.readOnly ? [] : findHookEntries(manifest, settingsFile);
  if (!manifest.readOnly && entries.length === 0) console.log(t('doctor.hooks.off'));
  if (entries.length) {
    const versions = [...new Set(entries.map((e) => safe(e.claudeCode ?? 'unknown')))].join(', ');
    console.log(t('doctor.hooks.summary', { count: entries.length, versions }));
    const user = readSettingsLayer('user', settingsFile).data ?? {};
    const missing = new Map<string, number>();
    for (const e of entries) {
      const row = { event: safe(e.event), claudeCode: safe(e.claudeCode ?? 'unknown') };
      console.log(t(e.role === 'progress' ? 'doctor.hooks.progressEntry' : 'doctor.hooks.entry', row));
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
  const progressOut = progressWarnings({
    layers,
    progress,
    entries: entries.filter((e) => e.role === 'progress'),
    env: process.env,
    platform: process.platform,
    claudeCode: parseClaudeVersion(last?.version),
  }).filter((w) => !manifest.readOnly || !/Handlers$/.test(w.key));
  for (const w of [...hookGateWarnings(layers), ...progressOut]) {
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

function jobLine(
  e: JobEnvelope<unknown>,
  env: NodeJS.ProcessEnv,
  now: number,
  urls: Map<string, string>,
): string {
  const key = safe(e.key);
  const age = shortAge(now - e.fetchedAt);
  const error = e.error && e.key.startsWith('usage-') ? usageErrorText(e.error) : safe(e.error ?? '');
  let line = e.ok
    ? t('doctor.jobs.ok', { key, age })
    : t('doctor.jobs.error', { key, age, error: error || t('doctor.jobs.unknownError') });
  if (e.blockedUntil !== undefined && e.blockedUntil > now)
    line += t('doctor.jobs.retry', { in: shortAge(e.blockedUntil - now) });
  if (e.key.startsWith('http-')) {
    const url = urls.get(e.key);
    line += url ? t('doctor.jobs.httpUrl', { url: safe(redactUrl(url)) }) : t('doctor.jobs.httpUnused');
  }
  const network = keyNetwork(e.key);
  if (jobsDisabled(env)) line += t('doctor.jobs.offAll');
  else if (network && blockedByTraffic(network, env)) line += t('doctor.jobs.offTraffic');
  return line;
}

function printJobs(config: Config, env: NodeJS.ProcessEnv, now: number): void {
  console.log(t('doctor.jobs.heading'));
  const jobs = readJobs(env);
  const urls = new Map([...httpGroups(config)].map(([k, g]) => [k, g.url]));
  if (!jobs.length) console.log(t('doctor.jobs.none'));
  for (const e of jobs) console.log(jobLine(e, env, now, urls));
  if (jobsDisabled(env)) console.log(t('doctor.jobs.disabled'));
  else if (nonessentialTrafficOff(env)) console.log(t('doctor.jobs.nonessential'));
  if (env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB) console.log(t('doctor.jobs.scrub'));
}

const MODES: Record<Config['update'], MessageId> = {
  auto: 'doctor.updateMode.auto',
  notify: 'doctor.updateMode.notify',
  off: 'doctor.updateMode.off',
};

const KINDS: Record<InstallKind, MessageId> = {
  'npm-global': 'doctor.installKind.npm-global',
  local: 'doctor.installKind.local',
  npx: 'doctor.installKind.npx',
  brew: 'doctor.installKind.brew',
  source: 'doctor.installKind.source',
  unknown: 'doctor.installKind.unknown',
};

export function runDoctor(
  cfgFile: string,
  opts: { managedFiles?: string[]; installKind?: () => InstallKind } = {},
): void {
  const ok = (b: boolean) => (b ? '✓' : '✗');
  const kind = (opts.installKind ?? installKind)();
  const loaded = loadForUse(cfgFile);
  const lang = applyLanguage(loaded.issue ? undefined : loaded.config);
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
  console.log(t('doctor.node', { mark: ok(nodeMajor >= 20), version: process.versions.node }));
  console.log(
    t(loaded.exists ? 'doctor.config' : 'doctor.configMissing', {
      mark: ok(loaded.exists && !loaded.error),
      file: tildify(loaded.path),
    }),
  );
  if (loaded.issue) {
    console.log(t('doctor.configIssue', { ...loaded.issue }));
    console.log(t('doctor.columnNote'));
  } else if (loaded.error) console.log(`  ${safe(loaded.error)}`);
  else if (loaded.exists) {
    const raw = rawConfig(loaded.path);
    for (const w of configWarnings(raw)) console.log(w);
    const dropped = droppedLanguage(raw, loaded.config);
    if (dropped) console.log(dropped);
    for (const l of httpReport(raw)) console.log(l);
  }
  const slFile = { mark: ok(usesUs), file: tildify(settingsFile) };
  console.log(
    sl?.command !== undefined
      ? t('doctor.statusLine', { ...slFile, command: safe(sl.command) })
      : t('doctor.statusLineUnset', slFile),
  );
  if (typeof sl?.command === 'string') for (const w of commandWarnings(sl.command)) console.log(w);
  const sub = subagentSetting(settingsFile);
  if (sub) {
    const entry = findSubagentLineEntry(manifest, settingsFile);
    const owned = !!entry && ownedEqual(sub, entry.value);
    console.log(t('doctor.subagentLine', { mark: ok(owned), command: safe(sub.command) }));
    if (!owned) console.log(t('doctor.subagentLineForeign', { command: selfCommand() }));
  }
  if (sl?.refreshInterval === undefined) {
    const cfg = loaded.config;
    const extra = cfg.tui ? titleWidgets(cfg.tui) : [];
    const why = refreshReasons(cfg, (type) => getWidget(type)?.timeBased === true, [timeRuleFeed], extra);
    if (why.widgets.length) console.log(t('doctor.refreshHint', { widgets: why.widgets.join(', ') }));
    if (why.rules.length) console.log(t('doctor.refreshHintRules', { items: safe(why.rules.join(', ')) }));
  }
  const cfg = loaded.config;
  if (overflowOf(cfg) === 'priority' && resolveAppearance(cfg).style === 'tui')
    console.log(t('doctor.priorityTui'));
  if (/JetBrains/.test(process.env.TERMINAL_EMULATOR ?? '') && (cfg.glyphMode ?? 'normal') === 'normal')
    console.log(t('doctor.jetbrains'));
  const rotation = rotationStatus(cfg);
  if (rotation && cfg.themeRotation) {
    console.log(t('doctor.rotation', { status: rotation }));
    const missing = rotationIds(cfg.themeRotation).filter((id) => !themeExists(id));
    if (missing.length) console.log(t('doctor.rotationMissing', { ids: safe(missing.join(', ')) }));
  }
  console.log(languageLine(lang));
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
    loaded.config.progress,
  );
  console.log(t('doctor.backups', { dir: tildify(backupsDir()) }));
  for (const dir of dirs) {
    const o = projectOverride(dir);
    if (!o) continue;
    console.log(t('doctor.projectOverride', { file: tildify(o.file), command: safe(o.command) }));
    console.log(t('doctor.projectOverrideFix', { command: selfCommand(kind), dir: tildify(dir) }));
  }
  console.log(
    t('doctor.lastPayload', { mark: ok(fs.existsSync(lastPayloadPath())), file: tildify(lastPayloadPath()) }),
  );
  console.log(t('doctor.cacheDir', { dir: tildify(cacheDir()) }));
  const pruned = pruneTmp(cacheDir(), 3_600_000) + pruneTmp(jobsDir(), 3_600_000);
  if (pruned > 0) console.log(t('doctor.tmpPruned', { count: pruned }));
  const width = doctorWidth(last);
  console.log(width == null ? t('doctor.detectedWidthUnknown') : t('doctor.detectedWidth', { width }));
  const upd = readUpdateState();
  const newer = availableUpdate(VERSION);
  if (loaded.config.gitHardening === false) console.log(t('doctor.gitHardeningOff'));
  if (updatesDisabled(loaded.config)) console.log(t('doctor.update.off'));
  else if (newer)
    console.log(
      t(kind === 'brew' ? 'doctor.update.availableBrew' : 'doctor.update.available', {
        current: VERSION,
        latest: newer,
        command: BREW_UPGRADE,
      }),
    );
  else {
    const brew = kind === 'brew';
    const mode = brew
      ? t(loaded.config.update === 'auto' ? 'doctor.brewMode.auto' : 'doctor.brewMode.notify')
      : t(MODES[loaded.config.update]);
    const params = { mode, kind: t(KINDS[kind]), command: BREW_UPGRADE };
    console.log(
      upd
        ? t(brew ? 'doctor.update.brew' : 'doctor.update.upToDate', {
            ...params,
            when: formatDateTime(new Date(upd.checkedAt), languageLocale()),
          })
        : t(brew ? 'doctor.update.neverCheckedBrew' : 'doctor.update.neverChecked', params),
    );
  }
  if (upd?.error) console.log(t('doctor.update.failed', { error: safe(upd.error) }));
  if (upd?.rejected)
    console.log(
      t(upd.rollback === 'failed' ? 'doctor.update.rollbackFailed' : 'doctor.update.rolledBack', {
        version: upd.rejected,
        current: VERSION,
        reason: safe(upd.reason ?? ''),
        command:
          kind === 'local'
            ? `npm install --prefix ${localPrefix()} ccinfobar@${VERSION}`
            : `npm install -g ccinfobar@${VERSION}`,
      }),
    );
  printJobs(loaded.config, process.env, Date.now());
  printWidgetReport(cfgFile, loaded);
  if (!usesUs) console.log(t('doctor.enableHint', { command: selfCommand(kind) }));
}
