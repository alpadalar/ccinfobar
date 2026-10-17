import '../core/i18n/lazy.js';
import { setTimeout as delay } from 'node:timers/promises';
import {
  InstallError,
  type InstallPlan,
  parseInstallRef,
  planInstall,
  runInstall,
} from '../catalog/install.js';
import type { CatalogEntry } from '../catalog/model.js';
import {
  type PublishDeps,
  type PublishItem,
  type PublishReview,
  planHash,
  publishPlan,
  refreshReview,
  remoteList,
  remoteShow,
  reviewPublish,
  runPublish,
  signInOnly,
} from '../catalog/publish.js';
import { shareState } from '../catalog/share.js';
import { SignInError, signInWithGitHub } from '../catalog/signin.js';
import { forgetPublisher, listEntries, readCredential } from '../catalog/store.js';
import { type MessageId, t, withLanguage } from '../core/i18n/index.js';
import { padVisible, visibleWidth } from '../core/width.js';
import { kindText, MAX_TARGET_CHARS, visibleTarget, wrapLine } from '../importers/confirm.js';
import { createMarketClient } from '../market/client.js';
import { VERIFY_URL } from '../market/github.js';
import type { MarketSummary } from '../market/protocol.js';
// a static import of catalog.js keeps this chunk from splitting the render chunks
import { type Ctx, clean, endpointOf, find, GROUPS, KINDS, kindWord, when } from './catalog.js';
import { openBrowser } from './open.js';

const REASONS: Record<string, MessageId> = {
  invalid: 'market.error.invalid',
  'too-large': 'market.error.too-large',
  'over-quota': 'market.error.over-quota',
  conflict: 'market.error.conflict',
  stale: 'market.error.stale',
  forbidden: 'market.error.forbidden',
  'not-found': 'market.error.not-found',
  withdrawn: 'market.error.withdrawn',
  'rate-limited': 'market.error.rate-limited',
  'overwrite-disabled': 'market.error.overwrite-disabled',
  'unsupported-media': 'market.error.unsupported-media',
  unauthorized: 'market.error.unauthorized',
  banned: 'market.error.banned',
  'not-admin': 'market.error.not-admin',
  upstream: 'market.error.upstream',
  unavailable: 'market.error.unavailable',
  timeout: 'market.error.timeout',
  network: 'market.error.network',
  redirect: 'market.error.redirect',
  'too-many-redirects': 'market.error.too-many-redirects',
  'bad-json': 'market.error.bad-json',
  'bad-hash': 'market.error.bad-hash',
  'bad-endpoint': 'market.error.bad-endpoint',
  internal: 'market.error.internal',
  http: 'market.error.http',
  'read-only': 'market.error.read-only',
  'handle-taken': 'market.error.handle-taken',
  changed: 'market.error.changed',
  unreviewed: 'market.error.unreviewed',
  'bad-content': 'err.catalog.badContent',
  busy: 'err.catalog.busy',
  reserved: 'catalog.publish.reserved',
  'sign-in': 'err.catalog.signInFirst',
};

const ITEMS: Record<PublishItem['action'], MessageId> = {
  publish: 'catalog.publish.item.publish',
  version: 'catalog.publish.item.version',
  overwrite: 'catalog.publish.item.overwrite',
  withdraw: 'catalog.publish.item.withdraw',
};

const TARGET_INDENT = '      ';

export const reasonId = (code: string | null): MessageId =>
  code !== null && Object.hasOwn(REASONS, code) ? REASONS[code]! : 'market.error.unknown';

export const reasonText = (code: string | null, status?: number): string =>
  t(reasonId(code), { status: status ?? '' });

// the editor reaches publish.ts through this entry
export { planHash, publishPlan, remoteList, remoteShow, reviewPublish, runPublish };

export const shownUrl = (url: string): string => visibleTarget(clean(url));

