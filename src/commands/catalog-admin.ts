import '../core/i18n/lazy.js';
import { readCredential } from '../catalog/store.js';
import { type MessageId, t } from '../core/i18n/index.js';
import { padVisible, visibleWidth } from '../core/width.js';
import { wrapLine } from '../importers/confirm.js';
import { createMarketClient, MarketError } from '../market/client.js';
import { ID_PART_RE, isRemoteId, REPORT_REASON_MAX } from '../market/protocol.js';
import { type Ctx, clean, endpointOf, when } from './catalog.js';
import { jsonOut, payloadLines, reasonText, shownUrl, widthOf } from './catalog-market.js';

type Client = ReturnType<typeof createMarketClient>;

interface Session {
  endpoint: string;
  client: Client;
}

const codeOf = (err: unknown): { code: string; status?: number } =>
  err instanceof MarketError
    ? { code: err.code, ...(err.status === null ? {} : { status: err.status }) }
    : { code: 'unknown' };

// the token stays local; admin rights are checked by the server
function session(c: Ctx, extra: object): Session | null {
  const endpoint = endpointOf(c);
  if (!endpoint) {
    if (c.json) jsonOut(c, { endpoint: null, ...extra, code: 'no-endpoint' });
    c.fail(t('err.catalog.noEndpoint'));
    return null;
  }
  const token = readCredential(endpoint, c.dir);
  if (token === null) {
    if (c.json) jsonOut(c, { endpoint, ...extra, code: 'sign-in' });
    c.fail(t('err.catalog.signInFirst'));
    return null;
  }
  try {
    return { endpoint, client: createMarketClient({ endpoint, fetch: c.fetch ?? globalThis.fetch, token }) };
  } catch {
    if (c.json) jsonOut(c, { endpoint, ...extra, code: 'bad-endpoint' });
    c.fail(t('err.catalog.badEndpoint'));
    return null;
  }
}

type Action = 'read' | 'approve' | 'reject' | 'remove' | 'ban' | 'unban' | 'resolve';

// the server answers by route; these say what it means for each action
const CONFLICT: Partial<Record<Action, MessageId>> = {
  approve: 'err.catalog.admin.notPending',
  reject: 'err.catalog.admin.notPending',
  remove: 'err.catalog.admin.gone',
  ban: 'err.catalog.admin.isAdmin',
};
const MISSING: Partial<Record<Action, MessageId>> = {
  ban: 'err.catalog.admin.noPublisher',
  unban: 'err.catalog.admin.noPublisher',
  resolve: 'err.catalog.admin.noReport',
};

function failed(
  c: Ctx,
  s: Session,
  extra: object,
  err: unknown,
  vars: Record<string, string | number> = {},
  action: Action = 'read',
): void {
  const { code, status } = codeOf(err);
  if (c.json) jsonOut(c, { endpoint: s.endpoint, ...extra, code });
  const conflict = CONFLICT[action];
  const missing = MISSING[action] ?? (vars.id === undefined ? undefined : 'err.catalog.install.not-found');
  if (code === 'unauthorized') c.fail(t('err.catalog.signInFirst'));
  else if (code === 'not-admin') c.fail(t('err.catalog.admin.notAdmin'));
  else if (code === 'stale' && action === 'approve') c.fail(t('err.catalog.admin.stale', vars));
  else if (code === 'conflict' && conflict) c.fail(t(conflict, vars));
  else if (code === 'not-found' && missing) c.fail(t(missing, vars));
  else if (code === 'withdrawn' && vars.id !== undefined) c.fail(t('err.catalog.install.withdrawn', vars));
  else c.fail(t('catalog.admin.failed', { reason: reasonText(code, status) }));
}

function badId(c: Ctx, ref: string | undefined): string | null {
  if (!ref) {
    c.fail(t('catalog.admin.usage'));
    return null;
  }
  if (!isRemoteId(ref)) {
    c.fail(t('catalog.remote.badId', { ref: clean(ref) }));
    return null;
  }
  return ref;
}

function reasonOf(c: Ctx): string | null {
  const raw = c.args.flags.reason;
  const reason = typeof raw === 'string' ? raw.trim() : '';
  const size = [...reason].length;
  if (size < 1 || size > REPORT_REASON_MAX) {
    c.fail(t('err.catalog.report.reason', { max: REPORT_REASON_MAX }));
    return null;
  }
  return reason;
}

