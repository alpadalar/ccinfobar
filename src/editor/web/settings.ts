import {
  addProfileOverride,
  PROGRESS_CHOICES,
  PROGRESS_DEFAULTS,
  REFRESH_SUGGEST,
  refreshReasons,
  removeProfileOverride,
  rotationAddTheme,
  rotationMoveTheme,
  rotationRemoveTheme,
  setBudget,
  setLanguageSetting,
  setProfilesBuiltIn,
  setProgress,
  setRotationEvery,
  setRotationOrder,
  setRotationWeekday,
  setThemeRotation,
  timeRuleFeed,
  updateProfileOverride,
} from '../../core/edit.js';
import { en } from '../../core/i18n/en/index.js';
import { formatDateTime } from '../../core/i18n/format.js';
import { type LanguageSetting, languageLocale, type MessageId, t } from '../../core/i18n/index.js';
import { LANGUAGES, nativeName } from '../../core/i18n/languages.js';
import { pickUiLanguage } from '../../core/i18n/resolve.js';
import { titleWidgets } from '../../core/panel.js';
import {
  PROFILE_LABEL_MAX,
  PROFILE_MATCH_MAX,
  PROFILES,
  PROFILES_UPDATED,
  type ProfileVendor,
} from '../../core/profiles.js';
import {
  nextRotationChange,
  pickRotationTheme,
  ROTATION_DAYS,
  ROTATION_MINUTES_MAX,
} from '../../core/rotation.js';
import type { Config, ProfileOverride, ProgressConfig, RotationDay } from '../../core/types.js';
import { api, idText } from './api.js';
import { clear, h, icon } from './dom.js';
import { browserLanguages } from './i18n-static.js';
import { field, numberInput, segmented, textInput, toggle } from './inspector.js';
import { installDialog } from './install-dialog.js';
import { applySaved, commit, type HooksInfo, S } from './store.js';
import { setTipsHidden, tipsHidden } from './tips.js';
import { modal, toast } from './ui.js';
import { brewHint, canSelfUpdate, kindLabel } from './update-info.js';

const reasonText = (hk: HooksInfo): string => idText(hk.reasonId, hk.reasonParams, hk.reason ?? '');

function budgetInput(
  key: 'daily' | 'session' | 'warnAt',
  value: number | undefined,
  attrs: Record<string, unknown>,
  scale = 1,
): HTMLInputElement {
  return numberInput(
    value ?? '',
    (v) =>
      commit(setBudget(S.config, key, v === null ? undefined : v / scale), { coalesce: `budget.${key}` }),
    attrs,
  );
}

type ProfileKey = keyof ProfileOverride;
export type ProfileDraft = Partial<Record<ProfileKey, string | number>>;
export type ProfileApply = (fn: (c: Config) => Config, coalesce?: string) => void;

// example values stay literal, word hints are ids
const PROFILE_COLUMNS: {
  key: ProfileKey;
  label: MessageId;
  hint?: MessageId;
  example?: string;
  num?: boolean;
}[] = [
  { key: 'match', label: 'web.profile.match', example: 'glm-*' },
  { key: 'label', label: 'web.profile.label', example: 'GLM' },
  {
    key: 'contextWindow',
    label: 'web.profile.contextWindow',
    hint: 'web.profile.hint.contextWindow',
    num: true,
  },
  { key: 'input', label: 'web.profile.input', hint: 'web.profile.hint.input', num: true },
  { key: 'output', label: 'web.profile.output', hint: 'web.profile.hint.output', num: true },
  { key: 'cacheRead', label: 'web.profile.cacheRead', hint: 'web.profile.hint.cacheRead', num: true },
  { key: 'cacheWrite', label: 'web.profile.cacheWrite', hint: 'web.profile.hint.cacheWrite', num: true },
  { key: 'currency', label: 'web.profile.currency', example: 'USD' },
];

// undefined clears the field, null is invalid
function profileValue(
  key: ProfileKey,
  v: string | number | null | undefined,
): string | number | undefined | null {
  if (key === 'match') return typeof v === 'string' && v.trim() && v.length <= PROFILE_MATCH_MAX ? v : null;
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number')
    return Number.isFinite(v) && v > 0 && (key !== 'contextWindow' || Number.isInteger(v)) ? v : null;
  if (key === 'currency') return /^[a-z]{3}$/i.test(v) ? v.toUpperCase() : null;
  return v;
}

