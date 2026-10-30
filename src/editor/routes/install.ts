import fs from 'node:fs';
import {
  applyHooks,
  DEFAULT_EVENTS,
  OPTIONAL_EVENTS,
  planHooks,
  uninstallHooks,
} from '../../commands/hooks-install.js';
import { applyInstall, InstallNeedsConfirmError, planInstall } from '../../commands/install.js';
import { deepEqual, readManifest } from '../../commands/manifest.js';
import { backupsDir, readSettings } from '../../commands/settings-file.js';
import {
  compareVersions,
  installVersionAsync,
  localPrefix,
  readUpdateState,
  writeUpdateState,
} from '../../commands/update.js';
import { BREW_UPGRADE } from '../../core/brew.js';
import { loadConfig, normalizeConfig, saveConfig } from '../../core/config.js';
import { PROGRESS_CHOICES, setProgress } from '../../core/edit.js';
import { loadForUse } from '../../core/load.js';
import { claudeSettingsPath, tildify } from '../../core/paths.js';
import type { ProgressConfig } from '../../core/types.js';
import { progressChannel } from '../../data/progress.js';
import { requestClear } from '../../data/progress-clear.js';
import { type InstallOutcome, installChecked, verifyInstall } from '../../data/self-update.js';
import { keptRejection } from '../../data/update-state.js';
import type { ExactRoute } from '../router.js';
import type { EditorCtx } from './ctx.js';
import {
  activeCommand,
  asObject,
  claudeInfo,
  httpError,
  installedHooks,
  NOT_ACTIVE,
  placeholder,
  progressRefusalText,
  readBody,
  refusalText,
  send,
  textError,
  VERSION,
} from './util.js';

