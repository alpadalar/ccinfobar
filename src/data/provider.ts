export type ProviderKind =
  | 'firstParty'
  | 'apiKey'
  | 'bedrock'
  | 'mantle'
  | 'anthropicAws'
  | 'vertex'
  | 'foundry'
  | 'gateway';

export interface Provider {
  kind: ProviderKind;
  host?: string;
  planLimits: boolean;
}

type Env = Record<string, string | undefined>;

const FLAGS: [string, ProviderKind][] = [
  ['CLAUDE_CODE_USE_BEDROCK', 'bedrock'],
  ['CLAUDE_CODE_USE_MANTLE', 'mantle'],
  ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'anthropicAws'],
  ['CLAUDE_CODE_USE_VERTEX', 'vertex'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'foundry'],
];

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v.trim());

function gatewayHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host && host !== 'api.anthropic.com' ? host : null;
  } catch {
    return null;
  }
}

// presence only; secrets are never read out
export function detectProvider(env: Env): Provider {
  for (const [key, kind] of FLAGS) if (truthy(env[key])) return { kind, planLimits: false };
  const host = gatewayHost(env.ANTHROPIC_BASE_URL);
  if (host) return { kind: 'gateway', host, planLimits: false };
  if ((env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { kind: 'apiKey', planLimits: false };
  }
  return { kind: 'firstParty', planLimits: true };
}
