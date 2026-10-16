import '../../core/i18n/lazy.js';
import type { EntryKind } from '../../core/edit.js';
import { formatDateTime } from '../../core/i18n/format.js';
import { languageLocale, t } from '../../core/i18n/index.js';
import { ApiError, api } from './api.js';
import { h } from './dom.js';
import { field, segmented, toggle } from './inspector.js';
import { type CatalogEntryInfo, type CatalogState, type CatalogVersionInfo, S } from './store.js';
import { confirmDialog, modal, toast } from './ui.js';

const KINDS: readonly EntryKind[] = ['bundle', 'preset', 'theme'];

type Clash = { id: string; version: number; name: string };

function clashOf(err: unknown): Clash | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const x = err.data?.exists as Partial<Clash> | undefined;
  if (!x || typeof x.id !== 'string' || typeof x.version !== 'number') return null;
  return { id: x.id, version: x.version, name: typeof x.name === 'string' ? x.name : '' };
}

const stale = (err: unknown) => err instanceof ApiError && err.status === 409 && !clashOf(err);

async function reload(): Promise<CatalogState | null> {
  try {
    return await api.catalog();
  } catch {
    return null;
  }
}

// a stale entry reloads the list
async function failed(err: unknown): Promise<CatalogState | null> {
  toast((err as Error).message, 'error');
  return stale(err) ? reload() : null;
}

function when(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : formatDateTime(d, languageLocale());
}

function textInput(value: string, max: number, placeholder?: string): HTMLInputElement {
  return h('input', { class: 'input', type: 'text', maxLength: max, value, placeholder });
}

export async function saveCurrentDialog(data: CatalogState): Promise<CatalogState | null> {
  let kind: EntryKind = 'bundle';
  let share = true;
  let shareTouched = false;
  let authorTouched = false;
  let clash: Clash | null = null;
  let latest: CatalogState | null = null;
  let busy = false;
  const name = textInput('', 64);
  const desc = textInput('', 200);
  const remembered = data.profile?.author ?? '';
  const author = textInput(remembered, 64);
  const note = textInput('', 200, t('catalog.save.notePlaceholder'));
  const kindBox = h('div', { class: 'catalog-kind' });
  const kindHint = h('div', { class: 'hint' });
  const shareSwitch = toggle(share, (v) => {
    share = v;
    shareTouched = true;
  });
  const noteField = field(t('catalog.save.note'), note);
  const clashText = h('p', { class: 'modal-text' });
  const update = h('button', { class: 'btn', type: 'button', onClick: () => void send({ mode: 'update' }) });
  const overwrite = h('button', {
    class: 'btn',
    type: 'button',
    onClick: () => void send({ mode: 'overwrite' }),
  });
  const clashBox = h(
    'div',
    { class: 'catalog-clash', role: 'group' },
    clashText,
    h('div', { class: 'catalog-clash-actions' }, update, overwrite),
  );
  const err = h('div', { class: 'form-error', role: 'alert' });
  const submit = h(
    'button',
    { class: 'btn primary', type: 'button', onClick: () => void send({ mode: 'new' }) },
    t('catalog.save.submit'),
  );
  let close: (v?: unknown) => void = () => {};

  function renderKind() {
    kindBox.replaceChildren(
      segmented(
        KINDS.map((k) => ({ value: k, label: t(`catalog.save.kind.${k}`) })),
        kind,
        (k) => {
          kind = k;
          renderKind();
          setClash(null);
        },
      ),
    );
    kindHint.textContent = t(`catalog.save.kindHint.${kind}`);
  }

  function setClash(c: Clash | null) {
    clash = c;
    clashBox.hidden = !c;
    noteField.hidden = !c;
    submit.hidden = !!c;
    const old = c ? (latest ?? data).user.find((u) => u.id === c.id) : undefined;
    // the entry keeps its own author unless one is typed
    if (!authorTouched) author.value = c ? (old?.author ?? author.value) : remembered;
    if (!c) return;
    // update and overwrite keep the old description and share choice, as the CLI does
    if (!desc.value.trim()) desc.value = old?.description ?? '';
    if (!shareTouched && old?.share) {
      share = old.share.wanted;
      shareSwitch.querySelector('input')!.checked = share;
    }
    const p = { name: c.name || name.value.trim(), version: c.version, next: c.version + 1 };
    clashText.textContent = t('catalog.save.existsText', p);
    update.textContent = t('catalog.save.update', p);
    overwrite.textContent = t('catalog.save.overwrite', p);
  }

  async function send({ mode }: { mode: 'new' | 'update' | 'overwrite' }) {
    if (busy) return;
    const title = name.value.trim();
    if (!title) {
      err.textContent = t('err.catalog.badName');
      return;
    }
    err.textContent = '';
    const target = mode === 'new' ? null : clash;
    const rev = target ? (latest ?? data).user.find((u) => u.id === target.id)?.rev : undefined;
    busy = true;
    try {
      const r = await api.catalogSave({
        kind,
        name: title,
        description: desc.value.trim(),
        ...(mode === 'new' || authorTouched ? { author: author.value.trim() } : {}),
        ...(mode === 'new' || shareTouched ? { share } : {}),
        mode,
        ...(target ? { id: target.id, note: note.value.trim() } : {}),
        ...(typeof rev === 'number' ? { rev } : {}),
        config: S.config,
      });
      toast(t('catalog.save.saved', { name: r.entry.name, version: r.entry.version }));
      close(r.catalog);
    } catch (e) {
      const c = clashOf(e);
      if (c) setClash(c);
      else {
        err.textContent = (e as Error).message;
        if (stale(e)) latest = (await reload()) ?? latest;
      }
    } finally {
      busy = false;
    }
  }

  name.addEventListener('input', () => setClash(null));
  author.addEventListener('input', () => {
    authorTouched = true;
  });
  renderKind();
  setClash(null);
  const r = await modal<CatalogState>({
    title: t('catalog.save.title'),
    body: [
      field(t('catalog.save.kind'), kindBox),
      kindHint,
      field(t('catalog.save.name'), name),
      field(t('catalog.save.description'), desc),
      field(t('catalog.save.author'), author, t('catalog.save.authorHint')),
      field(t('catalog.save.share'), shareSwitch, t('catalog.save.shareHint'), true),
      clashBox,
      noteField,
      err,
    ],
    actions: (done) => {
      close = done;
      return [
        h('button', { class: 'btn', type: 'button', onClick: () => done() }, t('web.ui.cancel')),
        submit,
      ];
    },
  });
  return r ?? latest;
}

