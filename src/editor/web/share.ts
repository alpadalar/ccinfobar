import '../../core/i18n/lazy.js';
import { applyCatalogContent, keepLanguage } from '../../core/edit.js';
import { t } from '../../core/i18n/index.js';
import { extractCode } from '../../core/share-code.js';
import { dropTargets, kindText, visibleTarget } from '../../importers/confirm.js';
import { api, type ShareInfo } from './api.js';
import { reviewable, targetConsent } from './catalog.js';
import { clear, h } from './dom.js';
import { isDirty, replaceAll, S, setWidth } from './store.js';
import { confirmDialog, modal, toast } from './ui.js';

function codeArea(props: Record<string, unknown>): HTMLTextAreaElement {
  const area = h('textarea', { class: 'input mono', spellcheck: false, ...props });
  area.classList.add('share-code');
  return area;
}

const message = (err: unknown) => (err as Error)?.message ?? String(err);

// as catalog apply: consent, theme install, unsaved replace
export async function openShareCode(code: string): Promise<void> {
  const name = t('share.entryName');
  if (
    isDirty() &&
    !(await confirmDialog(t('share.open.replaceTitle'), t('share.open.replaceText'), t('share.open.open')))
  )
    return;
  let r: Awaited<ReturnType<typeof api.shareOpen>>;
  try {
    r = await api.shareOpen(code);
  } catch (err) {
    toast(message(err), 'error');
    return;
  }
  if (r.unsafe.length) toast(t('share.open.unsafeDropped', { count: r.unsafe.length }), 'info');
  let content = r.content;
  let dropped = 0;
  if (r.targets.length && content.layout) {
    const choice = await targetConsent(name, r.targets);
    if (!choice) return;
    // overlong targets are never kept
    const gone = choice === 'drop' ? r.targets : r.targets.filter((x) => !reviewable(x));
    if (gone.length) {
      content = { ...content, layout: dropTargets(content.layout, gone) };
      dropped = gone.length;
    }
  }
  let themeId: string | undefined;
  if (content.theme) {
    try {
      const out = await api.shareInstallTheme(r.code);
      S.api.themes = out.themes;
      themeId = out.theme?.id;
      if (out.theme?.renamed) {
        const id = content.theme.id ?? content.appearance?.theme ?? '';
        toast(t('catalog.themeRenamed', { id: String(id), newId: out.theme.id }), 'info');
      }
    } catch (err) {
      toast(message(err), 'error');
      return;
    }
  }
  replaceAll(keepLanguage(applyCatalogContent(S.config, content, 'bundle', themeId), S.config));
  if (typeof r.cols === 'number') setWidth(r.cols);
  toast(dropped ? t('share.open.dropped', { count: dropped }) : t('share.open.done'), 'info');
}

export async function openCodeDialog(): Promise<void> {
  const area = codeArea({ placeholder: t('share.open.placeholder'), rows: 6 });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const code = await modal<string>({
    title: t('share.open.title'),
    wide: true,
    body: [h('p', { class: 'modal-text' }, t('share.open.text')), area, err],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, t('web.ui.cancel')),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: () => {
            const ex = extractCode(area.value);
            if ('errorId' in ex) {
              err.textContent = t(ex.errorId);
              return;
            }
            close(area.value);
          },
        },
        t('share.open.open'),
      ),
    ],
  });
  if (code !== undefined) await openShareCode(code);
}

async function copy(text: string, area: HTMLTextAreaElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('share.copied'));
  } catch {
    area.focus();
    area.select();
    toast(t('share.copyFailed'), 'error');
  }
}

export async function shareDialog(): Promise<void> {
  const box = h('div', { class: 'share-box' });
  let current: ShareInfo | null = null;
  const render = async (include: boolean) => {
    let info: ShareInfo;
    try {
      info = await api.share(S.config, include, S.width);
    } catch (err) {
      current = null;
      clear(box);
      box.append(h('div', { class: 'form-error', role: 'alert' }, message(err)));
      return;
    }
    current = info;
    const area = codeArea({ readonly: true, rows: 5, 'aria-label': t('share.dialog.title') });
    area.value = info.code;
    const list = info.included ? info.targets : info.dropped;
    const toggle = h('input', {
      type: 'checkbox',
      checked: info.included,
      onChange: () => void render(toggle.checked),
    });
    clear(box);
    box.append(
      area,
      h('p', { class: 'share-size' }, t('share.dialog.size', { chars: info.chars, max: info.max })),
      h('p', { class: 'modal-text' }, t('share.recipientHint')),
    );
    if (info.targets.length) {
      box.append(
        h('h3', { class: 'share-subtitle' }, t(info.included ? 'share.includedTitle' : 'share.removedTitle')),
        h(
          'ul',
          { class: 'catalog-targets catalog-consent' },
          ...list.map((x) =>
            h(
              'li',
              null,
              h('span', { class: 'theme-tag' }, kindText(x.kind as 'command' | 'http' | 'link')),
              h('code', { class: 'catalog-consent-target' }, visibleTarget(x.target)),
            ),
          ),
        ),
        h('label', { class: 'share-include' }, toggle, h('span', null, t('share.include'))),
        h('p', { class: 'share-warn' }, t('share.includeWarn')),
      );
    }
  };
  await render(false);
  await modal({
    title: t('share.dialog.title'),
    wide: true,
    body: [h('p', { class: 'modal-text' }, t('share.dialog.text')), box],
    actions: (close) => [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, t('web.ui.close')),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: () => {
            const area = box.querySelector('textarea');
            if (current && area) void copy(current.code, area);
          },
        },
        t('share.dialog.copy'),
      ),
    ],
  });
}