// D-09: signed-in users report an entry once
export async function runReportCommand(c: Ctx): Promise<void> {
  if (c.dryRun || c.args.positional.length > 2) {
    c.fail(t('catalog.usage'));
    return;
  }
  const ref = c.args.positional[1];
  if (!ref) {
    c.fail(t('catalog.usage'));
    return;
  }
  const id = badId(c, ref);
  if (!id) return;
  const reason = reasonOf(c);
  if (reason === null) return;
  const s = session(c, { entry: id, reported: false });
  if (!s) return;
  const vars = { id: clean(id) };
  try {
    const res = await s.client.report(id, reason);
    if (c.json) jsonOut(c, { endpoint: s.endpoint, entry: id, reported: true, report: res.id });
    else c.io.log(t('catalog.report.done', vars));
  } catch (err) {
    const { code, status } = codeOf(err);
    if (code === 'conflict') {
      if (c.json) jsonOut(c, { endpoint: s.endpoint, entry: id, reported: false, already: true });
      else c.io.log(t('catalog.report.already', vars));
      return;
    }
    if (c.json) jsonOut(c, { endpoint: s.endpoint, entry: id, reported: false, code });
    if (code === 'unauthorized') c.fail(t('err.catalog.signInFirst'));
    else if (code === 'not-found') c.fail(t('err.catalog.install.not-found', vars));
    else c.fail(t('catalog.report.failed', { ...vars, reason: reasonText(code, status) }));
  }
}

function table(c: Ctx, rows: string[][], tail: string[][] = []): void {
  const cols = Math.max(0, ...rows.map((r) => r.length - 1));
  const widths = [...Array(cols).keys()].map((i) =>
    Math.max(0, ...rows.map((r) => visibleWidth(r[i] ?? ''))),
  );
  const width = widthOf(c);
  rows.forEach((r, n) => {
    const cells = [...r.slice(0, -1).map((x, i) => padVisible(x, widths[i]!)), r[r.length - 1]!];
    c.io.log(`  ${cells.join('  ')}`.trimEnd());
    for (const line of tail[n] ?? [])
      for (const part of wrapLine(`      ${line}`, width, '      ')) c.io.log(part);
  });
}

async function pending(c: Ctx, s: Session): Promise<void> {
  let entries: Awaited<ReturnType<Client['admin']['pending']>>;
  try {
    entries = await s.client.admin.pending();
  } catch (err) {
    failed(c, s, { entries: [] }, err, {});
    return;
  }
  if (c.json) {
    jsonOut(c, { endpoint: s.endpoint, entries });
    return;
  }
  c.io.log(t('catalog.admin.pendingTitle', { endpoint: shownUrl(s.endpoint) }));
  if (!entries.length) {
    c.io.log(`  ${t('catalog.admin.noPending')}`);
    return;
  }
  table(
    c,
    entries.map((e) => [
      clean(e.id),
      t(`catalog.kind.${e.kind}`),
      clean(e.name),
      `@${clean(e.publisher)}`,
      t('catalog.version', { version: e.version }),
      when(e.createdAt),
    ]),
  );
  c.io.log('');
  c.io.log(t('catalog.admin.showHint'));
}

const shownTag = (etag: string): string => etag.replace(/^(?:W\/)?"|"$/g, '');

// reviewed content is untrusted: printed as sanitized JSON text, never applied
async function show(c: Ctx, s: Session, id: string): Promise<void> {
  let r: Awaited<ReturnType<Client['admin']['review']>>;
  try {
    r = await s.client.admin.review(id);
  } catch (err) {
    failed(c, s, { entry: null }, err, { id: clean(id) });
    return;
  }
  if (c.json) {
    jsonOut(c, { endpoint: s.endpoint, entry: r.entry, content: r.content, hash: r.hash, etag: r.etag });
    return;
  }
  const e = r.entry;
  c.io.log(e.name ? `${clean(e.name)}  ${clean(e.id)}` : clean(e.id));
  const author = e.author
    ? t('catalog.remote.author', { author: clean(e.author), publisher: clean(e.publisher) })
    : clean(e.publisher);
  const state = e.state === 'pending' ? t('catalog.share.review') : t('catalog.admin.live');
  c.io.log(
    [
      t(`catalog.kind.${e.kind}`),
      t('catalog.version', { version: e.version }),
      t('catalog.by', { author }),
      state,
    ].join(' · '),
  );
  if (e.description) c.io.log(clean(e.description));
  c.io.log('');
  c.io.log(t('catalog.remote.versions'));
  for (const v of e.versions) {
    const row = t('catalog.history.row', { version: v.version, at: when(v.at), note: clean(v.note) });
    c.io.log(`  ${row.trimEnd()}`);
  }
  c.io.log('');
  c.io.log(t('catalog.admin.content', { hash: clean(r.hash) }));
  for (const line of payloadLines(r.content, widthOf(c))) c.io.log(line);
  if (!r.etag) return;
  const tag = clean(shownTag(r.etag));
  c.io.log('');
  c.io.log(t('catalog.admin.tag', { tag }));
  if (e.state === 'pending') c.io.log(t('catalog.admin.approveHint', { id: clean(e.id), tag }));
}