function historyRow(v: CatalogVersionInfo, latest: boolean, fallback: string, restore: () => void) {
  const extra: string[] = [];
  if (v.restoredFrom !== null) extra.push(t('catalog.history.restored', { from: v.restoredFrom }));
  if (v.overwrittenAt !== null) extra.push(t('catalog.history.overwritten', { at: when(v.overwrittenAt) }));
  return h(
    'li',
    { class: 'catalog-history-row' },
    h('strong', null, t('catalog.version', { version: v.version })),
    h('span', { class: 'catalog-history-at' }, v.at ? when(v.at) : fallback),
    latest ? h('span', { class: 'theme-tag now' }, t('catalog.history.current')) : null,
    v.note ? h('span', { class: 'catalog-history-note' }, v.note) : null,
    ...extra.map((x) => h('span', { class: 'catalog-history-extra' }, x)),
    h('span', { class: 'spacer' }),
    latest
      ? null
      : h(
          'button',
          {
            class: 'btn sm',
            type: 'button',
            title: t('catalog.history.restoreTitle', { version: v.version }),
            onClick: restore,
          },
          t('catalog.history.restore'),
        ),
  );
}

export async function historyDialog(e: CatalogEntryInfo): Promise<CatalogState | null> {
  let info: Awaited<ReturnType<typeof api.catalogEntry>>;
  try {
    info = await api.catalogEntry(e.ref);
  } catch (err) {
    return failed(err);
  }
  const current = info.entry ?? e;
  const versions = [...(Array.isArray(info.versions) ? info.versions : [])].sort(
    (a, b) => b.version - a.version,
  );
  const top = versions[0]?.version;
  const fallback = t(current.source === 'legacy' ? 'catalog.source.legacy' : 'catalog.source.system');
  let busy = false;
  let close: (v?: unknown) => void = () => {};
  const restore = async (v: CatalogVersionInfo) => {
    if (busy) return;
    busy = true;
    try {
      const r = await api.catalogRestore(current.ref, v.version, current.rev);
      toast(t('catalog.restore.doneWeb', { from: v.version, name: current.name, version: r.entry.version }));
      close(r.catalog);
    } catch (err) {
      const next = await failed(err);
      if (next) close(next);
      busy = false;
    }
  };
  const r = await modal<CatalogState>({
    title: t('catalog.history.title', { name: current.name }),
    wide: true,
    body: [
      h(
        'ol',
        { class: 'catalog-history' },
        ...versions.map((v) => historyRow(v, v.version === top, fallback, () => void restore(v))),
      ),
    ],
    actions: (done) => {
      close = done;
      return [
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', type: 'button', onClick: () => done() }, t('web.settings.done')),
      ];
    },
  });
  return r ?? null;
}

export async function toggleShare(e: CatalogEntryInfo): Promise<CatalogState | null> {
  const on = !(e.share?.wanted ?? false);
  try {
    const r = await api.catalogShare(e.ref, on, e.rev);
    const name = r.entry.name;
    if (on) toast(t('catalog.share.onWeb', { name }), 'info');
    else if (r.entry.share?.state === 'withdraw-pending')
      toast(`${t('catalog.share.offWeb', { name })} ${t('catalog.share.withdrawLater')}`, 'info');
    else toast(t('catalog.share.offWeb', { name }), 'info');
    return r.catalog;
  } catch (err) {
    return failed(err);
  }
}

export async function deleteEntryDialog(e: CatalogEntryInfo): Promise<CatalogState | null> {
  const ok = await confirmDialog(
    t('catalog.delete.title', { name: e.name }),
    t(e.remote ? 'catalog.delete.textPublished' : 'catalog.delete.text'),
    t('catalog.delete.confirm'),
  );
  if (!ok) return null;
  try {
    const r = await api.catalogDelete(e.ref);
    toast(t('catalog.delete.doneWeb', { name: e.name }), 'info');
    return r.catalog;
  } catch (err) {
    return failed(err);
  }
}