export const budgetValue = (v: number | null): number | undefined =>
  v === null || !Number.isFinite(v) ? undefined : Math.min(60000, Math.max(100, Math.floor(v)));

export const ageValue = (v: number | null): number | undefined =>
  v === null || !Number.isFinite(v) || Math.round(v) < 1 ? undefined : Math.min(720, Math.round(v));

export function draftOverride(draft: ProfileDraft): ProfileOverride | null {
  const out: Record<string, unknown> = {};
  for (const { key } of PROFILE_COLUMNS) {
    const v = profileValue(key, draft[key]);
    if (v === null) return null;
    if (v !== undefined) out[key] = v;
  }
  return out as unknown as ProfileOverride;
}

const tokens = (n: number | null) =>
  n === null ? '\u2014' : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}K`;

function prices(
  p: { input: number | null; output: number | null; cacheRead?: number | null; cacheWrite?: number | null },
  currency: string | null,
): string {
  if (p.input === null || p.output === null) return '\u2014';
  const parts = [
    t('web.profile.priceIn', { price: p.input }),
    t('web.profile.priceOut', { price: p.output }),
  ];
  if (typeof p.cacheRead === 'number') parts.push(t('web.profile.priceCacheRead', { price: p.cacheRead }));
  if (typeof p.cacheWrite === 'number') parts.push(t('web.profile.priceCacheWrite', { price: p.cacheWrite }));
  return `${parts.join(', ')}${currency ? ` ${currency}` : ''}`;
}

// built-in notes are English data; a stale translation falls back to it
function noteText(v: ProfileVendor): string | undefined {
  const id = `web.profile.note.${v.id}`;
  return Object.hasOwn(en, id) && en[id as keyof typeof en] === v.priceNote
    ? t(id as MessageId)
    : v.priceNote;
}

function builtInList(): HTMLElement {
  const list = h('details', { class: 'profile-list' }, h('summary', null, t('web.profile.builtInList')));
  for (const v of PROFILES) {
    list.append(
      h(
        'div',
        { class: 'profile-vendor' },
        h('strong', null, v.label),
        ` ${v.hosts.join(', ')}`,
        v.priceNote ? h('div', { class: 'hint' }, noteText(v)) : null,
      ),
    );
    for (const m of v.models)
      list.append(
        h(
          'div',
          { class: 'profile-model' },
          h('span', null, m.label),
          h('code', null, m.match),
          h('span', null, tokens(m.contextWindow)),
          h('span', null, prices(m, v.currency)),
        ),
      );
  }
  return list;
}

function profileInputs(
  values: ProfileDraft,
  onValue: (key: ProfileKey, v: string | number | undefined | null, raw: string | number | null) => void,
): HTMLInputElement[] {
  return PROFILE_COLUMNS.map((col) => {
    const label = t(col.label);
    const attrs = {
      'aria-label': label,
      title: label,
      placeholder: col.hint ? t(col.hint) : (col.example ?? ''),
    };
    const check = (raw: string | number | null) => {
      const v = profileValue(col.key, raw);
      input.classList.toggle('invalid', v === null);
      onValue(col.key, v, raw);
    };
    const value = values[col.key];
    const input = col.num
      ? numberInput(typeof value === 'number' ? value : '', check, {
          ...attrs,
          min: 0,
          step: col.key === 'contextWindow' ? 1 : 'any',
        })
      : textInput(typeof value === 'string' ? value : '', check, {
          ...attrs,
          maxLength: col.key === 'currency' ? 3 : col.key === 'match' ? PROFILE_MATCH_MAX : PROFILE_LABEL_MAX,
        });
    return input;
  });
}

export function profilesFields(c: Config, apply: ProfileApply, draft: ProfileDraft): HTMLElement[] {
  const rows = (c.profiles?.models ?? []).map((entry, i) =>
    h(
      'div',
      { class: 'profile-row' },
      ...profileInputs(entry, (key, v) => {
        if (v !== null) apply((x) => updateProfileOverride(x, i, { [key]: v }), `profiles.${i}.${key}`);
      }),
      h(
        'button',
        {
          class: 'icon-btn danger',
          type: 'button',
          title: t('pinsp.remove'),
          'aria-label': t('web.profile.remove', { match: entry.match }),
          onClick: () => apply((x) => removeProfileOverride(x, i)),
        },
        icon('trash'),
      ),
    ),
  );
  const add = () => {
    const entry = draftOverride(draft);
    if (!entry) return;
    for (const k of Object.keys(draft)) delete draft[k as ProfileKey];
    apply((x) => addProfileOverride(x, entry));
  };
  return [
    field(
      t('web.profile.builtIn'),
      toggle(c.profiles?.builtIn !== false, (v) => apply((x) => setProfilesBuiltIn(x, v))),
      t('web.profile.builtInHelp'),
      true,
    ),
    builtInList(),
    h('div', { class: 'hint' }, t('web.profile.updated', { date: PROFILES_UPDATED })),
    field(
      t('web.profile.yours'),
      h(
        'div',
        { class: 'profile-rows' },
        ...rows,
        h(
          'div',
          { class: 'profile-row draft' },
          ...profileInputs(draft, (key, _, raw) => {
            if (raw === null || raw === '') delete draft[key];
            else draft[key] = raw;
          }),
          h(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              title: t('web.profile.add'),
              'aria-label': t('web.profile.addModel'),
              onClick: add,
            },
            icon('plus'),
          ),
        ),
      ),
      t('web.profile.yoursHelp'),
    ),
  ];
}

export interface RotationTheme {
  id: string;
  name: string;
}

function rotationSelect(
  label: string,
  options: [value: string, text: string][],
  value: string,
  onPick: (v: string) => void,
): HTMLSelectElement {
  const sel = h(
    'select',
    { class: 'input', 'aria-label': label, onChange: () => onPick(sel.value) },
    ...options.map(([v, text]) => h('option', { value: v }, text)),
  );
  sel.value = value;
  return sel;
}

export function rotationFields(c: Config, themes: RotationTheme[], apply: ProfileApply): HTMLElement[] {
  const rot = c.themeRotation;
  const pool = rot?.themes ?? [];
  const known = (id: string) => themes.some((x) => x.id === id);
  const nameOf = (id: string) => themes.find((x) => x.id === id)?.name ?? id;
  const rows = pool.map((id, i) => {
    const name = nameOf(id);
    return h(
      'div',
      { class: 'profile-row rotation-row' },
      h('span', { class: 'rotation-name' }, name),
      known(id) ? null : h('span', { class: 'theme-tag missing' }, t('web.rotation.missing')),
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          disabled: i === 0,
          title: t('web.rotation.up'),
          'aria-label': t('web.rotation.upName', { name }),
          onClick: () => apply((x) => rotationMoveTheme(x, id, -1)),
        },
        '↑',
      ),
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          disabled: i === pool.length - 1,
          title: t('web.rotation.down'),
          'aria-label': t('web.rotation.downName', { name }),
          onClick: () => apply((x) => rotationMoveTheme(x, id, 1)),
        },
        '↓',
      ),
      h(
        'button',
        {
          class: 'icon-btn danger',
          type: 'button',
          title: t('pinsp.remove'),
          'aria-label': t('web.rotation.remove', { name }),
          onClick: () => apply((x) => rotationRemoveTheme(x, id)),
        },
        icon('trash'),
      ),
    );
  });
  const free = themes.filter((x) => !pool.includes(x.id));
  const add = rotationSelect(
    t('web.rotation.add'),
    [['', t('web.rotation.add')], ...free.map((x): [string, string] => [x.id, x.name])],
    '',
    (v) => {
      if (v) apply((x) => rotationAddTheme(x, v));
    },
  );
  const out: HTMLElement[] = [
    field(
      t('web.rotation.pool'),
      h('div', { class: 'profile-rows' }, ...rows, free.length ? add : null),
      t('web.rotation.poolHelp'),
    ),
  ];
  if (pool.length) {
    const every = rot?.every ?? 'day';
    const kind = typeof every === 'number' ? 'custom' : every;
    const period = rotationSelect(
      t('web.rotation.every'),
      [
        ['hour', t('web.rotation.hourly')],
        ['day', t('web.rotation.daily')],
        ['week', t('web.rotation.weekly')],
        ['custom', t('web.rotation.custom')],
      ],
      kind,
      (v) => {
        const next =
          v === 'custom' ? (typeof every === 'number' ? every : 30) : (v as 'hour' | 'day' | 'week');
        apply((x) => setRotationEvery(x, next));
      },
    );
    const minutes =
      typeof every === 'number'
        ? numberInput(
            every,
            (v) => {
              if (v !== null && Number.isInteger(v) && v >= 1 && v <= ROTATION_MINUTES_MAX)
                apply((x) => setRotationEvery(x, v), 'themeRotation.every');
            },
            { min: 1, max: ROTATION_MINUTES_MAX, step: 1, 'aria-label': t('web.rotation.minutes') },
          )
        : null;
    out.push(
      field(t('web.rotation.every'), h('div', { class: 'row-inline' }, period, minutes)),
      field(
        t('web.rotation.order'),
        rotationSelect(
          t('web.rotation.order'),
          [
            ['cycle', t('web.rotation.cycle')],
            ['shuffle', t('web.rotation.shuffle')],
          ],
          rot?.order ?? 'cycle',
          (v) => apply((x) => setRotationOrder(x, v === 'shuffle' ? 'shuffle' : undefined)),
        ),
      ),
    );
  }
  const dayOptions: [string, string][] = [
    ['', t('web.rotation.dayPool')],
    ...themes.map((x): [string, string] => [x.id, x.name]),
  ];
  const days = ROTATION_DAYS.map((d: RotationDay) => {
    const id = rot?.weekdays?.[d] ?? '';
    const opts = id && !known(id) ? [...dayOptions, [id, id] as [string, string]] : dayOptions;
    return h(
      'label',
      { class: 'rotation-day' },
      h('span', null, t(`web.rotation.day.${d}`)),
      rotationSelect(t(`web.rotation.day.${d}`), opts, id, (v) =>
        apply((x) => setRotationWeekday(x, d, v || undefined)),
      ),
    );
  });
  out.push(
    field(
      t('web.rotation.weekdays'),
      h('div', { class: 'rotation-days' }, ...days),
      t('web.rotation.weekdaysHelp'),
    ),
  );
  if (rot) {
    const now = new Date();
    const id = pickRotationTheme(rot, now, known) ?? c.theme;
    out.push(
      h(
        'div',
        { class: 'hint rotation-status' },
        t('web.rotation.status', {
          name: nameOf(id),
          next: formatDateTime(nextRotationChange(rot, now), languageLocale()),
        }),
      ),
      h(
        'div',
        { class: 'row-inline' },
        h(
          'button',
          { class: 'btn', type: 'button', onClick: () => apply((x) => setThemeRotation(x, undefined)) },
          t('web.rotation.off'),
        ),
      ),
    );
  }
  return out;
}

// option texts are native names
function languageField(c: Config, rerender: () => void): HTMLElement {
  const auto = pickUiLanguage(undefined, S.api.language?.id, browserLanguages());
  const sel = h(
    'select',
    {
      class: 'input',
      onChange: () => {
        commit(setLanguageSetting(S.config, sel.value as LanguageSetting));
        rerender();
      },
    },
    h('option', { value: 'auto' }, t('web.settings.languageAuto', { name: nativeName(auto) })),
    ...LANGUAGES.map((l) => h('option', { value: l.id, lang: l.id }, l.name)),
  );
  sel.value = c.language ?? 'auto';
  return field(t('web.settings.language'), sel, t('web.settings.languageHelp'));
}

// browser preference, not config: nothing to save
export function tipsField(): HTMLElement {
  return field(
    t('web.settings.showTips'),
    toggle(!tipsHidden(), (v) => setTipsHidden(!v)),
    t('web.settings.showTipsHelp'),
    true,
  );
}

function appearanceFields(c: Config, rerender: () => void): HTMLElement[] {
  return [
    languageField(c, rerender),
    tipsField(),
    field(
      t('web.settings.loadingText'),
      textInput(
        c.loadingText ?? t('loading.default'),
        (v) => {
          const { loadingText: _, ...rest } = S.config;
          const text = v.slice(0, 40);
          commit(text === t('loading.default') ? rest : { ...rest, loadingText: text }, {
            coalesce: 'loadingText',
          });
        },
        { maxLength: 40 },
      ),
      t('web.settings.loadingTextHelp'),
    ),
  ];
}

export async function openSettings(): Promise<void> {
  const body = h('div', { class: 'settings' });
  let info: Awaited<ReturnType<typeof api.system>> | null = null;
  let latest: { latest: string; newer: boolean } | null = null;
  let busy = false;
  const draft: ProfileDraft = {};

  const section = (title: string, ...children: (Node | null)[]) =>
    h('section', { class: 'section' }, h('h4', null, title), ...children);

  async function run(install: boolean) {
    busy = true;
    render();
    try {
      const r = await api.update(install);
      latest = { latest: r.latest, newer: r.newer && !r.installed };
      if (r.installed) toast(t('web.settings.updatedTo', { version: r.installed }));
      else
        toast(
          r.newer
            ? t('web.settings.available', { version: r.latest })
            : t('web.settings.latestVersion', { version: r.current }),
          'info',
        );
      info = await api.system();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    busy = false;
    render();
  }

  async function runHooks(enabled: boolean, permission: boolean) {
    busy = true;
    render();
    try {
      const r = await api.hooks(enabled, permission);
      const on = r.hooks.installed;
      toast(
        enabled
          ? on.length
            ? t('web.settings.hooksOn', { events: on.join(', ') })
            : t('web.settings.hooksNone')
          : t('web.settings.hooksRemoved'),
      );
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    info = await api.system().catch(() => info);
    busy = false;
    render();
  }

  function hooksFields(): HTMLElement[] {
    const hk = info?.hooks ?? S.api.hooks;
    if (!hk) return [];
    const permission = hk.optional.some((e) => hk.installed.includes(e));
    const hint = `${t('web.settings.hooksHint', { events: hk.events.join(', ') })} ${
      hk.available ? t('web.settings.hooksVersion', { version: hk.claudeCode ?? '' }) : reasonText(hk)
    }`;
    const out = [
      field(
        t('web.settings.hooks'),
        toggle(hk.installed.length > 0, (v) => void runHooks(v, permission), undefined, {
          disabled: busy || (!hk.available && hk.installed.length === 0),
        }),
        hint,
        true,
      ),
    ];
    if (hk.available)
      out.push(
        field(
          t('web.settings.permission'),
          toggle(permission, (v) => void runHooks(true, v), undefined, { disabled: busy }),
          t('web.settings.permissionHint', { events: hk.optional.join(', ') }),
          true,
        ),
      );
    return out;
  }

  async function runProgress(enabled: boolean, channel?: ProgressConfig['channel']) {
    busy = true;
    render();
    try {
      const r = await api.progress(enabled, channel);
      applySaved((c) => setProgress(c, channel ? { enabled, channel } : { enabled }));
      toast(t(channel ? 'prog.channelSaved' : enabled ? 'prog.on' : r.held ? 'prog.offHeld' : 'prog.off'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    info = await api.system().catch(() => info);
    busy = false;
    render();
  }

  function progressFields(): HTMLElement[] {
    const hk = info?.hooks ?? S.api.hooks;
    const p = S.config.progress ?? {};
    const on = p.enabled === true;
    const installed = (hk?.progress?.length ?? 0) > 0;
    const channel = p.channel ?? PROGRESS_DEFAULTS.channel;
    const setP = (patch: Partial<ProgressConfig>, coalesce?: string) => {
      commit(setProgress(S.config, patch), coalesce ? { coalesce } : {});
      if (!coalesce) render();
    };
    const pick = <K extends keyof typeof PROGRESS_CHOICES>(key: K) =>
      segmented(
        PROGRESS_CHOICES[key].map((v) => ({ value: v, label: t(`prog.${key}.${v}` as MessageId) })),
        p[key] ?? PROGRESS_DEFAULTS[key],
        // the channel decides the handlers, so it saves with them (WR-02)
        (v) =>
          key === 'channel' && on
            ? void runProgress(true, v as ProgressConfig['channel'])
            : setP({ [key]: v }),
      );
    const level = (key: 'warnAt' | 'errorAt') =>
      numberInput(p[key] ?? '', (v) => setP({ [key]: v ?? undefined }, `progress.${key}`), {
        min: 1,
        max: 100,
        step: 1,
        placeholder: String(PROGRESS_DEFAULTS[key]),
      });
    const out: HTMLElement[] = [
      field(
        t('prog.toggle'),
        toggle(on, (v) => void runProgress(v), undefined, {
          disabled: busy || !hk || (!hk.available && !installed && !on),
        }),
        hk && !hk.available ? reasonText(hk) : t('prog.saved'),
        true,
      ),
      h('div', { class: 'hint' }, t('prog.hintBar')),
    ];
    if (!on && installed)
      out.push(
        h('div', { class: 'hint warn' }, t('prog.leftover')),
        h(
          'div',
          { class: 'row-inline' },
          h(
            'button',
            { class: 'btn', type: 'button', disabled: busy, onClick: () => void runProgress(false) },
            t('prog.removeHandlers'),
          ),
        ),
      );
    if (channel !== 'tty') out.push(h('div', { class: 'hint' }, t('prog.hintLatency')));
    out.push(
      field(t('prog.source'), pick('source'), t('prog.sourceHelp')),
      field(t('prog.scaleTo'), pick('scaleTo'), t('prog.scaleHelp')),
      field(t('prog.warnAt'), level('warnAt')),
      field(t('prog.errorAt'), level('errorAt'), t('prog.levelHelp')),
      field(t('prog.channel'), pick('channel'), t('prog.channelHelp')),
      field(t('prog.terminals'), pick('terminals'), t('prog.terminalsHelp')),
    );
    if (channel === 'tty')
      out.push(
        field(
          t('prog.tmux'),
          toggle(p.tmuxPassthrough === true, (v) => setP({ tmuxPassthrough: v })),
          t('prog.tmuxHelp'),
          true,
        ),
      );
    return out;
  }

  async function openInstall(dialog: Promise<void>) {
    await dialog;
    info = await api.system().catch(() => info);
    render();
  }

  function refreshWarning(cl: typeof S.api.claude): (HTMLElement | null)[] {
    if (cl.statusLine?.refreshInterval) return [];
    const c = S.config;
    const why = refreshReasons(
      c,
      (type) => S.widgetMap.get(type)?.timeBased === true,
      [timeRuleFeed],
      c.tui ? titleWidgets(c.tui) : [],
    );
    if (!why.widgets.length && !why.rules.length) return [];
    return [
      why.widgets.length
        ? h('div', { class: 'hint warn' }, t('editor.refreshHint', { widgets: why.widgets.join(', ') }))
        : null,
      why.rules.length
        ? h(
            'div',
            { class: 'hint warn' },
            t('vis.refreshHint', { items: why.rules.join(', '), n: REFRESH_SUGGEST }),
          )
        : null,
      h(
        'div',
        { class: 'row-inline' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: () => openInstall(installDialog({ refresh: REFRESH_SUGGEST })),
          },
          t('editor.refreshUse', { n: REFRESH_SUGGEST }),
        ),
      ),
    ];
  }

  function render() {
    clear(body);
    const c = S.config;
    const cl = info?.claude ?? S.api.claude;
    const set = (p: Partial<typeof c>) => {
      commit({ ...S.config, ...p });
      render();
    };
    const canUpdate = canSelfUpdate(info?.kind);
    const hint = brewHint(info?.kind, c.update);
    const checked = info?.update?.checkedAt
      ? t('web.settings.lastChecked', {
          when: formatDateTime(new Date(info.update.checkedAt), languageLocale()),
        })
      : t('web.settings.notChecked');
    const command = cl.statusLine?.command ?? '';
    const every = cl.statusLine?.refreshInterval;
    body.append(
      section(
        'Claude Code',
        h(
          'div',
          { class: `status-line ${cl.installed ? 'ok' : 'off'}` },
          h('i', { class: 'status-dot' }),
          h('span', null, cl.installed ? t('web.settings.cliUses') : t('web.settings.cliNotYet')),
        ),
        h(
          'div',
          { class: 'hint' },
          !cl.installed
            ? t('web.settings.cliInstallOnce')
            : every
              ? t('web.settings.cliCommandRefresh', { command, n: every })
              : t('web.settings.cliCommand', { command }),
        ),
        h(
          'div',
          { class: 'row-inline' },
          h(
            'button',
            {
              class: `btn${cl.installed ? '' : ' primary'}`,
              type: 'button',
              onClick: () => openInstall(installDialog()),
            },
            cl.installed ? t('web.settings.cliChange') : t('web.install.title'),
          ),
        ),
        ...refreshWarning(cl),
        ...hooksFields(),
      ),
      section(t('prog.section'), ...progressFields()),
      section(
        t('web.settings.updates'),
        field(
          t('web.settings.updateWhen'),
          segmented(
            [
              {
                value: 'auto',
                label: t('web.settings.updateAuto'),
                title: t(
                  info?.kind === 'brew' ? 'web.settings.updateAutoHelpBrew' : 'web.settings.updateAutoHelp',
                ),
              },
              {
                value: 'notify',
                label: t('web.settings.updateNotify'),
                title: t('web.settings.updateNotifyHelp'),
              },
              { value: 'off', label: t('web.settings.updateOff'), title: t('web.settings.updateOffHelp') },
            ] as const,
            c.update,
            (v) => set({ update: v }),
          ),
          t('web.settings.updateHelp'),
        ),
        h(
          'div',
          { class: 'hint' },
          t('web.settings.version', {
            version: info?.version ?? S.api.version,
            kind: kindLabel(info?.kind),
            checked,
          }),
          latest ? t('web.settings.latest', { version: latest.latest }) : '',
        ),
        hint ? h('div', { class: 'hint' }, hint) : null,
        h(
          'div',
          { class: 'row-inline' },
          h(
            'button',
            { class: 'btn', type: 'button', disabled: busy, onClick: () => void run(false) },
            t('web.settings.checkNow'),
          ),
          latest?.newer && canUpdate
            ? h(
                'button',
                { class: 'btn primary', type: 'button', disabled: busy, onClick: () => void run(true) },
                t('web.settings.updateTo', { version: latest.latest }),
              )
            : null,
        ),
      ),
      section(t('insp.appearance'), ...appearanceFields(c, render)),
      section(
        t('web.rotation.section'),
        ...rotationFields(c, S.api.themes, (fn, coalesce) => {
          commit(fn(S.config), coalesce ? { coalesce } : {});
          if (!coalesce) render();
        }),
      ),
      section(
        t('web.settings.data'),
        field(
          t('web.settings.usageApi'),
          toggle(c.usageApi, (v) => set({ usageApi: v })),
          t('web.settings.usageApiHelp'),
          true,
        ),
        field(
          t('web.settings.gitHardening'),
          toggle(c.gitHardening !== false, (v) => set({ gitHardening: v ? undefined : false })),
          t('web.settings.gitHardeningHelp'),
          true,
        ),
        field(
          t('web.settings.commandBudgetMs'),
          numberInput(c.commandBudgetMs ?? '', (v) => set({ commandBudgetMs: budgetValue(v) }), {
            min: 100,
            max: 60000,
            step: 100,
            placeholder: '3000',
          }),
          t('web.settings.commandBudgetMsHelp'),
          true,
        ),
        field(
          t('web.settings.updateMinAgeHours'),
          numberInput(c.updateMinAgeHours ?? '', (v) => set({ updateMinAgeHours: ageValue(v) }), {
            min: 1,
            max: 720,
            step: 1,
            placeholder: '0',
          }),
          t('web.settings.updateMinAgeHoursHelp'),
          true,
        ),
        field(
          t('web.settings.savePayload'),
          toggle(c.savePayload, (v) => set({ savePayload: v })),
          t('web.settings.savePayloadHelp'),
          true,
        ),
      ),
      section(
        t('web.settings.budget'),
        field(
          t('web.settings.daily'),
          budgetInput('daily', c.budget?.daily, { min: 0, step: 'any', placeholder: t('insp.none') }),
          t('web.settings.dailyHelp'),
        ),
        field(
          t('web.settings.session'),
          budgetInput('session', c.budget?.session, { min: 0, step: 'any', placeholder: t('insp.none') }),
        ),
        field(
          t('web.settings.warnAt'),
          budgetInput(
            'warnAt',
            c.budget?.warnAt === undefined ? undefined : Math.round(c.budget.warnAt * 100),
            { min: 5, max: 100, step: 1, placeholder: '80' },
            100,
          ),
          t('web.settings.warnAtHelp'),
        ),
      ),
      section(
        t('web.settings.profiles'),
        ...profilesFields(
          c,
          (fn, coalesce) => {
            commit(fn(S.config), coalesce ? { coalesce } : {});
            if (!coalesce) render();
          },
          draft,
        ),
      ),
    );
  }

  render();
  void api
    .system()
    .then((r) => {
      info = r;
      render();
    })
    .catch(() => {});
  await modal({
    title: t('web.settings.title'),
    titleId: 'web.settings.title',
    body: [body],
    actions: (close) => [
      h(
        'button',
        { class: 'btn primary', type: 'button', 'data-i18n': 'web.settings.done', onClick: () => close() },
        t('web.settings.done'),
      ),
    ],
  });
}
