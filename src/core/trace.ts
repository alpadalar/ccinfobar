import type { DataSources, RenderContext, StatusPayload } from './types.js';

export type SourceKind =
  | 'payload'
  | 'usage-cache'
  | 'limits-cache'
  | 'transcript'
  | 'agents'
  | 'git'
  | 'gsd'
  | 'jj'
  | 'history'
  | 'ledger'
  | 'repos'
  | 'hooks'
  | 'environment'
  | 'sandbox'
  | 'job'
  | 'env'
  | 'config'
  | 'clock'
  | 'system';

export interface JobSource {
  key: string;
  ok: boolean;
  error?: string;
  blockedUntil?: number;
}

export interface TraceRead {
  kind: SourceKind;
  path?: string;
  absent?: boolean;
  age?: number;
  job?: JobSource;
}

export interface Trace {
  begin(): void;
  end(): TraceRead[];
  wrap(ctx: RenderContext): RenderContext;
  forWidget(ctx: RenderContext): RenderContext;
}

const INDEX = /^\d+$/;

function cwdRead(p: StatusPayload): TraceRead {
  if (p.workspace?.current_dir) return { kind: 'payload', path: 'workspace.current_dir' };
  if (p.cwd) return { kind: 'payload', path: 'cwd' };
  return { kind: 'system' };
}

export function createTrace(): Trace {
  let cur: TraceRead[] | null = null;
  const cache = new WeakMap<object, Map<string, object>>();
  const rec = (r: TraceRead) => {
    cur?.push(r);
  };
  const peek = <T>(fn: () => T): T => {
    const c = cur;
    cur = null;
    try {
      return fn();
    } finally {
      cur = c;
    }
  };

  function deep<T extends object>(obj: T, base: string): T {
    let m = cache.get(obj);
    if (!m) {
      m = new Map();
      cache.set(obj, m);
    }
    const hit = m.get(base);
    if (hit) return hit as T;
    const arr = Array.isArray(obj);
    const p = new Proxy(obj, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (typeof k === 'symbol' || typeof v === 'function') return v;
        if (arr && k === 'length') return v;
        const seg = arr && INDEX.test(k) ? '[]' : k;
        const path = !base ? seg : seg === '[]' ? `${base}[]` : `${base}.${seg}`;
        rec(v === undefined ? { kind: 'payload', path, absent: true } : { kind: 'payload', path });
        return v && typeof v === 'object' ? deep(v as object, path) : v;
      },
    });
    m.set(base, p);
    return p;
  }

  function envProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return new Proxy(env, {
      get(t, k, r) {
        if (typeof k === 'string') rec({ kind: 'env', path: k });
        return Reflect.get(t, k, r);
      },
      has(t, k) {
        if (typeof k === 'string') rec({ kind: 'env', path: k });
        return Reflect.has(t, k);
      },
    });
  }

  function wrap(ctx: RenderContext): RenderContext {
    const d = ctx.data;
    const via =
      <T>(kind: SourceKind, fn: () => T): (() => T) =>
      () => {
        rec({ kind });
        return fn();
      };
    const data: DataSources = {
      git: via('git', () => d.git()),
      transcript: via('transcript', () => d.transcript()),
      gsd: via('gsd', () => d.gsd()),
      agents: via('agents', () => d.agents()),
    };
    const history = d.history;
    if (history) data.history = via('history', () => history());
    const limits = d.limits;
    if (limits) data.limits = via('limits-cache', () => limits());
    const ledger = d.ledger;
    if (ledger) data.ledger = via('ledger', () => ledger());
    const repos = d.repos;
    if (repos) data.repos = via('repos', () => repos());
    const hooks = d.hooks;
    if (hooks) data.hooks = via('hooks', () => hooks());
    const jj = d.jj;
    if (jj) data.jj = via('jj', () => jj());
    const environment = d.environment;
    if (environment) data.environment = via('environment', () => environment());
    const sandbox = d.sandbox;
    if (sandbox) data.sandbox = via('sandbox', () => sandbox());
    const jobs = d.jobs;
    if (jobs) {
      const now = ctx.now.getTime();
      data.jobs = () => {
        const r = jobs();
        return {
          job(key) {
            const e = r?.job(key) ?? null;
            if (!e) rec({ kind: 'job', path: key, absent: true });
            else {
              const job: JobSource = { key, ok: e.ok };
              if (typeof e.error === 'string') job.error = e.error;
              if (typeof e.blockedUntil === 'number') job.blockedUntil = e.blockedUntil;
              rec({ kind: 'job', path: key, age: Math.max(0, now - e.fetchedAt), job });
            }
            return e as never;
          },
        };
      };
    }
    return { ...ctx, payload: deep(ctx.payload, ''), env: envProxy(ctx.env), data };
  }

  function forWidget(ctx: RenderContext): RenderContext {
    const { now, terminalWidth, cwd, ...rest } = ctx;
    const out = { ...rest } as RenderContext;
    const getter = <T>(value: T, read: () => TraceRead): PropertyDescriptor => ({
      enumerable: true,
      get() {
        rec(read());
        return value;
      },
    });
    Object.defineProperties(out, {
      now: getter(now, () => ({ kind: 'clock' })),
      terminalWidth: getter(terminalWidth, () => ({ kind: 'system' })),
      cwd: getter(cwd, () => peek(() => cwdRead(ctx.payload))),
    });
    return out;
  }

  return {
    begin() {
      cur = [];
    },
    end() {
      const out = cur ?? [];
      cur = null;
      return out;
    },
    wrap,
    forWidget,
  };
}

const keyOf = (r: TraceRead) => `${r.kind}\u0000${r.path ?? ''}`;

export function leaves(reads: TraceRead[]): TraceRead[] {
  const seen = new Map<string, TraceRead>();
  for (const r of reads) {
    const k = keyOf(r);
    const prev = seen.get(k);
    if (!prev || (prev.absent && !r.absent)) seen.set(k, r);
  }
  const all = [...seen.values()];
  return all.filter(
    (r) =>
      !r.path ||
      !all.some(
        (o) =>
          o !== r &&
          o.kind === r.kind &&
          !!o.path &&
          (o.path.startsWith(`${r.path}.`) || o.path.startsWith(`${r.path}[`)),
      ),
  );
}
