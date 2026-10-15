import {
  addProfileOverride,
  PROGRESS_CHOICES,
  PROGRESS_DEFAULTS,
  REFRESH_SUGGEST,
  refreshReasons,
  removeProfileOverride,
  setBudget,
  setProfilesBuiltIn,
  setProgress,
  timeRuleFeed,
  updateProfileOverride,
} from '../../core/edit.js';
import { type MessageId, t } from '../../core/i18n/index.js';
import { titleWidgets } from '../../core/panel.js';
import { PROFILE_LABEL_MAX, PROFILE_MATCH_MAX, PROFILES, PROFILES_UPDATED } from '../../core/profiles.js';
import type { Config, ProfileOverride, ProgressConfig } from '../../core/types.js';
import { api } from './api.js';
import { clear, h, icon } from './dom.js';
import { field, numberInput, segmented, textInput, toggle } from './inspector.js';
import { installDialog } from './install-dialog.js';
import { applySaved, commit, S } from './store.js';
import { modal, toast } from './ui.js';

const KIND: Record<string, string> = {
  'npm-global': 'global npm install',
  local: 'pinned copy in your config folder',
  npx: 'running through npx',
  source: 'source checkout',
  unknown: 'unknown install',
};

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

const PROFILE_COLUMNS: { key: ProfileKey; label: string; placeholder: string; num?: boolean }[] = [
  { key: 'match', label: 'Model match', placeholder: 'glm-*' },
  { key: 'label', label: 'Label', placeholder: 'GLM' },
  { key: 'contextWindow', label: 'Context window', placeholder: 'window', num: true },
  { key: 'input', label: 'Input price', placeholder: 'input', num: true },
  { key: 'output', label: 'Output price', placeholder: 'output', num: true },
  { key: 'cacheRead', label: 'Cache read price', placeholder: 'cache read', num: true },
  { key: 'cacheWrite', label: 'Cache write price', placeholder: 'cache write', num: true },
  { key: 'currency', label: 'Currency', placeholder: 'USD' },
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
  const parts = [`in ${p.input}`, `out ${p.output}`];
  if (typeof p.cacheRead === 'number') parts.push(`cache read ${p.cacheRead}`);
  if (typeof p.cacheWrite === 'number') parts.push(`cache write ${p.cacheWrite}`);
  return `${parts.join(', ')}${currency ? ` ${currency}` : ''}`;
}

