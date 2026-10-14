import fs from 'node:fs';
import { stripAnsi, visibleWidth } from '../core/ansi.js';
import { createContext } from '../core/context.js';
import { t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { cacheDir, claudeSettingsPath, lastPayloadPath, tildify } from '../core/paths.js';
import { hasReplies } from '../core/payload.js';
import { readLastPayload } from '../core/preview.js';
import { maxLineWidth, renderLine, renderPart, renderValue, resolveAppearance } from '../core/renderer.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionSpec, RenderContext, StatusPayload, WidgetItem } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { pruneTmp } from '../data/store.js';
import { terminalWidth } from '../data/terminal.js';
import {
  availableUpdate,
  installKind,
  nonessentialTrafficOff,
  readUpdateState,
  selfCommand,
  updatesDisabled,
} from '../data/update-state.js';
import { mergeUsage, readUsageCache, usageApiDisabled } from '../data/usage.js';
import { getWidget } from '../widgets/index.js';
import { currentStatusLine, projectOverride } from './install.js';
import { classifyOwner, manifestFile, owns, readManifest } from './manifest.js';
import { backupsDir } from './settings-file.js';

export { hasReplies } from '../core/payload.js';

export interface WidgetReport {
  line: number;
  item: WidgetItem;
  value: string | null;
  reason: string | null;
}

const TRANSCRIPT_TYPES = new Set([
  'skills',
  'compactions',
  'message-count',
  'output-speed',
  'gsd-last-command',
  'gsd-task',
]);

export function hiddenReason(ctx: RenderContext, item: WidgetItem): string {
  const def = getWidget(item.type);
  if (!def) return `unknown widget type "${item.type}"`;
  const p = ctx.payload;
  if (def.category === 'gsd') {
    if (!ctx.data.gsd()) return 'not inside a GSD project (no .planning/ found above the working directory)';
    return 'the GSD files have nothing for this widget right now';
  }
  if (def.category === 'limits') {
    if (!p.rate_limits) {
      return 'no rate_limits from Claude Code and none from the usage API yet (needs a Claude Pro/Max login; see `ccinfobar usage`)';
    }
    return 'this usage window is not in rate_limits';
  }
  if (def.category === 'context' && !p.context_window && !ctx.data.transcript()?.contextLength) {
    return 'Claude Code sent no context_window and the transcript has no usage yet (update Claude Code or send a message)';
  }
  if (def.category === 'git' && !ctx.data.git()) return 'not a git repository, or git is not on PATH';
  if (TRANSCRIPT_TYPES.has(item.type) && !ctx.data.transcript()) {
    return 'no transcript yet: Claude Code creates it with the first message of the session';
  }
  if (item.type === 'command' && !item.options?.command) return 'no command set';
  if (item.type === 'env' && !item.options?.name) return 'no variable name set';
  if (!hasReplies(p) && /^(context|tokens|cost)$/.test(def.category)) {
    return 'Claude has not answered in this session yet; it appears after the first reply';
  }
  return 'no data for this widget in the current session';
}

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

export function sessionNotes(p: StatusPayload): string[] {
  const notes: string[] = [];
  const full = (['five_hour', 'seven_day'] as const).filter(
    (k) => (p.rate_limits?.[k]?.used_percentage ?? 0) >= 100,
  );
  if (full.length) {
    const names = full.map((k) => (k === 'five_hour' ? '5-hour' : 'weekly')).join(' and ');
    notes.push(
      `Your ${names} usage limit is at 100%, so Claude cannot reply right now. Context, cache and token widgets fill in after the next successful reply.`,
    );
  }
  if (!hasReplies(p)) {
    notes.push(
      'This session has no replies yet (cost $0, no prompt cache). Send a message and run doctor again; context, cache and speed widgets need at least one answer.',
    );
  }
  return notes;
}

export function widgetReport(ctx: RenderContext): WidgetReport[] {
  const out: WidgetReport[] = [];
  ctx.config.lines.forEach((items, line) => {
    for (const item of items) {
      if (item.type === 'flex') continue;
      const def = getWidget(item.type);
      const value = def ? renderValue(ctx, def, item) : null;
      const part = value ? renderPart(ctx, item) : null;
      out.push({
        line,
        item,
        value: part ? stripAnsi(part.text) : null,
        reason: part ? null : hiddenReason(ctx, item),
      });
    }
  });
  return out;
}

export function lineReport(
  ctx: RenderContext,
): { line: number; width: number; max: number | null; cut: boolean }[] {
  const a = resolveAppearance(ctx.config);
  if (a.style === 'tui') return [];
  const max = maxLineWidth(ctx);
  return ctx.config.lines.map((items, line) => {
    const full = renderLine(
      { ...ctx, terminalWidth: null, config: { ...ctx.config, maxWidth: 'auto' } },
      items,
      0,
      a,
    );
    const width = visibleWidth(full);
    return { line, width, max, cut: max !== null && width > max && !ctx.config.autoWrap };
  });
}

export function usageLine(
  config: Config,
  payload: StatusPayload,
  usage: ReturnType<typeof readUsageCache>,
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

export function printWidgetReport(config: Config, payload: StatusPayload | null = readLastPayload()): void {
  console.log('\nWidgets');
  if (!payload) {
    console.log('  No payload yet. Use Claude Code once with ccinfobar installed, then run doctor again.');
    return;
  }
  const keys = Object.keys(payload).filter((k) => (payload as Record<string, unknown>)[k] !== undefined);
  console.log(
    `  Last payload: Claude Code ${safe(payload.version ?? 'unknown version')}, fields: ${safe(keys.sort().join(', '))}`,
  );
  for (const n of sessionNotes(payload)) console.log(`  ℹ ${n}`);
  const usage = usageApiDisabled(config) ? null : readUsageCache();
  console.log(`  ${usageLine(config, payload, usage)}`);
  const shown = usage ? mergeUsage(payload, usage) : payload;
  const width = terminalWidth(payload.session_id, payload.terminal_width ?? payload.columns);
  const ctx = createContext({ payload: shown, config: { ...config, colorLevel: 0 }, terminalWidth: width });
  for (const r of widgetReport(ctx)) {
    const name = safe(`${r.item.type}${r.item.id !== r.item.type ? ` (${r.item.id})` : ''}`);
    if (r.value !== null) console.log(`  ✓ L${r.line + 1} ${name}: ${r.value}`);
    else if (r.item.hideEmpty) console.log(`  ✗ L${r.line + 1} ${name}: hidden (hideEmpty), ${r.reason}`);
    else console.log(`  – L${r.line + 1} ${name}: shows —, ${r.reason}`);
  }
  const lines = lineReport(ctx);
  const cut = lines.filter((l) => l.cut);
  console.log(
    `\n  Width: ${width ?? 'unknown'} columns detected, ${lines[0]?.max ?? 'no'} usable after widthOffset`,
  );
  for (const l of cut) {
    console.log(
      `  ⚠ Line ${l.line + 1} needs ${l.width} columns and is cut with "…". Lower widthOffset, set autoWrap, or move widgets to another line.`,
    );
  }
}

export function runDoctor(cfgFile: string): void {
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
  if (manifest.readOnly) console.log(`⚠ ${t('install.manifestReadOnly', { file: tildify(manifestFile()) })}`);
  else {
    console.log(t('doctor.manifest', { file: tildify(manifestFile()), count: manifest.entries.length }));
    for (const e of manifest.entries) {
      console.log(t('doctor.manifestEntry', { kind: safe(e.kind), file: safe(tildify(String(e.file))) }));
    }
  }
  console.log(t('doctor.backups', { dir: tildify(backupsDir()) }));
  const dirs = new Set([process.cwd()]);
  const last = readLastPayload();
  const lastDir = last?.workspace?.project_dir ?? last?.workspace?.current_dir ?? last?.cwd;
  if (lastDir && fs.existsSync(lastDir)) dirs.add(lastDir);
  for (const dir of dirs) {
    const o = projectOverride(dir);
    if (!o) continue;
    console.log(`✗ ${tildify(o.file)} overrides it with: ${safe(o.command)}`);
    console.log(`  Run \`${selfCommand()} install --project\` in ${tildify(dir)} to use ccinfobar there.`);
  }
  console.log(`${ok(fs.existsSync(lastPayloadPath()))} Last payload ${tildify(lastPayloadPath())}`);
  console.log(`  Cache dir ${tildify(cacheDir())}`);
  const pruned = pruneTmp(cacheDir(), 3_600_000);
  if (pruned > 0) console.log(t('doctor.tmpPruned', { count: pruned }));
  console.log(`  Detected width ${terminalWidth(undefined) ?? 'unknown'}`);
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
  printWidgetReport(loaded.config);
  if (!usesUs) console.log(`\nRun \`${selfCommand()} install\` to enable it in Claude Code.`);
}
