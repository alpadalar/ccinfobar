// GitHub sign-in on the user's machine; only the marketplace token is stored
import { createMarketClient, MarketError } from '../market/client.js';
import { DeviceFlowError, pollDeviceFlow, startDeviceFlow, VERIFY_URL } from '../market/github.js';
import type { MarketMeta } from '../market/protocol.js';
import {
  catalogDir,
  DEFAULT_MARKETPLACE,
  marketEndpointInfo,
  writeCredential,
  writePublisher,
} from './store.js';

// or a MarketError code
export type SignInCode =
  | 'no-endpoint'
  | 'not-github'
  | 'expired'
  | 'denied'
  | 'disabled'
  | 'failed'
  | 'cancelled'
  | 'upstream';

// fixed codes only, never response text or tokens
export class SignInError extends Error {
  readonly code: SignInCode | string;
  readonly status: number | null;
  // the server registers publishers on first publish instead
  readonly tokenMode: boolean;
  constructor(code: SignInCode | string, opts: { status?: number | null; tokenMode?: boolean } = {}) {
    super(code);
    this.name = 'SignInError';
    this.code = code;
    this.status = opts.status ?? null;
    this.tokenMode = opts.tokenMode === true;
  }
}

export interface SignInCodeInfo {
  userCode: string;
  verificationUri: typeof VERIFY_URL;
  expiresAt: number;
}

export interface SignInDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  dir?: string;
  env?: NodeJS.ProcessEnv;
  defaultEndpoint?: string | null;
  onCode(info: SignInCodeInfo): void | Promise<void>;
}

export interface SignedIn {
  endpoint: string;
  handle: string;
  admin: boolean;
}

type Client = ReturnType<typeof createMarketClient>;

function fromMarket(err: unknown): SignInError {
  if (err instanceof SignInError) return err;
  if (err instanceof MarketError) return new SignInError(err.code, { status: err.status });
  return new SignInError('failed');
}

function fromGitHub(err: unknown): SignInError {
  if (!(err instanceof DeviceFlowError)) return new SignInError('failed');
  if (err.code === 'cancelled' || err.code === 'disabled') return new SignInError(err.code);
  return new SignInError(err.code === 'failed' ? 'failed' : 'upstream');
}

const githubClientId = (meta: MarketMeta): string | null =>
  meta.auth.includes('github-device') && meta.github ? meta.github.clientId : null;

// one exchange; the GitHub token goes only to the endpoint whose meta named the client id
export async function finishSignIn(
  endpoint: string,
  githubToken: string,
  deps: Pick<SignInDeps, 'fetch' | 'dir'>,
  client: Client = createMarketClient({ endpoint, fetch: deps.fetch }),
): Promise<SignedIn> {
  let res: Awaited<ReturnType<Client['signIn']>>;
  try {
    res = await client.signIn(githubToken);
  } catch (err) {
    throw fromMarket(err);
  }
  const dir = deps.dir ?? catalogDir();
  writeCredential(endpoint, res.token, dir);
  writePublisher(endpoint, res.handle, dir);
  return { endpoint, handle: res.handle, admin: res.admin };
}

export async function signInWithGitHub(deps: SignInDeps): Promise<SignedIn> {
  const dir = deps.dir ?? catalogDir(deps.env);
  const fallback = deps.defaultEndpoint !== undefined ? deps.defaultEndpoint : DEFAULT_MARKETPLACE;
  const { url: endpoint } = marketEndpointInfo(deps.env ?? process.env, dir, fallback);
  if (!endpoint) throw new SignInError('no-endpoint');
  if (deps.signal?.aborted) throw new SignInError('cancelled');
  let client: Client;
  let meta: MarketMeta;
  try {
    client = createMarketClient({ endpoint, fetch: deps.fetch });
    meta = await client.meta();
  } catch (err) {
    throw deps.signal?.aborted ? new SignInError('cancelled') : fromMarket(err);
  }
  const clientId = githubClientId(meta);
  if (!clientId) {
    const tokenMode = !meta.auth.includes('github-device') && meta.auth.includes('token');
    throw new SignInError('not-github', { tokenMode });
  }
  const gh = {
    fetch: deps.fetch,
    now: deps.now,
    sleep: deps.sleep,
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
  let start: Awaited<ReturnType<typeof startDeviceFlow>>;
  try {
    start = await startDeviceFlow(clientId, gh);
  } catch (err) {
    throw fromGitHub(err);
  }
  await deps.onCode({ userCode: start.userCode, verificationUri: VERIFY_URL, expiresAt: start.expiresAt });
  const flow = await pollDeviceFlow(clientId, start, gh);
  if (flow.status !== 'ok') throw new SignInError(flow.status);
  if (deps.signal?.aborted) throw new SignInError('cancelled');
  return finishSignIn(endpoint, flow.token, { fetch: deps.fetch, dir }, client);
}
