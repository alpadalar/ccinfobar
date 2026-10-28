import type { Args } from '../cli/args.js';
import { applyLanguage } from '../cli/lang.js';
import { t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { claudeSettingsPath } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { executeJob, type JobEnvelope, jobOff } from '../data/jobs/runner.js';
import { type UpdateValue, updateJob } from '../data/jobs/update.js';
import {
  type CheckDeps,
  fetchLatest,
  installChecked,
  installVersionAsync,
  type Verify,
  verifyInstall,
} from '../data/self-update.js';
import {
  BREW_UPGRADE,
  compareVersions,
  type InstallKind,
  installKind,
  localPrefix,
  safeCwd,
  writeUpdateState,
} from '../data/update-state.js';
import { currentStatusLine, takeOverProjects } from './install.js';
import { classifyOwner, owns, readManifest } from './manifest.js';

export {
  assertVersion,
  type CheckDeps,
  checkForUpdate,
  fetchLatest,
  installSources,
  installVersion,
  installVersionAsync,
  type NpmCommand,
  type NpmDeps,
  npmCommand,
  npmInstallRuns,
  REPO,
  shellArg,
  tarballUrl,
} from '../data/self-update.js';
export {
  availableUpdate,
  BREW_UPGRADE,
  brewPrefix,
  compareVersions,
  effectiveUpdate,
  type InstallKind,
  installKind,
  localPrefix,
  readUpdateState,
  scheduleCheck,
  selfCommand,
  spawnSelf,
  type UpdateState,
  updateFile,
  updateHint,
  updateNotice,
  updatesDisabled,
  writeUpdateState,
} from '../data/update-state.js';

// keep project statusLines on the updated command
export function takeOverAfterUpdate(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = claudeSettingsPath(env);
    const sl = currentStatusLine(file);
    const m = readManifest(env);
    const ours = owns(m, file, sl) || classifyOwner(m, file, sl, null) === 'legacy-ours';
    if (sl && ours && typeof sl.command === 'string') takeOverProjects(sl.command, sl.refreshInterval, env);
  } catch {}
}

export interface UpdateDeps {
  fetchLatest: (timeoutMs: number) => Promise<string>;
  install: NonNullable<CheckDeps['install']>;
  verify: Verify;
  installKind: () => InstallKind;
  writeState: typeof writeUpdateState;
  log: (line: string) => void;
  error: (line: string) => void;
}

const DEPS: UpdateDeps = {
  fetchLatest,
  install: (v, p, sig) => installVersionAsync(v, p, sig),
  verify: verifyInstall,
  installKind,
  writeState: writeUpdateState,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function manualUpdate(
  current: string,
  checkOnly: boolean,
  deps: Partial<UpdateDeps> = {},
): Promise<number> {
  const d = { ...DEPS, ...deps };
  let latest: string;
  try {
    latest = await d.fetchLatest(8000);
  } catch (err) {
    d.error(t('cmd.update.unreachable', { message: (err as Error).message }));
    return 1;
  }
  d.writeState({ checkedAt: Date.now(), latest });
  if (compareVersions(latest, current) <= 0) {
    d.log(t('cmd.update.latest', { version: current }));
    return 0;
  }
  d.log(t('cmd.update.available', { version: current, latest }));
  if (checkOnly) return 0;
  const kind = d.installKind();
  if (kind === 'brew') {
    d.log(t('update.brewManual', { command: BREW_UPGRADE }));
    return 0;
  }
  if (kind === 'source') {
    d.log(t('cmd.update.source'));
    return 0;
  }
  if (kind === 'npx') {
    d.log(t('cmd.update.npx'));
    return 0;
  }
  const prefix = kind === 'local' ? localPrefix() : undefined;
  d.log(t('cmd.update.installing', { version: latest }));
  let out: Awaited<ReturnType<typeof installChecked>>;
  try {
    out = await installChecked(latest, current, prefix, process.env, {
      install: d.install,
      verify: d.verify,
      recordRejected: (r) => d.writeState({ checkedAt: Date.now(), ...r }),
    });
  } catch (err) {
    d.error(t('cmd.update.npmFailed', { message: (err as Error).message }));
    d.error(t('cmd.update.manual', { version: latest }));
    return 1;
  }
  if (!('rejected' in out)) {
    d.writeState({ checkedAt: Date.now(), latest, installed: latest });
    if (out.inconclusive) d.log(t('cmd.update.unverified', { version: latest, reason: out.inconclusive }));
    else d.log(t('cmd.update.updated', { version: latest }));
    return 0;
  }
  d.writeState({
    checkedAt: Date.now(),
    latest,
    rejected: latest,
    rollback: out.rollback,
    reason: out.reason,
  });
  const p = { latest, current, reason: out.reason };
  if (out.rollback === 'ok') d.error(t('cmd.update.rolledBack', p));
  else if (out.rollback === 'unverified') d.error(t('cmd.update.rollbackUnverified', p));
  else {
    d.error(t('cmd.update.rollbackFailed', p));
    d.error(t('cmd.update.manual', { version: current }));
  }
  return 1;
}

export async function runUpdate(args: Args, cfgFile: string): Promise<void> {
  const loaded = loadForUse(cfgFile);
  if (!loaded.issue) applyLanguage(loaded.config);
  if (args.flags.background) {
    const env = process.env;
    if (jobOff(updateJob.network, env)) return;
    const prev: JobEnvelope<UpdateValue> | null = updateJob.readPrev!('update', env);
    const req = prev?.param ? { key: 'update', param: prev.param } : { key: 'update' };
    const ctx = {
      env,
      config: loaded.config,
      cwd: safeCwd() ?? process.cwd(),
      prev,
      fetch: globalThis.fetch,
      now: Date.now(),
    };
    await executeJob(updateJob, req, ctx);
    takeOverAfterUpdate(env);
    return;
  }
  process.exitCode = await manualUpdate(VERSION, args.flags.check === true);
}
