import '../core/i18n/lazy.js';
import { readCredential } from '../catalog/store.js';
import { t } from '../core/i18n/index.js';
import { padVisible, visibleWidth } from '../core/width.js';
import { wrapLine } from '../importers/confirm.js';
import { createMarketClient, MarketError } from '../market/client.js';
import { isRemoteId, REPORT_REASON_MAX } from '../market/protocol.js';
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

function failed(c: Ctx, s: Session, extra: object, err: unknown, target: Record<string, string>): void {
  const { code, status } = codeOf(err);
  if (c.json) jsonOut(c, { endpoint: s.endpoint, ...extra, code });
  if (code === 'unauthorized') c.fail(t('err.catalog.signInFirst'));
  else if (code === 'not-admin') c.fail(t('err.catalog.admin.notAdmin'));
  else if (code === 'not-found' && target.id) c.fail(t('err.catalog.install.not-found', target));
  else if (code === 'withdrawn' && target.id) c.fail(t('err.catalog.install.withdrawn', target));
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

// hidden-ish: not in the main help, its own usage
export async function runAdminCommand(c: Ctx): Promise<void> {
  const sub = c.args.positional[1];
  if (sub === undefined) {
    c.io.log(t('catalog.admin.usage'));
    return;
  }
  const arity: Record<string, number> = { pending: 0, reports: 0, show: 1 };
  const want = Object.hasOwn(arity, sub) ? arity[sub]! : -1;
  if (want < 0 || c.dryRun || c.args.positional.length > 2 + want) {
    c.fail(t('catalog.admin.usage'));
    return;
  }
  if (sub === 'show') {
    const id = badId(c, c.args.positional[2]);
    if (!id) return;
    const s = session(c, { entry: null });
    if (s) await show(c, s, id);
    return;
  }
  const s = session(c, sub === 'pending' ? { entries: [] } : { reports: [] });
  if (!s) return;
  if (sub === 'pending') await pending(c, s);
  else await reports(c, s);
}