function builtInList(): HTMLElement {
  const list = h('details', { class: 'profile-list' }, h('summary', null, 'Built-in models'));
  for (const v of PROFILES) {
    list.append(
      h(
        'div',
        { class: 'profile-vendor' },
        h('strong', null, v.label),
        ` ${v.hosts.join(', ')}`,
        v.priceNote ? h('div', { class: 'hint' }, v.priceNote) : null,
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
    const attrs = { 'aria-label': col.label, title: col.label, placeholder: col.placeholder };
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
          title: 'Remove',
          'aria-label': `Remove ${entry.match}`,
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
      'Built-in model profiles',
      toggle(c.profiles?.builtIn !== false, (v) => apply((x) => setProfilesBuiltIn(x, v))),
      "Names, context windows and prices for third-party models. Built-in prices are list prices and apply only on the vendor's own API host.",
      true,
    ),
    builtInList(),
    h('div', { class: 'hint' }, `Updated ${PROFILES_UPDATED}`),
    field(
      'Your models',
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
            { class: 'icon-btn', type: 'button', title: 'Add', 'aria-label': 'Add model', onClick: add },
            icon('plus'),
          ),
        ),
      ),
      'Match is a model id with * wildcards. Yours win over the built-ins; prices are per 1M tokens and need both input and output.',
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
      if (r.installed) toast(`Updated to ${r.installed}. Restart the editor to use it.`);
      else toast(r.newer ? `Version ${r.latest} is available` : `${r.current} is the latest version`, 'info');
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
      toast(enabled ? (on.length ? `Hooks on: ${on.join(', ')}` : 'No hooks were added') : 'Hooks removed');
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
    const hint = `Optional. Records ${hk.events.join(', ')} so live widgets are exact; every widget also works without hooks. ${
      hk.available ? `Claude Code ${hk.claudeCode ?? ''}.` : (hk.reason ?? '')
    }`;
    const out = [
      field(
        'Hooks',
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
          'Permission requests',
          toggle(permission, (v) => void runHooks(true, v), undefined, { disabled: busy }),
          `Opt-in. Also records ${hk.optional.join(', ')} so a waiting permission prompt shows at once. Best left off on Windows without Git Bash.`,
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
        hk && !hk.available ? hk.reason : t('prog.saved'),
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
    const canUpdate = info?.kind === 'npm-global' || info?.kind === 'local';
    const checked = info?.update?.checkedAt
      ? `last checked ${new Date(info.update.checkedAt).toLocaleString()}`
      : 'not checked yet';
    body.append(
      section(
        'Claude Code',
        h(
          'div',
          { class: `status-line ${cl.installed ? 'ok' : 'off'}` },
          h('i', { class: 'status-dot' }),
          h(
            'span',
            null,
            cl.installed ? 'Claude Code uses ccinfobar.' : 'Claude Code does not use ccinfobar yet.',
          ),
        ),
        h(
          'div',
          { class: 'hint' },
          cl.installed
            ? `Command: ${cl.statusLine?.command ?? ''}${cl.statusLine?.refreshInterval ? `, refresh every ${cl.statusLine.refreshInterval}s` : ''}. Saving is enough; Claude Code picks up changes on its next refresh.`
            : 'Install once; after that, saving is enough.',
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
            cl.installed ? 'Change command or refresh' : 'Install in Claude Code',
          ),
        ),
        ...refreshWarning(cl),
        ...hooksFields(),
      ),
      section(t('prog.section'), ...progressFields()),
      section(
        'Updates',
        field(
          'When a new version is out',
          segmented(
            [
              {
                value: 'auto',
                label: 'Install automatically',
                title: 'Default. Checks each time Claude Code starts and installs in the background',
              },
              { value: 'notify', label: 'Tell me', title: 'Shows a note at the end of the status line' },
              { value: 'off', label: 'Off', title: 'Never checks' },
            ] as const,
            c.update,
            (v) => set({ update: v }),
          ),
          'Automatic is the default. Save to apply.',
        ),
        h(
          'div',
          { class: 'hint' },
          `This is ccinfobar ${info?.version ?? S.api.version}, ${KIND[info?.kind ?? 'unknown'] ?? info?.kind}; ${checked}.`,
          latest ? ` Latest: ${latest.latest}.` : '',
        ),
        h(
          'div',
          { class: 'row-inline' },
          h(
            'button',
            { class: 'btn', type: 'button', disabled: busy, onClick: () => void run(false) },
            'Check now',
          ),
          latest?.newer && canUpdate
            ? h(
                'button',
                { class: 'btn primary', type: 'button', disabled: busy, onClick: () => void run(true) },
                `Update to ${latest.latest}`,
              )
            : null,
        ),
      ),
      section(
        'Appearance',
        field(
          'Loading text',
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
          'Shown by context, token and limit widgets before the first reply. Leave empty to turn it off.',
        ),
      ),
      section(
        'Data',
        field(
          'Usage from Claude',
          toggle(c.usageApi, (v) => set({ usageApi: v })),
          'Fill usage limit widgets from your Claude login when Claude Code sends none.',
          true,
        ),
        field(
          'Git hardening',
          toggle(c.gitHardening !== false, (v) => set({ gitHardening: v ? undefined : false })),
          'Stop repos from running their own git hooks and filters through the status line.',
          true,
        ),
        field(
          'Save last payload',
          toggle(c.savePayload, (v) => set({ savePayload: v })),
          'Lets the preview use your real last session.',
          true,
        ),
      ),
      section(
        'Budget',
        field(
          'Daily budget (USD)',
          budgetInput('daily', c.budget?.daily, { min: 0, step: 'any', placeholder: 'none' }),
          'Estimated spend for the budget widget. Not your bill.',
        ),
        field(
          'Per session (USD)',
          budgetInput('session', c.budget?.session, { min: 0, step: 'any', placeholder: 'none' }),
        ),
        field(
          'Warn at (%)',
          budgetInput(
            'warnAt',
            c.budget?.warnAt === undefined ? undefined : Math.round(c.budget.warnAt * 100),
            { min: 5, max: 100, step: 1, placeholder: '80' },
            100,
          ),
          'The budget widget turns yellow here and red at 100%.',
        ),
      ),
      section(
        'Model profiles',
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
    title: 'Settings',
    body: [body],
    actions: (close) => [
      h('button', { class: 'btn primary', type: 'button', onClick: () => close() }, 'Done'),
    ],
  });
}
