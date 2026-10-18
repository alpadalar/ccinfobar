import '../../core/i18n/lazy.js';
import { formatDateTime } from '../../core/i18n/format.js';
import { languageLocale, type MessageId, t } from '../../core/i18n/index.js';
import { MAX_TARGET_CHARS, visibleTarget } from '../../importers/confirm.js';
import {
  ApiError,
  api,
  idText,
  type MarketInstallInfo,
  type MarketInstallPlanInfo,
  type MarketTarget,
} from './api.js';
import { signInDialog } from './catalog-signin.js';
import { h } from './dom.js';
import { field } from './inspector.js';
import type {
  CatalogState,
  MarketEntryInfo,
  MarketSummaryInfo,
  PublishPlanInfo,
  PublishResultInfo,
} from './store.js';
import { confirmDialog, modal, toast } from './ui.js';

type PlanItem = PublishPlanInfo['plan'][number];
type Published = Awaited<ReturnType<typeof api.catalogPublish>>;

const TARGET: Record<string, MessageId> = {
  command: 'import.kind.command',
  http: 'import.kind.http',
  link: 'import.kind.link',
};

const unicodeEscape = (c: string) =>
  Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');

// invisible characters stay visible
const shown = (s: string) => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, unicodeEscape);

// still valid JSON: newlines outside strings are layout
export const payloadText = (payload: unknown) =>
  JSON.stringify(payload, null, 2).replace(/[\u007f-\u009f\p{Cf}\u2028\u2029]/gu, unicodeEscape);

const unknownReason = () => t('market.error.unknown');

function when(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : formatDateTime(d, languageLocale());
}

// a GitHub-only marketplace without a stored token
const needsSignIn = (e: unknown) => e instanceof ApiError && e.data?.code === 'sign-in';

const accountText = (handle: string | null) =>
  handle ? t('catalog.login.done', { handle: shown(handle) }) : t('catalog.signin.signedIn');

// asks first; the token cannot be shown again
async function signOut(endpoint: string): Promise<CatalogState | null> {
  const where = { endpoint: shown(endpoint) };
  const sure = await confirmDialog(
    t('catalog.signin.out'),
    t('catalog.signin.outText', where),
    t('catalog.signin.out'),
  );
  if (!sure) return null;
  try {
    const r = await api.logout();
    toast(t(r.signedOut ? 'catalog.logout.done' : 'catalog.logout.none', where), 'info');
    return r.catalog;
  } catch (err) {
    toast((err as Error).message, 'error');
    return null;
  }
}

function accountLine(handle: string | null, onSignOut: () => void): HTMLElement[] {
  return [
    h('span', null, accountText(handle)),
    h('button', { class: 'btn sm', type: 'button', onClick: onSignOut }, t('catalog.signin.out')),
  ];
}

const isPlan = (x: unknown): x is PublishPlanInfo =>
  !!x &&
  typeof x === 'object' &&
  Array.isArray((x as PublishPlanInfo).plan) &&
  typeof (x as PublishPlanInfo).planHash === 'string';

function planItem(item: PlanItem): HTMLElement {
  return h(
    'li',
    { class: 'catalog-publish-item' },
    h(
      'div',
      { class: 'catalog-publish-head' },
      h('span', { class: `theme-tag ${item.action}` }, t(`catalog.publish.action.${item.action}`)),
      h('strong', null, shown(item.name)),
      h('span', { class: 'theme-tag' }, t(`catalog.kind.${item.kind}`)),
      item.remoteId ? h('code', null, shown(item.remoteId)) : null,
    ),
    item.payload === null
      ? h('p', { class: 'hint' }, t('catalog.publish.noPayload'))
      : h('pre', { class: 'code-preview catalog-payload' }, payloadText(item.payload)),
  );
}

