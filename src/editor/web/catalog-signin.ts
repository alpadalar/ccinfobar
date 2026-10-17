import '../../core/i18n/lazy.js';
import { type MessageId, t } from '../../core/i18n/index.js';
import { api, idText, type LoginStartInfo, type LoginStatusInfo } from './api.js';
import { h, icon } from './dom.js';
import { modal, toast } from './ui.js';

// fixed: never the server's value
export const VERIFY_URL = 'https://github.com/login/device';
const MAX_ERRORS = 3;

export interface SignedIn {
  handle: string;
  admin: boolean;
}

const ENDED: Record<string, MessageId> = {
  expired: 'catalog.signin.expired',
  denied: 'err.catalog.signIn.denied',
  disabled: 'err.catalog.signIn.disabled',
  failed: 'err.catalog.signIn.failed',
  cancelled: 'err.catalog.signIn.cancelled',
};

const seconds = (v: unknown, fallback: number, min: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.ceil(v) : fallback;

// polls only the editor server, one timer at a time (R-11)
export async function signInDialog(): Promise<SignedIn | null> {
  let flow = null as { id: string; interval: number; max: number } | null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let polls = 0;
  let errors = 0;
  let close: (v?: unknown) => void = () => {};

  const code = h('code', { class: 'signin-code', 'aria-label': t('catalog.signin.code') });
  const copy = h(
    'button',
    {
      class: 'btn sm',
      type: 'button',
      onClick: () => {
        const text = code.textContent ?? '';
        if (!text) return;
        try {
          void globalThis.navigator?.clipboard?.writeText(text).then(
            () => toast(t('catalog.signin.copied'), 'info'),
            () => {},
          );
        } catch {}
      },
    },
    icon('copy', 14),
    t('catalog.signin.copy'),
  );
  const link = h(
    'a',
    { class: 'btn primary', href: VERIFY_URL, target: '_blank', rel: 'noopener noreferrer' },
    t('catalog.signin.open'),
  );
  const box = h('div', { class: 'signin-code-box' }, code, copy);
  box.hidden = true;
  const status = h('p', { class: 'hint signin-status', role: 'status' });
  const retry = h(
    'button',
    { class: 'btn', type: 'button', onClick: () => void begin() },
    t('catalog.signin.retry'),
  );
  retry.hidden = true;

  function say(text: string, error = false) {
    status.className = error ? 'form-error signin-status' : 'hint signin-status';
    status.setAttribute('role', error ? 'alert' : 'status');
    status.textContent = text;
  }

  function stop() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  // the flow is over on the server or given up here
  function end(text: string, cancel: boolean) {
    stop();
    const id = flow?.id;
    flow = null;
    if (cancel && id) void api.loginCancel(id).catch(() => {});
    box.hidden = true;
    retry.hidden = false;
    say(text, true);
  }

  function schedule(ms: number) {
    stop();
    timer = setTimeout(() => void poll(), ms);
  }

  async function begin() {
    stop();
    flow = null;
    retry.hidden = true;
    box.hidden = true;
    code.textContent = '';
    say(t('catalog.signin.starting'));
    let started: LoginStartInfo;
    try {
      started = await api.loginStart();
    } catch (e) {
      if (!closed) end((e as Error).message, false);
      return;
    }
    if (closed) {
      void api.loginCancel(started.flow).catch(() => {});
      return;
    }
    const interval = seconds(started.interval, 5, 1);
    const expiresIn = seconds(started.expiresIn, 900, 1);
    flow = { id: started.flow, interval, max: Math.ceil(expiresIn / interval) + 3 };
    polls = 0;
    errors = 0;
    code.textContent = typeof started.userCode === 'string' ? started.userCode : '';
    box.hidden = false;
    say(t('catalog.signin.waiting'));
    schedule(interval * 1000);
  }

  async function poll() {
    timer = null;
    const current = flow;
    if (closed || !current) return;
    if (++polls > current.max) {
      end(t('catalog.signin.expired'), true);
      return;
    }
    let s: LoginStatusInfo;
    try {
      s = await api.loginStatus(current.id);
    } catch {
      if (closed || flow !== current) return;
      if (++errors >= MAX_ERRORS) end(t('err.catalog.signIn.failed'), true);
      else {
        say(t('catalog.signin.retrying'));
        schedule(current.interval * 1000 * 2 ** errors);
      }
      return;
    }
    if (closed || flow !== current) return;
    errors = 0;
    if (s.status === 'pending') {
      say(t('catalog.signin.waiting'));
      schedule(current.interval * 1000);
      return;
    }
    if (s.status === 'ok' && typeof s.handle === 'string') {
      flow = null;
      const done = { handle: s.handle, admin: s.admin === true };
      toast(t('catalog.login.done', { handle: done.handle }));
      close(done);
      return;
    }
    const fallback = t(ENDED[s.status] ?? 'err.catalog.signIn.failed');
    end(s.status === 'failed' ? idText(s.errorId, s.errorParams ?? null, fallback) : fallback, false);
  }

  const shown = modal<SignedIn>({
    title: t('catalog.signin.title'),
    body: [
      h('p', { class: 'modal-text' }, t('catalog.signin.steps')),
      box,
      h('p', { class: 'signin-link' }, link),
      status,
    ],
    actions: (done) => {
      close = done;
      return [
        h('span', { class: 'spacer' }),
        retry,
        h('button', { class: 'btn', type: 'button', onClick: () => done() }, t('web.ui.cancel')),
      ];
    },
  });
  void begin();
  const result = (await shown) ?? null;
  // Cancel, Escape and the overlay end the flow
  closed = true;
  stop();
  if (flow) void api.loginCancel(flow.id).catch(() => {});
  flow = null;
  return result;
}
