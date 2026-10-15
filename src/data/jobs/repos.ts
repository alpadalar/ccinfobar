import fs from 'node:fs';
import path from 'node:path';
import type { ReposDirtyValue } from '../../core/job-values.js';
import { legacyDirtyFile, readLegacyDirty, readRepos, repoDirtyWanted, reposKey } from '../repos.js';
import { defaultDue, failEnvelope, type Job, okEnvelope, readEnvelope } from './runner.js';

const TTL = 60_000;
const RETRY_MS = 60_000;

// absolute, at most 4,096 characters, no control characters
export const REPOS_PARAM_RE = /^(?=[^\u0000-\u001f\u007f]{1,4096}$)(?:\/|[A-Za-z]:[\\/]|\\\\)/;

export const reposJob: Job<ReposDirtyValue> = {
  id: 'repos',
  network: 'none',
  lockMs: 120_000,
  timeoutMs: 20_000,
  retryMs: RETRY_MS,
  keyRe: /^repos-dirty-[0-9a-f]{20}$/,
  paramRe: REPOS_PARAM_RE,
  keys({ config, env, cwd, now, repos }) {
    if (!repoDirtyWanted(config) || !path.isAbsolute(cwd)) return [];
    const ws = repos ? repos() : readRepos(cwd, env, { persist: false, now });
    if (!ws || ws.total === 0) return [];
    // readRepos already read the dirty time
    const at = ws.dirtyAt;
    if (typeof at === 'number' && now >= at && now - at < TTL) return [];
    const root = path.resolve(cwd);
    return [{ key: reposKey(root), param: root, ttlMs: TTL }];
  },
  accepts(req, { config }) {
    const p = req.param;
    if (typeof p !== 'string' || !path.isAbsolute(p) || path.resolve(p) !== p) return false;
    if (req.key !== reposKey(p) || !repoDirtyWanted(config)) return false;
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  due(e, now) {
    return defaultDue(e, now, TTL);
  },
  readPrev(key, env) {
    const e = readEnvelope<ReposDirtyValue>(key, env);
    if (e) return e;
    const old = readLegacyDirty(key, env);
    return old ? okEnvelope(key, { dirty: old.dirty }, old.at) : null;
  },
  async run(req, ctx) {
    const root = req.param;
    if (!root) return failEnvelope(req.key, ctx.prev, 'failed', ctx.now, { retryMs: RETRY_MS });
    const { checkRepos } = await import('../../commands/repos.js');
    const dirty = await checkRepos(root, ctx.config, ctx.env);
    try {
      fs.unlinkSync(legacyDirtyFile(root, ctx.env));
    } catch {}
    return okEnvelope(req.key, { dirty }, ctx.now);
  },
};
