import type { Args } from '../cli/args.js';
import { loadForUse } from '../core/load.js';
import { claudeSettingsPath } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { executeJob, type JobEnvelope, jobOff } from '../data/jobs/runner.js';
import { type UpdateValue, updateJob } from '../data/jobs/update.js';
import { fetchLatest, installVersion } from '../data/self-update.js';
import { compareVersions, installKind, localPrefix, writeUpdateState } from '../data/update-state.js';
import { currentStatusLine, takeOverProjects } from './install.js';
import { classifyOwner, owns, readManifest } from './manifest.js';

export {
  assertVersion,
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
  compareVersions,
  type InstallKind,
  installKind,
  localPrefix,
  readUpdateState,
  scheduleCheck,
  selfCommand,
  spawnSelf,
  type UpdateState,
  updateFile,
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

export async function manualUpdate(current: string, checkOnly: boolean): Promise<number> {
  let latest: string;
  try {
    latest = await fetchLatest(8000);
  } catch (err) {
    console.error(`✗ Could not reach GitHub: ${(err as Error).message}`);
    return 1;
  }
  writeUpdateState({ checkedAt: Date.now(), latest });
  if (compareVersions(latest, current) <= 0) {
    console.log(`✓ ccinfobar ${current} is the latest version`);
    return 0;
  }
  console.log(`New version available: ${current} → ${latest}`);
  if (checkOnly) return 0;
  const kind = installKind();
  if (kind === 'source') {
    console.log('  This is a source checkout; update it with git pull && npm run build.');
    return 0;
  }
  if (kind === 'npx') {
    console.log('  Running through npx: run `npx ccinfobar@latest install` to set up the newest release.');
    return 0;
  }
  try {
    console.log(`  Installing ccinfobar@${latest} ...`);
    installVersion(latest, kind === 'local' ? localPrefix() : undefined);
    writeUpdateState({ checkedAt: Date.now(), latest, installed: latest });
    console.log(`✓ Updated to ${latest}`);
    return 0;
  } catch (err) {
    console.error(`✗ npm install failed: ${(err as Error).message}`);
    console.error(`  Run it yourself: npm install -g ccinfobar@${latest}`);
    return 1;
  }
}

export async function runUpdate(args: Args, cfgFile: string): Promise<void> {
  if (args.flags.background) {
    const env = process.env;
    if (jobOff(updateJob.network, env)) return;
    const prev: JobEnvelope<UpdateValue> | null = updateJob.readPrev!('update', env);
    const req = prev?.param ? { key: 'update', param: prev.param } : { key: 'update' };
    const ctx = {
      env,
      config: loadForUse(cfgFile).config,
      cwd: process.cwd(),
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