// invisible and C1 characters as JSON escapes, so the data stays exact
const INVISIBLE_JSON = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const escapeUnits = (ch: string): string =>
  [...Array(ch.length).keys()].map((i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');

export function jsonOut(c: Ctx, data: object): void {
  const text = withLanguage('en', () => JSON.stringify({ schema: 1, ...data }));
  c.io.log(text.replace(INVISIBLE_JSON, escapeUnits));
}

function deps(c: Ctx): PublishDeps {
  return {
    dir: c.dir,
    env: c.env,
    now: c.now,
    defaultEndpoint: c.defaultEndpoint,
    ...(c.fetch ? { fetch: c.fetch } : {}),
  };
}

export const widthOf = (c: Ctx): number => Math.max(20, (c.io.columns ?? 80) - 1);

export function payloadLines(payload: unknown, width: number): string[] {
  const out: string[] = [];
  for (const line of JSON.stringify(payload, null, 2).split('\n')) {
    const lead = /^ */.exec(line)![0];
    const body = clean(visibleTarget(line.slice(lead.length)));
    out.push(...wrapLine(`    ${lead}${body}`, width, `    ${lead}  `));
  }
  return out;
}

function noEndpoint(c: Ctx): string | null {
  const endpoint = endpointOf(c);
  if (!endpoint) c.fail(t('err.catalog.noEndpoint'));
  return endpoint;
}

// a re-shared entry that was withdrawn; the marketplace keeps its id
export function reserved(item: PublishItem, entries: CatalogEntry[]): boolean {
  if (item.action !== 'version' && item.action !== 'overwrite') return false;
  return entries.find((e) => e.id === item.id)?.share.state === 'pending';
}

type Skip = { id: string; reason: string };

interface Planned {
  review: PublishReview;
  hash: string;
  notes: string[];
  skipped: Skip[];
}

// the review reads server meta; reserved items are skipped with a note
async function planned(c: Ctx, ids: string[] | null): Promise<Planned> {
  const review = await reviewPublish(ids, deps(c));
  const notes: string[] = [];
  const skipped: Skip[] = [];
  const entries = listEntries(c.dir).filter((e) => ids === null || ids.includes(e.id));
  if (ids !== null && review.code === null) {
    for (const e of entries) {
      if (review.plan.some((i) => i.id === e.id)) continue;
      const up = shareState(e) === 'published';
      skipped.push({ id: e.id, reason: up ? 'up-to-date' : 'not-shared' });
      const name = clean(e.name);
      notes.push(
        up
          ? t('catalog.publish.upToDate', { name, version: e.share.remote?.version ?? e.version })
          : t('catalog.publish.notShared', { name, ref: e.id }),
      );
    }
  }
  const plan: PublishItem[] = [];
  for (const item of review.plan) {
    if (!reserved(item, entries)) {
      plan.push(item);
      continue;
    }
    skipped.push({ id: item.id, reason: 'withdrawn' });
    notes.push(t('catalog.publish.reserved', { name: clean(item.name) }));
  }
  const kept = { ...review, plan };
  return { review: kept, hash: planHash(kept), notes, skipped };
}

function showPlan(c: Ctx, p: Planned, endpoint: string): void {
  const width = widthOf(c);
  c.io.log(t('catalog.publish.plan'));
  for (const item of p.review.plan) {
    const vars = { name: clean(item.name), kind: kindWord(item.kind), id: clean(item.remoteId) };
    c.io.log(`  ${t(ITEMS[item.action], vars)}`);
    if (item.payload) for (const line of payloadLines(item.payload, width)) c.io.log(line);
    else c.io.log(`    ${t('catalog.publish.noPayload')}`);
  }
  c.io.log('');
  const reg = p.review.registration;
  if (reg) {
    const handle = clean(reg.handle);
    c.io.log(t('catalog.publish.register', { handle, name: clean(reg.displayName) || handle }));
  }
  c.io.log(t('catalog.publish.where', { endpoint: shownUrl(endpoint) }));
}

function reviewFail(c: Ctx, code: string, submitUrl?: string, status?: number): void {
  if (code === 'sign-in') c.fail(t('err.catalog.signInFirst'));
  else if (code === 'read-only' && submitUrl)
    c.fail(t('catalog.publish.readOnly', { url: shownUrl(submitUrl) }));
  else c.fail(t('catalog.publish.error', { reason: reasonText(code, status) }));
}

export async function runPublishCommand(c: Ctx): Promise<void> {
  const endpoint = noEndpoint(c);
  if (!endpoint) return;
  const legacyNotes: string[] = [];
  const legacySkips: Skip[] = [];
  const refs = c.args.positional.slice(1);
  let ids: string[] | null = null;
  if (refs.length) {
    ids = [];
    for (const ref of refs) {
      const hit = find(c, ref);
      if (!hit) return;
      if (hit.source === 'system') {
        c.fail(t('err.catalog.systemReadOnly'));
        return;
      }
      if (hit.source === 'legacy') {
        legacySkips.push({ id: hit.item.ref, reason: 'not-shared' });
        legacyNotes.push(
          t('catalog.publish.notShared', { name: clean(hit.item.name), ref: clean(hit.item.ref) }),
        );
      } else if (!ids.includes(hit.entry.id)) ids.push(hit.entry.id);
    }
  }
  let cur = await planned(c, ids);
  const base = (p: Planned) => ({
    endpoint,
    plan: p.review.plan,
    registration: p.review.registration,
    results: null,
    code: p.review.code,
    ...(p.review.submitUrl ? { submitUrl: p.review.submitUrl } : {}),
    skipped: [...legacySkips, ...p.skipped],
  });
  const yes = c.args.flags.yes === true;
  if (cur.review.code) {
    if (c.json) jsonOut(c, base(cur));
    reviewFail(c, cur.review.code, cur.review.submitUrl, cur.review.status);
    return;
  }
  if (!c.json) for (const line of [...legacyNotes, ...cur.notes]) c.io.log(line);
  if (!cur.review.plan.length) {
    if (c.json) jsonOut(c, c.dryRun ? { ...base(cur), dryRun: true } : base(cur));
    else c.io.log(t('catalog.publish.nothing'));
    return;
  }
  if (c.json) {
    if (c.dryRun || !yes) jsonOut(c, c.dryRun ? { ...base(cur), dryRun: true } : base(cur));
    if (c.dryRun) return;
    if (!yes) {
      c.fail(t('catalog.publish.needsYes'));
      return;
    }
  } else {
    showPlan(c, cur, endpoint);
    if (c.dryRun) {
      c.io.log(t('catalog.publish.dryRun'));
      return;
    }
  }
  // what was shown is what is sent: plan again after the answer
  for (;;) {
    if (!yes && !c.json) {
      if (!c.io.tty) {
        c.fail(t('catalog.publish.needsYes'));
        return;
      }
      const count = cur.review.plan.length;
      if (!(await c.io.ask(t('catalog.publish.ask', { count }), false))) {
        c.io.log(t('catalog.publish.cancelled'));
        return;
      }
    }
    const again = await planned(c, ids);
    if (again.review.code) {
      if (c.json) jsonOut(c, base(again));
      reviewFail(c, again.review.code, again.review.submitUrl, again.review.status);
      return;
    }
    if (again.hash === cur.hash) break;
    cur = again;
    if (c.json) {
      jsonOut(c, { ...base(cur), code: 'unreviewed' });
      c.fail(t('catalog.publish.runAgain'));
      return;
    }
    c.io.log(t('catalog.publish.replanned'));
    if (!cur.review.plan.length) {
      c.io.log(t('catalog.publish.nothing'));
      return;
    }
    showPlan(c, cur, endpoint);
    if (yes || !c.io.tty) {
      c.fail(t('catalog.publish.runAgain'));
      return;
    }
  }
  const items = cur.review.plan;
  const res = await runPublish(cur.review, deps(c));
  if (c.json)
    jsonOut(c, {
      ...base(cur),
      code: res.code,
      ...(res.submitUrl ? { submitUrl: res.submitUrl } : {}),
      results: res.results,
    });
  if (res.code) {
    reviewFail(c, res.code, res.submitUrl, res.status);
    return;
  }
  if (!res.results.length && !c.json) c.io.log(t('catalog.publish.nothing'));
  for (const r of res.results) {
    const item = items.find((i) => i.id === r.id)!;
    const name = clean(item.name);
    if (!r.ok) {
      process.exitCode = 1;
      if (c.json) continue;
      if (r.code === 'withdrawn' && item.action !== 'withdraw')
        c.io.error(t('catalog.publish.reserved', { name }));
      else c.io.error(t('catalog.publish.failed', { name, reason: reasonText(r.code, r.status) }));
      continue;
    }
    if (c.json) continue;
    const id = clean(r.remoteId);
    if (r.version === null) c.io.log(t('catalog.publish.withdrawn', { name, id }));
    else c.io.log(t('catalog.publish.ok', { name, version: r.version, id }));
    if (r.pending) c.io.log(t('catalog.publish.pending'));
    if (r.code === 'changed') c.io.log(t('market.error.changed'));
  }
}

function remoteFail(c: Ctx, code: string | null, status?: number): void {
  if (code === 'no-endpoint') c.fail(t('err.catalog.noEndpoint'));
  else if (code === 'bad-endpoint') c.fail(t('err.catalog.badEndpoint'));
  else c.fail(t('catalog.remote.failed', { reason: reasonText(code, status) }));
}

const authorText = (e: Pick<MarketSummary, 'author' | 'publisher'>): string =>
  e.author
    ? t('catalog.remote.author', { author: clean(e.author), publisher: clean(e.publisher) })
    : clean(e.publisher);

export async function runRemoteList(c: Ctx): Promise<void> {
  const flag = c.args.flags.kind;
  if (flag !== undefined && !KINDS.some((k) => k === flag)) {
    c.fail(t('catalog.badKind'));
    return;
  }
  const refresh = c.args.flags.refresh;
  if (typeof refresh === 'string') {
    c.fail(t('catalog.usage'));
    return;
  }
  const res = await remoteList({ ...deps(c), refresh: refresh === true });
  if (res.code) {
    remoteFail(c, res.code, res.status);
    return;
  }
  const endpoint = endpointOf(c) ?? '';
  const entries = res.entries.filter((e) => flag === undefined || e.kind === flag);
  if (c.json) {
    jsonOut(c, {
      endpoint,
      entries,
      checkedAt: res.checkedAt ?? null,
      ...(res.stale ? { stale: true } : {}),
    });
    return;
  }
  c.io.log(t('catalog.remote.title', { endpoint: shownUrl(endpoint) }));
  if (!entries.length) c.io.log(`  ${t('catalog.remote.empty')}`);
  else listRows(c, entries);
  c.io.log('');
  if (res.stale) c.io.log(t('catalog.remote.stale'));
  if (res.checkedAt) c.io.log(t('catalog.remote.checked', { time: when(res.checkedAt) }));
}

function listRows(c: Ctx, entries: MarketSummary[]): void {
  const rows = entries.map((e) => ({
    kind: e.kind,
    cells: [
      clean(e.name),
      clean(e.id),
      t(`catalog.kind.${e.kind}`),
      t('catalog.version', { version: e.version }),
      authorText(e),
    ],
  }));
  const widths = [0, 1, 2, 3].map((i) => Math.max(0, ...rows.map((r) => visibleWidth(r.cells[i]!))));
  for (const kind of KINDS) {
    const group = rows.filter((r) => r.kind === kind);
    if (!group.length) continue;
    c.io.log(`  ${t(GROUPS[kind])}`);
    for (const r of group) {
      const cells = [...r.cells.slice(0, 4).map((x, i) => padVisible(x, widths[i]!)), r.cells[4]!];
      c.io.log(`    ${cells.join('  ')}`.trimEnd());
    }
  }
}

export async function runRemoteShow(c: Ctx): Promise<void> {
  const ref = c.args.positional[1]?.trim();
  if (!ref) {
    c.fail(t('catalog.usage'));
    return;
  }
  const res = await remoteShow(ref, deps(c));
  if (!res.entry) {
    if (res.code === 'invalid') c.fail(t('catalog.remote.badId', { ref: clean(ref) }));
    else remoteFail(c, res.code, res.status);
    return;
  }
  const e = res.entry;
  if (c.json) {
    jsonOut(c, { endpoint: endpointOf(c), entry: e, latest: res.latest });
    if (res.code) remoteFail(c, res.code, res.status);
    return;
  }
  const meta = [t(`catalog.kind.${e.kind}`), t('catalog.version', { version: e.version })];
  meta.push(t('catalog.by', { author: authorText(e) }));
  if (e.withdrawn) meta.push(t('catalog.share.withdrawn'));
  // a tombstone has no name
  c.io.log(e.name ? `${clean(e.name)}  ${clean(e.id)}` : clean(e.id));
  c.io.log(meta.join(' · '));
  if (e.description) c.io.log(clean(e.description));
  c.io.log('');
  c.io.log(t('catalog.remote.versions'));
  for (const v of e.versions) {
    const row = t('catalog.history.row', { version: v.version, at: when(v.at), note: clean(v.note) });
    c.io.log(`  ${row.trimEnd()}`);
  }
  if (res.latest) {
    c.io.log('');
    const { targets } = res.latest;
    if (!targets.length) c.io.log(t('catalog.remote.noTargets'));
    else {
      c.io.log(t('catalog.remote.targets'));
      const width = widthOf(c);
      for (const x of targets) {
        const line = t('import.target', { kind: kindText(x.kind), target: visibleTarget(clean(x.target)) });
        for (const part of wrapLine(line, width, TARGET_INDENT)) c.io.log(part);
      }
    }
  }
  if (res.code) remoteFail(c, res.code, res.status);
  if (e.withdrawn) return;
  c.io.log('');
  c.io.log(t('catalog.remote.installHint', { id: clean(e.id) }));
}

function targetLines(c: Ctx, plan: InstallPlan): void {
  if (!plan.targets.length) {
    c.io.log(t('catalog.remote.noTargets'));
    return;
  }
  const width = widthOf(c);
  c.io.log(t('import.targetsHeader'));
  for (const x of plan.targets) {
    const size = [...x.target].length;
    if (size > MAX_TARGET_CHARS) {
      c.io.log(t('catalog.install.targetLong', { kind: kindText(x.kind), count: size }));
      continue;
    }
    const line = t('import.target', { kind: kindText(x.kind), target: visibleTarget(clean(x.target)) });
    for (const part of wrapLine(line, width, TARGET_INDENT)) c.io.log(part);
  }
}

function installFail(c: Ctx, id: string, version: number | null, err: unknown): void {
  const e = err instanceof InstallError ? err : new InstallError('unknown');
  const vars = { id: clean(id), version: version ?? '' };
  if (c.json) jsonOut(c, { id, version, hash: null, entry: null, result: null, targets: [], code: e.code });
  if (e.code === 'no-endpoint') c.fail(t('err.catalog.noEndpoint'));
  else if (e.code === 'bad-endpoint') c.fail(t('err.catalog.badEndpoint'));
  else if (e.code === 'not-found' && e.status === null && version !== null)
    c.fail(t('err.catalog.install.noVersion', vars));
  else if (e.code === 'withdrawn') c.fail(t('err.catalog.install.withdrawn', vars));
  else if (e.code === 'not-found') c.fail(t('err.catalog.install.not-found', vars));
  else if (e.code === 'bad-content') c.fail(t('err.catalog.install.bad-content', vars));
  else if (e.code === 'hash-mismatch') c.fail(t('err.catalog.install.hash-mismatch', vars));
  else c.fail(t('catalog.install.failed', { ...vars, reason: reasonText(e.code, e.status ?? undefined) }));
}

// D-11: install saves a catalog entry; applying it is a separate step
export async function runInstallCommand(c: Ctx): Promise<void> {
  const raw = c.args.positional[1];
  const ref = parseInstallRef(raw);
  if (!ref || c.args.positional.length > 2) {
    c.fail(t('catalog.usage'));
    return;
  }
  let plan: InstallPlan;
  try {
    plan = await planInstall(raw!, {
      fetch: c.fetch ?? globalThis.fetch,
      env: c.env,
      dir: c.dir,
      defaultEndpoint: c.defaultEndpoint,
      now: c.now,
    });
  } catch (err) {
    installFail(c, ref.id, ref.version, err);
    return;
  }
  const id = clean(plan.id);
  const vars = { id, version: plan.version };
  const out = (result: string | null, entry: string | null, extra: object = {}) =>
    jsonOut(c, {
      id: plan.id,
      version: plan.version,
      hash: plan.hash,
      entry,
      result,
      targets: plan.targets.map((x) => ({ kind: x.kind, target: x.target })),
      ...extra,
    });
  const existing = plan.existing;
  if (!c.json) {
    c.io.log(plan.name ? `${clean(plan.name)}  ${id}` : id);
    const meta = [t(`catalog.kind.${plan.kind}`), t('catalog.version', { version: plan.version })];
    meta.push(t('catalog.by', { author: authorText(plan) }));
    c.io.log(meta.join(' · '));
    if (plan.description) c.io.log(clean(plan.description));
    c.io.log('');
    const local = existing && listEntries(c.dir).find((e) => e.id === existing.entryId);
    if (local) {
      const name = clean(local.name);
      c.io.log(t(existing.same ? 'catalog.install.existing' : 'catalog.install.update', { ...vars, name }));
    }
    targetLines(c, plan);
  }
  // nothing new to save, so nothing to agree to
  const ask = !existing?.same && plan.targets.length > 0;
  if (c.dryRun) {
    if (c.json) out('dry-run', existing?.entryId ?? null);
    else c.io.log(t('catalog.install.wouldInstall', vars));
    return;
  }
  if (ask && c.args.flags.yes !== true) {
    if (c.json || !c.io.tty) {
      if (c.json) out(null, null, { code: 'needs-yes' });
      c.fail(t('err.catalog.install.needsYes'));
      return;
    }
    if (!(await c.io.ask(t('catalog.install.ask', { name: clean(plan.name) || id }), false))) {
      c.fail(t('catalog.install.cancelled'));
      return;
    }
  }
  const done = runInstall(plan, { dir: c.dir, env: c.env, now: c.now });
  if (c.json) {
    out(done.result, done.entryId);
    return;
  }
  const name = clean(done.name);
  if (done.result === 'new') c.io.log(t('catalog.install.done', { ...vars, name }));
  else if (done.result === 'version') c.io.log(t('catalog.install.added', { ...vars, name }));
  else if (!existing?.same) c.io.log(t('catalog.install.existing', { ...vars, name }));
  const m = await import('./manage.js');
  c.io.log(t('catalog.install.applyHint', { name: m.shellArg(name) ?? clean(done.entryId) }));
}

const SIGN_IN: Record<string, MessageId> = {
  'not-github': 'err.catalog.signIn.notGithub',
  expired: 'err.catalog.signIn.expired',
  denied: 'err.catalog.signIn.denied',
  disabled: 'err.catalog.signIn.disabled',
  failed: 'err.catalog.signIn.failed',
  cancelled: 'err.catalog.signIn.cancelled',
  'no-endpoint': 'err.catalog.noEndpoint',
  'bad-endpoint': 'err.catalog.badEndpoint',
};

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  delay(ms, undefined, signal ? { signal } : {});

// contacts the marketplace and GitHub only here (D-08); the GitHub token is never stored
export async function runLogin(c: Ctx): Promise<void> {
  if (c.dryRun || c.args.positional.length > 1) {
    c.fail(t('catalog.usage'));
    return;
  }
  const say = (line: string) => (c.json ? c.io.error(line) : c.io.log(line));
  const ac = new AbortController();
  const stop = () => ac.abort();
  if (c.signal?.aborted) ac.abort();
  else c.signal?.addEventListener('abort', stop, { once: true });
  const flag = c.args.flags.open;
  try {
    const res = await signInWithGitHub({
      fetch: c.fetch ?? globalThis.fetch,
      now: () => c.now().getTime(),
      sleep: c.sleep ?? wait,
      signal: ac.signal,
      dir: c.dir,
      env: c.env,
      defaultEndpoint: c.defaultEndpoint,
      onCode: async (info) => {
        say(t('catalog.login.code', { code: clean(info.userCode), url: VERIFY_URL }));
        const count = Math.max(1, Math.round((info.expiresAt - c.now().getTime()) / 60_000));
        say(t('catalog.login.expires', { count }));
        const open =
          flag === true ||
          (flag === undefined &&
            c.io.tty &&
            !c.json &&
            (await c.io.ask(t('catalog.login.openAsk', { url: VERIFY_URL }), true)));
        // only the fixed GitHub page, never a url from a server
        if (open) (c.open ?? openBrowser)(VERIFY_URL);
        say(t('catalog.login.waiting'));
        process.on('SIGINT', stop);
      },
    });
    if (c.json) {
      jsonOut(c, res);
      return;
    }
    c.io.log(t('catalog.login.done', { handle: clean(res.handle) }));
    if (res.admin) c.io.log(t('catalog.login.admin'));
  } catch (err) {
    const e = err instanceof SignInError ? err : new SignInError('failed');
    const endpoint = endpointOf(c);
    if (e.tokenMode) {
      if (c.json) jsonOut(c, { endpoint, handle: null, admin: false, tokenMode: true });
      else c.io.log(t('catalog.login.tokenMode'));
      return;
    }
    if (c.json) jsonOut(c, { endpoint, handle: null, admin: false, code: e.code });
    const id = Object.hasOwn(SIGN_IN, e.code) ? SIGN_IN[e.code]! : null;
    c.fail(id ? t(id) : t('catalog.login.failed', { reason: reasonText(e.code, e.status ?? undefined) }));
  } finally {
    process.off('SIGINT', stop);
    c.signal?.removeEventListener('abort', stop);
  }
}

// revoking is best effort; the local token goes either way
export async function runLogout(c: Ctx): Promise<void> {
  if (c.dryRun || c.args.positional.length > 1) {
    c.fail(t('catalog.usage'));
    return;
  }
  const endpoint = noEndpoint(c);
  if (!endpoint) return;
  const token = readCredential(endpoint, c.dir);
  if (token !== null) {
    try {
      await createMarketClient({ endpoint, fetch: c.fetch ?? globalThis.fetch, token }).logout();
    } catch {}
    forgetPublisher(endpoint, c.dir);
  }
  if (c.json) {
    jsonOut(c, { endpoint, signedOut: token !== null });
    return;
  }
  const where = { endpoint: shownUrl(endpoint) };
  c.io.log(token !== null ? t('catalog.logout.done', where) : t('catalog.logout.none', where));
}

// moderation and reports load only when asked for
export async function runReport(c: Ctx): Promise<void> {
  await (await import('./catalog-admin.js')).runReportCommand(c);
}

export async function runAdmin(c: Ctx): Promise<void> {
  await (await import('./catalog-admin.js')).runAdminCommand(c);
}

// an explicit action reads meta; an unreachable server keeps the old behaviour
export async function githubOnly(c: Ctx, endpoint: string): Promise<boolean> {
  try {
    return signInOnly(await createMarketClient({ endpoint, fetch: c.fetch ?? globalThis.fetch }).meta());
  } catch {
    return false;
  }
}

// asks /v1/me and clears the review wait of entries that went live
export async function runPublisherCheck(c: Ctx): Promise<void> {
  if (c.dryRun || c.args.positional.length > 1 || c.args.flags.forget === true) {
    c.fail(t('catalog.usage'));
    return;
  }
  const endpoint = noEndpoint(c);
  if (!endpoint) return;
  const res = await refreshReview(deps(c));
  const me = res.me;
  if (res.code || !me) {
    if (c.json) jsonOut(c, { endpoint, publisher: null, admin: false, code: res.code });
    if (res.code === 'sign-in') c.fail(t('err.catalog.signInFirst'));
    else if (res.code === 'not-github') c.fail(t('err.catalog.signIn.notGithub'));
    else if (res.code === 'bad-endpoint') c.fail(t('err.catalog.badEndpoint'));
    else c.fail(t('catalog.publisher.checkFailed', { reason: reasonText(res.code, res.status) }));
    return;
  }
  const { checked, cleared, waiting } = res;
  if (c.json) {
    jsonOut(c, { endpoint, publisher: me.handle, admin: me.admin, checked, cleared, waiting });
    return;
  }
  c.io.log(t('catalog.publisher.signedIn', { endpoint: shownUrl(endpoint), handle: clean(me.handle) }));
  if (me.admin) c.io.log(t('catalog.login.admin'));
  if (cleared) c.io.log(t('catalog.publisher.approved', { count: cleared }));
  c.io.log(waiting ? t('catalog.publisher.waiting', { count: waiting }) : t('catalog.publisher.noneWaiting'));
}