async function reports(c: Ctx, s: Session): Promise<void> {
  let list: Awaited<ReturnType<Client['admin']['reports']>>;
  try {
    list = await s.client.admin.reports();
  } catch (err) {
    failed(c, s, { reports: [] }, err, {});
    return;
  }
  if (c.json) {
    jsonOut(c, { endpoint: s.endpoint, reports: list });
    return;
  }
  c.io.log(t('catalog.admin.reportsTitle', { endpoint: shownUrl(s.endpoint) }));
  if (!list.length) {
    c.io.log(`  ${t('catalog.admin.noReports')}`);
    return;
  }
  table(
    c,
    list.map((x) => [`#${x.id}`, clean(x.entry), `@${clean(x.reporter)}`, when(x.createdAt)]),
    list.map((x) => [clean(x.reason)]),
  );
  c.io.log('');
  c.io.log(t('catalog.admin.resolveHint'));
}

const TAG_RE = /^[0-9a-f]{64}-\d{1,15}$/;
const REPORT_RE = /^[1-9]\d{0,14}$/;

const ASK: Partial<Record<Action, MessageId>> = {
  reject: 'catalog.admin.ask.reject',
  remove: 'catalog.admin.ask.remove',
  ban: 'catalog.admin.ask.ban',
};
const DONE: Record<Exclude<Action, 'read' | 'approve'>, MessageId> = {
  reject: 'catalog.admin.rejected',
  remove: 'catalog.admin.removed',
  ban: 'catalog.admin.banned',
  unban: 'catalog.admin.unbanned',
  resolve: 'catalog.admin.resolved',
};

type Target = { id: string } | { handle: string } | { report: number };

function targetOf(c: Ctx, action: Action, raw: string | undefined): Target | null {
  if (action === 'ban' || action === 'unban') {
    const handle = raw?.replace(/^@/, '') ?? '';
    if (!raw) c.fail(t('catalog.admin.usage'));
    else if (!ID_PART_RE.test(handle)) c.fail(t('err.catalog.badHandle'));
    else return { handle };
    return null;
  }
  if (action === 'resolve') {
    if (!raw) c.fail(t('catalog.admin.usage'));
    else if (!REPORT_RE.test(raw)) c.fail(t('err.catalog.admin.badReport', { ref: clean(raw) }));
    else return { report: Number(raw) };
    return null;
  }
  const id = badId(c, raw);
  return id ? { id } : null;
}

// the approval pins the revision that was reviewed (If-Match with the review tag)
async function approve(c: Ctx, s: Session, id: string, tag: string | null, note?: string): Promise<void> {
  const vars = { id: clean(id) };
  try {
    const r = await s.client.admin.review(id);
    if (r.entry.state !== 'pending') {
      failed(c, s, { id }, new MarketError('conflict', 409), vars, 'approve');
      return;
    }
    if (!r.etag || (tag !== null && shownTag(tag) !== shownTag(r.etag))) {
      failed(c, s, { id }, new MarketError('stale', 412), vars, 'approve');
      return;
    }
    // no --tag: show what goes live and confirm; the tag shown is the one pinned (WR-01)
    if (tag === null) {
      const what = {
        ...vars,
        version: r.entry.version,
        name: clean(r.entry.name) || vars.id,
        hash: clean(r.hash.slice(0, 12)),
      };
      if (c.args.flags.yes !== true) {
        if (c.json || !c.io.tty) {
          if (c.json) jsonOut(c, { endpoint: s.endpoint, id, code: 'needs-yes' });
          c.fail(t('err.catalog.admin.approveNeedsYes', vars));
          return;
        }
        c.io.log(t('catalog.admin.approveWhat', what));
        if (!(await c.io.ask(t('catalog.admin.ask.approve', vars), false))) {
          c.io.log(t('catalog.admin.kept'));
          return;
        }
      } else if (!c.json) c.io.log(t('catalog.admin.approveWhat', what));
    }
    await s.client.admin.approve(id, r.etag, note);
    if (c.json) jsonOut(c, { endpoint: s.endpoint, id, approved: true });
    else c.io.log(t('catalog.admin.approved', { ...vars, version: r.entry.version }));
  } catch (err) {
    failed(c, s, { id }, err, vars, 'approve');
  }
}

