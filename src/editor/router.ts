import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler<C> = (
  ctx: C,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<void> | void;

export interface PrefixRoute<C> {
  methods: readonly string[];
  path: string;
  handler: Handler<C>;
}

export interface ExactRoute<C> {
  method: string;
  path: string;
  handler: Handler<C>;
}

export function createRouter<C>(defs: {
  prefix: readonly PrefixRoute<C>[];
  exact: readonly ExactRoute<C>[];
}) {
  const exact = new Map<string, Handler<C>>();
  for (const e of defs.exact) {
    const key = `${e.method} ${e.path}`;
    if (exact.has(key)) throw new Error(`route-duplicate:${key}`);
    exact.set(key, e.handler);
  }
  return {
    match(method: string, pathname: string): Handler<C> | null {
      for (const p of defs.prefix) {
        if (p.methods.includes(method) && pathname.startsWith(p.path)) return p.handler;
      }
      return exact.get(`${method} ${pathname}`) ?? null;
    },
    table(): { exact: string[]; prefix: [string, string][] } {
      return {
        exact: [...exact.keys()],
        prefix: defs.prefix.map((p): [string, string] => [p.methods.join('|'), p.path]),
      };
    },
  };
}
