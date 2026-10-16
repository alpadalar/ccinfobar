import '../../core/i18n/lazy.js';
import { formatDateTime } from '../../core/i18n/format.js';
import { languageLocale, type MessageId, t } from '../../core/i18n/index.js';
import { visibleTarget } from '../../importers/confirm.js';
import { ApiError, api, idText } from './api.js';
import { h } from './dom.js';
import { field } from './inspector.js';
import type {
  CatalogState,
  MarketEntryInfo,
  MarketSummaryInfo,
  PublishPlanInfo,
  PublishResultInfo,
} from './store.js';
import { modal, toast } from './ui.js';

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
    return [t('catalog.publish.failed', { name, reason: idText(r.errorId, null, unknownReason()) })];
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
  let view: PublishPlanInfo;
  try {
    view = await api.catalogPublishPlan(refs);
  } catch (err) {
    toast((err as Error).message, 'error');
    return null;
  }
  let latest: CatalogState | null = null;
  let busy = false;
  let close: (v?: unknown) => void = () => {};
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
    const skipped = view.skipped.map((s) => h('li', null, skippedText(s)));
    if (view.code === 'read-only' || !view.plan.length) {
      send.remove();
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
    const items = new Map(view.plan.map((i) => [i.id, i]));
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
    send.remove();
    cancel.textContent = t('web.settings.done');
    cancel.className = 'btn primary';
    content.replaceChildren(h('ul', { class: 'catalog-publish-results' }, ...rows));
  }

  // only this click sends, with the reviewed hash
  async function go() {
    if (busy) return;
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
      } else err.textContent = (e as Error).message;
    } finally {
      busy = false;
      send.disabled = false;
    }
  }

  render();
  const shownDialog = modal<CatalogState>({
    title: t('catalog.publish.title'),
    wide: true,
    body: [note, content, err],
    actions: (done) => {
      close = done;
      return [
        h('span', { class: 'spacer' }),
        cancel,
        view.plan.length && view.code !== 'read-only' ? send : null,
      ];
    },
  });
  // Enter must not publish
  cancel.focus();
  return (await shownDialog) ?? latest;
}

function by(e: MarketSummaryInfo): string {
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

function remoteRow(e: MarketSummaryInfo): HTMLElement {
  return h(
    'button',
    { class: 'catalog-remote-row', type: 'button', onClick: () => void remoteEntryDialog(e.id) },
    h('span', { class: 'catalog-remote-head' }, h('strong', null, shown(e.name)), ...meta(e)),
    e.description ? h('span', { class: 'theme-desc' }, shown(e.description)) : null,
  );
}

export function marketplaceSection(data: CatalogState): HTMLElement | null {
  if (!data.publishable) return null;
  const status = h('p', { class: 'hint', role: 'status' }, t('catalog.remote.loading'));
  const list = h('div', { class: 'catalog-remote-list' });
  const head = h('h3', { class: 'catalog-section-head' }, t('catalog.tab.market'));
  const box = h(
    'section',
    { class: 'catalog-section', 'data-section': 'market' },
    head,
    h('p', { class: 'hint' }, t('catalog.remote.readOnly')),
    status,
    list,
  );
  void api.catalogRemote().then(
    (r) => {
      head.textContent = t('catalog.remote.title', { endpoint: shown(r.endpoint) });
      const entries = Array.isArray(r.entries) ? r.entries : [];
      status.textContent = entries.length ? '' : t('catalog.remote.empty');
      list.replaceChildren(...entries.map(remoteRow));
    },
    (err: unknown) => {
      status.className = 'form-error';
      status.setAttribute('role', 'alert');
      status.textContent = t('catalog.remote.failed', { reason: (err as Error).message });
    },
  );
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

export async function remoteEntryDialog(id: string): Promise<void> {
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
    else
      body.push(
        h('p', { class: 'modal-text' }, t('catalog.remote.targets')),
        h(
          'ul',
          { class: 'catalog-targets' },
          ...targets.map((x) =>
            h(
              'li',
              null,
              h('span', { class: 'theme-tag' }, TARGET[x.kind] ? t(TARGET[x.kind]!) : shown(x.kind)),
              // as in the CLI: in full, invisible characters named
              h('code', { class: 'catalog-consent-target' }, visibleTarget(x.target)),
            ),
          ),
        ),
      );
  }
  if (info.errorId)
    body.push(h('div', { class: 'form-error', role: 'alert' }, idText(info.errorId, null, unknownReason())));
  body.push(h('p', { class: 'hint' }, t('catalog.remote.readOnly')));
  await modal({
    title: shown(e.name || e.id),
    wide: true,
    body,
    actions: (done) => [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onClick: () => done() }, t('web.settings.done')),
    ],
  });
}