function resultText(r: PublishResultInfo, item: PlanItem | undefined): string[] {
  const name = shown(item?.name ?? r.id);
  if (!r.ok) {
    if (r.code === 'withdrawn' && item?.action !== 'withdraw')
      return [t('catalog.publish.reserved', { name })];
    return [
      t('catalog.publish.failed', {
        name,
        reason: idText(r.errorId, r.errorParams ?? null, unknownReason()),
      }),
    ];
  }
  const id = shown(r.remoteId ?? '');
  const out = [
    r.version === null
      ? t('catalog.publish.withdrawn', { name, id })
      : t('catalog.publish.ok', { name, version: r.version, id }),
  ];
  if (r.errorId) out.push(idText(r.errorId, null, ''));
  return out.filter(Boolean);
}

export async function publishDialog(data: CatalogState, refs?: string[]): Promise<CatalogState | null> {
  if (!data.publishable) return null;
  // null: sign in first
  let view: PublishPlanInfo | null;
  try {
    view = await api.catalogPublishPlan(refs);
  } catch (err) {
    if (!needsSignIn(err)) {
      toast((err as Error).message, 'error');
      return null;
    }
    view = null;
  }
  const endpoint = view?.endpoint ?? data.endpoint ?? '';
  let account = data.market?.signedIn ? { handle: data.market.handle } : null;
  let latest: CatalogState | null = null;
  let busy = false;
  let sendShown = false;
  let close: (v?: unknown) => void = () => {};
  const who = h('div', { class: 'catalog-account' });
  const note = h('p', { class: 'hint warn', role: 'status' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const content = h('div', { class: 'catalog-publish' });
  const cancel = h(
    'button',
    { class: 'btn', type: 'button', onClick: () => close(latest) },
    t('web.ui.cancel'),
  );
  const send = h(
    'button',
    { class: 'btn primary', type: 'button', onClick: () => void go() },
    t('catalog.publish.send'),
  );

  function skippedText(s: PublishPlanInfo['skipped'][number]): string {
    const e = data.user.find((u) => u.id === s.id);
    const name = shown(e?.name ?? s.id);
    if (s.reason === 'withdrawn') return t('catalog.publish.reserved', { name });
    if (s.reason === 'up-to-date') return t('catalog.publish.upToDate', { name, version: e?.version ?? 1 });
    return t('catalog.publish.notShared', { name, ref: shown(s.id) });
  }

  function readOnlyText(url: string | undefined): string {
    return url
      ? t('catalog.publish.readOnly', { url: shown(url) })
      : idText('market.error.read-only', null, unknownReason());
  }

  // the handle a first publish registers can be changed here
  function handleField(reg: NonNullable<PublishPlanInfo['registration']>): HTMLElement {
    const input = h('input', { class: 'input mono', type: 'text', maxLength: 39, value: reg.handle });
    const use = h(
      'button',
      { class: 'btn sm', type: 'button', onClick: () => void setHandle(input.value) },
      t('catalog.publish.setHandle'),
    );
    const f = field(t('catalog.publish.handle'), input, t('catalog.publish.handleHint'));
    input.after(use);
    return h(
      'div',
      { class: 'catalog-publish-where' },
      h(
        'p',
        null,
        t('catalog.publish.register', {
          handle: shown(reg.handle),
          name: shown(reg.displayName) || shown(reg.handle),
        }),
      ),
      f,
    );
  }

  function showSend(on: boolean) {
    if (on === sendShown) return;
    sendShown = on;
    if (on) cancel.after(send);
    else send.remove();
  }

  function renderAccount() {
    who.replaceChildren(...(account ? accountLine(account.handle, () => void leave()) : []));
  }

  // asks the server again, e.g. after a sign-in
  async function reload() {
    busy = true;
    err.textContent = '';
    try {
      view = await api.catalogPublishPlan(refs);
    } catch (e) {
      if (needsSignIn(e)) view = null;
      else err.textContent = (e as Error).message;
    } finally {
      busy = false;
    }
    note.textContent = '';
    render();
  }

  async function enter() {
    if (busy) return;
    const done = await signInDialog();
    if (!done) return;
    account = { handle: done.handle };
    renderAccount();
    await reload();
    try {
      latest = await api.catalog();
    } catch {}
  }

  async function leave() {
    if (busy) return;
    const next = await signOut(endpoint);
    if (!next) return;
    latest = next;
    account = null;
    renderAccount();
    await reload();
  }

  async function setHandle(value: string) {
    if (busy) return;
    busy = true;
    err.textContent = '';
    try {
      view = await api.catalogPublisher(value.trim(), refs);
      note.textContent = '';
      render();
    } catch (e) {
      err.textContent = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  function render() {
    if (!view) {
      showSend(false);
      content.replaceChildren(
        h('p', { class: 'modal-text' }, t('catalog.signin.needed')),
        h(
          'p',
          null,
          h(
            'button',
            { class: 'btn primary', type: 'button', onClick: () => void enter() },
            t('catalog.signin.title'),
          ),
        ),
      );
      return;
    }
    const skipped = view.skipped.map((s) => h('li', null, skippedText(s)));
    if (view.code === 'read-only' || !view.plan.length) {
      showSend(false);
      content.replaceChildren(
        h(
          'p',
          { class: 'modal-text' },
          view.code === 'read-only' ? readOnlyText(view.submitUrl) : t('catalog.publish.nothing'),
        ),
        skipped.length ? h('ul', { class: 'catalog-publish-skipped' }, ...skipped) : '',
      );
      return;
    }
    const reg = view.registration;
    showSend(true);
    content.replaceChildren(
      h('p', { class: 'modal-text' }, t('catalog.publish.plan')),
      h('ol', { class: 'catalog-publish-list' }, ...view.plan.map(planItem)),
      skipped.length ? h('ul', { class: 'catalog-publish-skipped' }, ...skipped) : '',
      reg ? handleField(reg) : '',
      h(
        'p',
        { class: 'catalog-publish-where' },
        t('catalog.publish.where', { endpoint: shown(view.endpoint) }),
      ),
    );
  }

  function results(r: Published) {
    const items = new Map((view?.plan ?? []).map((i) => [i.id, i]));
    const rows: HTMLElement[] = [];
    if (r.code === 'read-only')
      rows.push(h('li', { class: 'catalog-result failed' }, readOnlyText(r.submitUrl)));
    for (const x of r.results)
      rows.push(
        h(
          'li',
          { class: `catalog-result ${x.ok ? 'ok' : 'failed'}` },
          ...resultText(x, items.get(x.id)).map((line) => h('span', null, line)),
        ),
      );
    if (!rows.length) rows.push(h('li', { class: 'catalog-result' }, t('catalog.publish.nothing')));
    note.textContent = '';
    showSend(false);
    cancel.textContent = t('web.settings.done');
    cancel.className = 'btn primary';
    content.replaceChildren(h('ul', { class: 'catalog-publish-results' }, ...rows));
  }

  // only this click sends, with the reviewed hash
  async function go() {
    if (busy || !view) return;
    busy = true;
    send.disabled = true;
    err.textContent = '';
    try {
      const r = await api.catalogPublish(refs, view.planHash);
      latest = r.catalog;
      results(r);
    } catch (e) {
      if (e instanceof ApiError && e.data?.errorId === 'err.catalog.planChanged' && isPlan(e.data)) {
        view = e.data;
        note.textContent = t('catalog.publish.changedPlan');
        render();
        try {
          latest = await api.catalog();
        } catch {}
      } else if (needsSignIn(e)) {
        view = null;
        account = null;
        renderAccount();
        render();
      } else err.textContent = (e as Error).message;
    } finally {
      busy = false;
      send.disabled = false;
    }
  }

  const shownDialog = modal<CatalogState>({
    title: t('catalog.publish.title'),
    wide: true,
    body: [who, note, content, err],
    actions: (done) => {
      close = done;
      return [h('span', { class: 'spacer' }), cancel];
    },
  });
  renderAccount();
  render();
  // Enter must not publish
  cancel.focus();
  return (await shownDialog) ?? latest;
}

function by(e: Pick<MarketSummaryInfo, 'author' | 'publisher'>): string {
  const publisher = shown(e.publisher);
  return e.author
    ? t('catalog.remote.by', { author: shown(e.author), publisher })
    : t('catalog.remote.publisher', { publisher });
}

function meta(e: MarketSummaryInfo): HTMLElement[] {
  return [
    h('span', { class: 'theme-tag' }, t(`catalog.kind.${e.kind}`)),
    h('span', { class: 'catalog-version' }, t('catalog.version', { version: e.version })),
    h('span', { class: 'catalog-author' }, by(e)),
    ...(e.withdrawn ? [h('span', { class: 'catalog-chip withdrawn' }, t('catalog.share.withdrawn'))] : []),
  ];
}

// the catalog state the marketplace dialogs read and report changes to
export interface MarketView {
  data: () => CatalogState;
  onChange: (next: CatalogState) => void;
}

const signedIn = (view?: MarketView) => view?.data().market?.signedIn === true;

// the state after a sign-in in a dialog
async function afterSignIn(view?: MarketView): Promise<void> {
  try {
    const next = await api.catalog();
    view?.onChange(next);
  } catch {}
}

function remoteRow(e: MarketSummaryInfo, view?: MarketView): HTMLElement {
  const name = shown(e.name);
  return h(
    'button',
    {
      class: 'catalog-remote-row catalog-card',
      type: 'button',
      title: t('catalog.detailsName', { name }),
      'aria-haspopup': 'dialog',
      onClick: () => void remoteEntryDialog(e.id, view),
    },
    h('span', { class: 'theme-card-head' }, h('strong', null, name)),
    h('span', { class: 'catalog-meta' }, ...meta(e)),
    e.description ? h('span', { class: 'theme-desc' }, shown(e.description)) : null,
  );
}

export function marketplaceSection(
  data: CatalogState,
  onChange?: (next: CatalogState) => void,
  latest?: () => CatalogState,
): HTMLElement | null {
  if (!data.publishable) return null;
  let current = data;
  // the page may change sign-in and entries meanwhile
  const view: MarketView = {
    data: () => latest?.() ?? current,
    onChange: (next) => {
      current = next;
      onChange?.(next);
    },
  };
  const status = h('p', { class: 'hint', role: 'status' }, t('catalog.remote.loading'));
  const partial = h('p', { class: 'hint catalog-partial', role: 'status' });
  partial.hidden = true;
  const list = h('div', { class: 'catalog-remote-list catalog-grid' });
  const head = h('h3', { class: 'catalog-section-head' }, t('catalog.tab.market'));
  const checked = h('span', { class: 'hint catalog-checked' });
  let busy = true;
  const refresh = h(
    'button',
    {
      class: 'btn sm',
      type: 'button',
      title: t('catalog.remote.refreshTitle'),
      disabled: true,
      onClick: () => void load(true),
    },
    t('catalog.remote.refresh'),
  );

  // the only requests: opening the tab and Refresh
  async function load(again: boolean) {
    if (again && busy) return;
    busy = true;
    refresh.disabled = true;
    partial.hidden = true;
    partial.textContent = '';
    try {
      const r = await api.catalogRemote(again);
      head.textContent = t('catalog.remote.title', { endpoint: shown(r.endpoint) });
      const entries = Array.isArray(r.entries) ? r.entries : [];
      status.className = 'hint';
      status.setAttribute('role', 'status');
      status.textContent = r.stale
        ? t('catalog.remote.stale')
        : entries.length
          ? ''
          : t('catalog.remote.empty');
      if (r.partial) {
        partial.textContent = t('catalog.remote.partial');
        partial.hidden = false;
      }
      checked.textContent = r.checkedAt ? t('catalog.remote.lastChecked', { time: when(r.checkedAt) }) : '';
      list.replaceChildren(...entries.map((e) => remoteRow(e, view)));
    } catch (err) {
      status.className = 'form-error';
      status.setAttribute('role', 'alert');
      status.textContent = t('catalog.remote.failed', { reason: (err as Error).message });
    } finally {
      busy = false;
      refresh.disabled = false;
    }
  }

  const box = h(
    'section',
    { class: 'catalog-section', 'data-section': 'market' },
    head,
    h('div', { class: 'catalog-remote-bar' }, refresh, checked),
    status,
    partial,
    list,
  );
  void load(false);
  return box;
}

// sign-in and sign-out for the User tab
export function accountBar(data: CatalogState, onChange: (next: CatalogState) => void): HTMLElement | null {
  const on = data.market ? data.market.endpoint !== null : data.publishable;
  if (!on || !data.publishable) return null;
  const market = data.market;
  const box = h('div', { class: 'catalog-account catalog-account-bar' });
  if (market?.signedIn) {
    box.append(
      ...accountLine(market.handle, async () => {
        const next = await signOut(market.endpoint ?? data.endpoint ?? '');
        if (next) onChange(next);
      }),
    );
  } else {
    box.append(
      h(
        'button',
        {
          class: 'btn sm',
          type: 'button',
          onClick: async () => {
            if (await signInDialog()) await afterSignIn({ data: () => data, onChange });
          },
        },
        t('catalog.signin.title'),
      ),
    );
  }
  return box;
}

function versionRow(v: MarketEntryInfo['versions'][number]): HTMLElement {
  return h(
    'li',
    { class: 'catalog-history-row' },
    h('strong', null, t('catalog.version', { version: v.version })),
    h('span', { class: 'catalog-history-at' }, when(v.at)),
    v.note ? h('span', { class: 'catalog-history-note' }, shown(v.note)) : null,
  );
}

const targetKind = (kind: string) => (TARGET[kind] ? t(TARGET[kind]!) : shown(kind));

// as in the CLI: in full, invisible characters named
function targetList(targets: MarketTarget[]): HTMLElement {
  return h(
    'ul',
    { class: 'catalog-targets' },
    ...targets.map((x) =>
      [...x.target].length > MAX_TARGET_CHARS
        ? h(
            'li',
            { class: 'catalog-consent-long' },
            t('catalog.install.targetLong', { kind: targetKind(x.kind), count: [...x.target].length }).trim(),
          )
        : h(
            'li',
            null,
            h('span', { class: 'theme-tag' }, targetKind(x.kind)),
            h('code', { class: 'catalog-consent-target' }, visibleTarget(x.target)),
          ),
    ),
  );
}

export async function remoteEntryDialog(id: string, view?: MarketView): Promise<void> {
  let info: Awaited<ReturnType<typeof api.catalogRemoteEntry>>;
  try {
    info = await api.catalogRemoteEntry(id);
  } catch (err) {
    toast((err as Error).message, 'error');
    return;
  }
  const e = info.entry;
  const versions = [...(Array.isArray(e.versions) ? e.versions : [])].sort((a, b) => b.version - a.version);
  const targets = info.latest?.targets ?? [];
  const body: HTMLElement[] = [
    h('div', { class: 'catalog-remote-head' }, ...meta(e), h('code', null, shown(e.id))),
  ];
  if (e.description) body.push(h('p', { class: 'theme-desc' }, shown(e.description)));
  body.push(
    h('h4', { class: 'catalog-group-head' }, t('catalog.remote.versions')),
    h('ol', { class: 'catalog-history' }, ...versions.map(versionRow)),
  );
  if (info.latest) {
    if (!targets.length) body.push(h('p', { class: 'hint' }, t('catalog.remote.noTargets')));
    else body.push(h('p', { class: 'modal-text' }, t('catalog.remote.targets')), targetList(targets));
  }
  if (info.errorId)
    body.push(
      h(
        'div',
        { class: 'form-error', role: 'alert' },
        idText(info.errorId, info.errorParams ?? null, unknownReason()),
      ),
    );
  const name = e.name || e.id;
  const live = !e.withdrawn;
  await modal({
    title: shown(name),
    wide: true,
    body,
    actions: (done) => {
      const install =
        live && info.latest
          ? h(
              'button',
              {
                class: 'btn primary',
                type: 'button',
                onClick: () => {
                  done();
                  void installDialog(e.id, view);
                },
              },
              t('catalog.install.action'),
            )
          : null;
      return [
        live
          ? h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onClick: () => {
                  done();
                  void reportDialog(e.id, name, view);
                },
              },
              t('catalog.report.action'),
            )
          : null,
        h('span', { class: 'spacer' }),
        h(
          'button',
          { class: install ? 'btn' : 'btn primary', type: 'button', onClick: () => done() },
          t('web.settings.done'),
        ),
        install,
      ];
    },
  });
}

const isInstallPlan = (x: unknown): x is MarketInstallPlanInfo =>
  !!x &&
  typeof x === 'object' &&
  typeof (x as MarketInstallPlanInfo).id === 'string' &&
  typeof (x as MarketInstallPlanInfo).hash === 'string' &&
  Number.isInteger((x as MarketInstallPlanInfo).version) &&
  Array.isArray((x as MarketInstallPlanInfo).targets);

function installedText(r: MarketInstallInfo, version: number): string {
  const name = shown(r.name);
  if (r.result === 'same') return t('catalog.install.toastSame', { name });
  if (r.result === 'version') return t('catalog.install.toastVersion', { name, version });
  return t('catalog.install.toast', { name });
}

// D-11: review first; installing keeps the entry, applying stays separate
export async function installDialog(id: string, view?: MarketView): Promise<boolean> {
  let plan: MarketInstallPlanInfo;
  try {
    plan = await api.catalogInstallPlan(id);
  } catch (err) {
    toast((err as Error).message, 'error');
    return false;
  }
  let busy = false;
  let installed = false;
  let close: (v?: unknown) => void = () => {};
  const content = h('div', { class: 'catalog-install' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const cancel = h('button', { class: 'btn', type: 'button', onClick: () => close() }, t('web.ui.cancel'));
  const go = h(
    'button',
    { class: 'btn primary', type: 'button', onClick: () => void send() },
    t('catalog.install.action'),
  );
  const again = h(
    'button',
    { class: 'btn primary', type: 'button', onClick: () => void review() },
    t('catalog.install.reload'),
  );
  let changed: MarketInstallPlanInfo | null = null;

  function localName(entryId: string): string {
    return shown(view?.data().user.find((u) => u.id === entryId)?.name ?? entryId);
  }

  function render() {
    const p = plan;
    const existing = p.existing
      ? p.existing.same
        ? t('catalog.install.existing', {
            id: shown(p.id),
            version: p.version,
            name: localName(p.existing.entryId),
          })
        : t('catalog.install.update', { version: p.version, name: localName(p.existing.entryId) })
      : '';
    content.replaceChildren(
      h(
        'div',
        { class: 'catalog-remote-head' },
        h('strong', null, shown(p.name)),
        h('span', { class: 'theme-tag' }, t(`catalog.kind.${p.kind}`)),
        h('span', { class: 'catalog-version' }, t('catalog.version', { version: p.version })),
        h('span', { class: 'catalog-author' }, by(p)),
        h('code', null, shown(p.id)),
      ),
      p.description ? h('p', { class: 'theme-desc' }, shown(p.description)) : '',
      existing ? h('p', { class: 'hint' }, existing) : '',
      p.targets.length
        ? h('p', { class: 'modal-text' }, t('catalog.install.links'))
        : h('p', { class: 'hint' }, t('catalog.remote.noTargets')),
      p.targets.length ? targetList(p.targets) : '',
      h('p', { class: 'hint' }, t('catalog.install.where')),
    );
    again.remove();
    go.remove();
    if (!p.existing?.same) cancel.after(go);
  }

  // the marketplace changed since the review: show the new plan first
  async function review() {
    if (busy) return;
    err.textContent = '';
    if (changed) plan = changed;
    else {
      busy = true;
      try {
        plan = await api.catalogInstallPlan(id);
      } catch (e) {
        err.textContent = (e as Error).message;
        return;
      } finally {
        busy = false;
      }
    }
    changed = null;
    render();
    go.focus();
  }

  // only this click installs, with the reviewed hash and targets
  async function send() {
    if (busy) return;
    busy = true;
    go.disabled = true;
    err.textContent = '';
    try {
      const r = await api.catalogInstall(plan);
      installed = true;
      toast(installedText(r, plan.version), 'info');
      if (r.catalog) view?.onChange(r.catalog);
      close();
    } catch (e) {
      if (e instanceof ApiError && e.data?.code === 'changed') {
        changed = isInstallPlan(e.data.plan) ? e.data.plan : null;
        err.textContent = (e as Error).message;
        go.remove();
        cancel.after(again);
      } else err.textContent = (e as Error).message;
    } finally {
      busy = false;
      go.disabled = false;
    }
  }

  const shownDialog = modal({
    title: t('catalog.install.title', { name: shown(plan.name) }),
    wide: true,
    body: [content, err],
    actions: (done) => {
      close = done;
      return [h('span', { class: 'spacer' }), cancel];
    },
  });
  render();
  // Enter must not install
  cancel.focus();
  await shownDialog;
  return installed;
}

export const REASON_MAX = 200;

// D-09: signed in first, then a short reason
export async function reportDialog(id: string, name: string, view?: MarketView): Promise<boolean> {
  if (!signedIn(view)) {
    const done = await signInDialog();
    if (!done) return false;
    await afterSignIn(view);
  }
  let busy = false;
  let sent = false;
  let close: (v?: unknown) => void = () => {};
  const max = { max: REASON_MAX };
  const area = h('textarea', {
    class: 'input catalog-report-reason',
    rows: 4,
    maxLength: REASON_MAX,
    'aria-label': t('catalog.report.reason'),
    placeholder: t('catalog.report.reason'),
  });
  const count = h('span', { class: 'hint catalog-report-count', 'aria-live': 'polite' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const size = () => [...area.value.trim()].length;
  const counter = () => {
    count.textContent = `${size()}/${REASON_MAX}`;
  };
  area.addEventListener('input', counter);
  counter();
  const go = h(
    'button',
    { class: 'btn primary', type: 'button', onClick: () => void send() },
    t('catalog.report.send'),
  );

  async function send(retry = true): Promise<void> {
    if (busy) return;
    const reason = area.value.trim();
    if (size() < 1 || size() > REASON_MAX) {
      err.textContent = t('err.catalog.report.badReason', max);
      return;
    }
    busy = true;
    go.disabled = true;
    err.textContent = '';
    try {
      const r = await api.catalogReport(id, reason);
      sent = true;
      toast(t(r.reported ? 'catalog.report.done' : 'catalog.report.already', { id: shown(id) }), 'info');
      close();
    } catch (e) {
      // the token went away since
      if (retry && e instanceof ApiError && e.status === 401) {
        busy = false;
        const done = await signInDialog();
        if (done) {
          await afterSignIn(view);
          return send(false);
        }
      }
      err.textContent = t('catalog.report.failed', { id: shown(id), reason: (e as Error).message });
    } finally {
      busy = false;
      go.disabled = false;
    }
  }

  const shownDialog = modal({
    title: t('catalog.report.title', { name: shown(name) }),
    wide: true,
    body: [h('p', { class: 'modal-text' }, t('catalog.report.text')), area, count, err],
    actions: (done) => {
      close = done;
      return [
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', onClick: () => done() }, t('web.ui.cancel')),
        go,
      ];
    },
  });
  area.focus();
  await shownDialog;
  return sent;
}