async function moderate(c: Ctx, s: Session, action: Action, target: Target, note?: string): Promise<void> {
  const out: Record<string, string | number> = {};
  if ('id' in target) out.id = target.id;
  else if ('handle' in target) out.handle = target.handle;
  else out.id = target.report;
  const vars = Object.fromEntries(
    Object.entries(out).map(([k, v]) => [k, typeof v === 'string' ? clean(v) : v]),
  );
  const ask = ASK[action];
  if (ask && c.args.flags.yes !== true) {
    if (c.json || !c.io.tty) {
      if (c.json) jsonOut(c, { endpoint: s.endpoint, ...out, code: 'needs-yes' });
      c.fail(t('err.catalog.admin.needsYes'));
      return;
    }
    if (!(await c.io.ask(t(ask, vars), false))) {
      c.io.log(t('catalog.admin.kept'));
      return;
    }
  }
  const a = s.client.admin;
  const result: Record<string, boolean> = {};
  try {
    if ('report' in target) {
      await a.resolve(target.report);
      result.resolved = true;
    } else if ('handle' in target) {
      await (action === 'ban' ? a.ban : a.unban)(target.handle, note);
      result.banned = action === 'ban';
    } else if (action === 'reject') {
      await a.reject(target.id, note);
      result.rejected = true;
    } else {
      await a.remove(target.id, note);
      result.removed = true;
    }
  } catch (err) {
    failed(c, s, out, err, vars, action);
    return;
  }
  if (c.json) jsonOut(c, { endpoint: s.endpoint, ...out, ...result });
  else c.io.log(t(DONE[action as keyof typeof DONE], vars));
}

const ARITY: Record<string, number> = {
  pending: 0,
  reports: 0,
  show: 1,
  approve: 1,
  reject: 1,
  remove: 1,
  ban: 1,
  unban: 1,
  resolve: 1,
};

// hidden-ish: not in the main help, its own usage
export async function runAdminCommand(c: Ctx): Promise<void> {
  const sub = c.args.positional[1];
  if (sub === undefined) {
    c.io.log(t('catalog.admin.usage'));
    return;
  }
  const want = Object.hasOwn(ARITY, sub) ? ARITY[sub]! : -1;
  const note = c.args.flags.note;
  const tagFlag = c.args.flags.tag;
  if (
    want < 0 ||
    c.dryRun ||
    c.args.positional.length > 2 + want ||
    note === true ||
    (note !== undefined && want === 1 && (sub === 'show' || sub === 'resolve')) ||
    (tagFlag !== undefined && sub !== 'approve')
  ) {
    c.fail(t('catalog.admin.usage'));
    return;
  }
  if (sub === 'pending' || sub === 'reports') {
    if (note !== undefined) {
      c.fail(t('catalog.admin.usage'));
      return;
    }
    const s = session(c, sub === 'pending' ? { entries: [] } : { reports: [] });
    if (!s) return;
    if (sub === 'pending') await pending(c, s);
    else await reports(c, s);
    return;
  }
  const action = sub as Action;
  if (sub === 'show') {
    const id = badId(c, c.args.positional[2]);
    if (!id) return;
    const s = session(c, { entry: null });
    if (s) await show(c, s, id);
    return;
  }
  const target = targetOf(c, action, c.args.positional[2]);
  if (!target) return;
  let tag: string | null = null;
  if (tagFlag !== undefined) {
    const bare = typeof tagFlag === 'string' ? tagFlag.replace(/^"|"$/g, '') : '';
    if (!TAG_RE.test(bare)) {
      c.fail(t('err.catalog.admin.badTag', { tag: clean(typeof tagFlag === 'string' ? tagFlag : '') }));
      return;
    }
    tag = `"${bare}"`;
  }
  const keys =
    'id' in target
      ? { id: target.id }
      : 'handle' in target
        ? { handle: target.handle }
        : { id: target.report };
  const s = session(c, keys);
  if (!s) return;
  const text = typeof note === 'string' ? note : undefined;
  if ('id' in target && action === 'approve') await approve(c, s, target.id, tag, text);
  else await moderate(c, s, action, target, text);
}