export const exact: ExactRoute<EditorCtx>[] = [
  {
    method: 'POST',
    path: '/api/install/plan',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const { cmd, refresh, subagents } = ctx.requested(body);
      send(res, 200, { plan: planInstall({ command: cmd ?? placeholder(), refresh, subagents }) });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/install',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const { cmd, refresh, subagents } = ctx.requested(body);
      const confirmed = body.confirm === true;
      if (confirmed && !('current' in body)) throw httpError(400, 'install.confirmNeedsCurrent');
      const draft = planInstall({ command: cmd ?? placeholder(), refresh, subagents });
      if (confirmed && !deepEqual(body.current ?? null, draft.current))
        throw httpError(409, 'install.stale', { file: tildify(draft.file) }, { plan: draft });
      if (draft.needsConfirm && !confirmed)
        throw httpError(409, 'install.needsConfirm', undefined, { plan: draft });
      const plan = cmd ? draft : planInstall({ command: await ctx.resolveCommand(cmd), refresh, subagents });
      if (plan !== draft && confirmed && !deepEqual(body.current ?? null, plan.current))
        throw httpError(409, 'install.stale', { file: tildify(plan.file) }, { plan });
      let backup: string | null;
      try {
        backup = applyInstall(plan, { confirmed, adoptLegacy: confirmed }).backup;
      } catch (err) {
        if (err instanceof InstallNeedsConfirmError)
          throw httpError(409, 'install.needsConfirm', undefined, { plan: err.plan });
        throw err;
      }
      if (!fs.existsSync(ctx.opts.configPath))
        saveConfig(
          loadForUse(ctx.opts.configPath, () => ctx.gsd, { persist: true }).config,
          ctx.opts.configPath,
        );
      send(res, 200, { ok: true, backup, backupsDir: backupsDir(), claude: claudeInfo(ctx.state.command) });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/hooks',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const { enabled, permission } = body;
      if (typeof enabled !== 'boolean' || (permission !== undefined && typeof permission !== 'boolean'))
        throw httpError(400, 'hooks.badBody');
      const file = claudeSettingsPath();
      let backup: string | null = null;
      if (enabled) {
        const active = activeCommand(ctx.state.command);
        if (!active) throw textError(409, NOT_ACTIVE, { hooks: await ctx.hooksInfo(ctx.state.command) });
        const claudeCode = await ctx.claudeVersion();
        const plan = planHooks({
          settings: readSettings(file).data as Record<string, unknown>,
          manifest: readManifest(),
          file,
          command: active,
          claudeCode,
          events: permission ? [...DEFAULT_EVENTS, ...OPTIONAL_EVENTS] : DEFAULT_EVENTS,
        });
        if (plan.refused)
          throw textError(409, refusalText(plan.refused, claudeCode), {
            hooks: await ctx.hooksInfo(ctx.state.command),
          });
        backup = applyHooks(file, plan, process.env, permission === false ? OPTIONAL_EVENTS : []).backup;
      } else {
        backup = uninstallHooks(file).backup;
      }
      send(res, 200, { ok: true, hooks: await ctx.hooksInfo(ctx.state.command), backup });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/progress',
    handler: async (ctx, req, res) => {
      const { enabled, channel } = asObject(await readBody(req));
      if (typeof enabled !== 'boolean') throw httpError(400, 'hooks.badBody');
      if (channel !== undefined && !(PROGRESS_CHOICES.channel as readonly unknown[]).includes(channel))
        throw httpError(400, 'hooks.badBody');
      // config and handlers change together (WR-03)
      const loaded = loadConfig(ctx.opts.configPath);
      if (loaded.error) throw httpError(409, 'config.refuseBroken', { file: tildify(ctx.opts.configPath) });
      const file = claudeSettingsPath();
      let backup: string | null = null;
      let held = false;
      const next = setProgress(loaded.config, {
        enabled,
        ...(channel === undefined ? {} : { channel: channel as ProgressConfig['channel'] }),
      });
      // the tty channel needs no handlers (WR-02)
      if (enabled && progressChannel(next.progress, process.platform) === 'tty') {
        saveConfig(next, ctx.opts.configPath);
        if (installedHooks(true).length)
          backup = uninstallHooks(file, process.env, undefined, 'progress').backup;
      } else if (enabled) {
        const active = activeCommand(ctx.state.command);
        if (!active) throw textError(409, NOT_ACTIVE, { hooks: await ctx.hooksInfo(ctx.state.command) });
        const claudeCode = await ctx.claudeVersion();
        const plan = planHooks({
          settings: readSettings(file).data as Record<string, unknown>,
          manifest: readManifest(),
          file,
          command: active,
          claudeCode,
          events: [],
          progress: true,
        });
        if (plan.progressRefused)
          throw textError(409, progressRefusalText(plan.progressRefused, claudeCode), {
            hooks: await ctx.hooksInfo(ctx.state.command),
          });
        backup = applyHooks(file, plan).backup;
        saveConfig(next, ctx.opts.configPath);
      } else {
        saveConfig(next, ctx.opts.configPath);
        // a showing bar needs one more hook event (D-36)
        held = requestClear(process.env) > 0 && installedHooks(true).length > 0;
        if (!held) backup = uninstallHooks(file, process.env, undefined, 'progress').backup;
      }
      const progress = normalizeConfig(next).progress ?? null;
      send(res, 200, { ok: true, hooks: await ctx.hooksInfo(ctx.state.command), backup, progress, held });
      return;
    },
  },
  {
    method: 'GET',
    path: '/api/system',
    handler: async (ctx, _req, res) => {
      send(res, 200, {
        version: VERSION,
        kind: ctx.kindOf(),
        update: readUpdateState(),
        claude: claudeInfo(ctx.state.command),
        hooks: await ctx.hooksInfo(ctx.state.command),
      });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/update',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      let latest: string;
      try {
        latest = await ctx.latestOf(8000);
      } catch (err) {
        throw httpError(502, 'err.server.github', { error: (err as Error).message });
      }
      const newer = compareVersions(latest, VERSION) > 0;
      const kind = ctx.kindOf();
      if (body.install === true && newer) {
        if (kind === 'brew') throw httpError(409, 'update.brewRefused', { command: BREW_UPGRADE });
        if (kind !== 'npm-global' && kind !== 'local') {
          throw httpError(409, 'err.server.cannotUpdate', { kind });
        }
        let out: InstallOutcome;
        try {
          out = await installChecked(
            latest,
            VERSION,
            kind === 'local' ? localPrefix() : undefined,
            process.env,
            {
              install: ctx.opts.update?.install ?? ((v, p, sig) => installVersionAsync(v, p, sig)),
              verify: ctx.opts.update?.verify ?? verifyInstall,
              recordRejected: (r) => writeUpdateState({ checkedAt: Date.now(), ...r }),
            },
          );
        } catch (err) {
          if ((err as Error).message === 'digest-unavailable') {
            throw httpError(500, 'err.server.digestUnavailable');
          }
          throw httpError(500, 'err.server.npmFailed', { error: (err as Error).message });
        }
        if ('rejected' in out) {
          writeUpdateState({
            checkedAt: Date.now(),
            latest,
            rejected: latest,
            rollback: out.rollback,
            reason: out.reason,
          });
          const id =
            out.rollback === 'ok'
              ? 'err.server.updateRejected.ok'
              : out.rollback === 'failed'
                ? 'err.server.updateRejected.failed'
                : 'err.server.updateRejected.unverified';
          throw httpError(500, id, { version: latest, reason: out.reason, current: VERSION });
        }
        writeUpdateState({ checkedAt: Date.now(), latest, installed: latest });
        send(res, 200, {
          current: VERSION,
          latest,
          newer,
          installed: latest,
          kind,
          ...(out.inconclusive ? { inconclusive: out.inconclusive } : {}),
        });
        return;
      }
      writeUpdateState({ checkedAt: Date.now(), latest, ...keptRejection(readUpdateState(), latest) });
      send(res, 200, { current: VERSION, latest, newer, kind });
      return;
    },
  },
];
