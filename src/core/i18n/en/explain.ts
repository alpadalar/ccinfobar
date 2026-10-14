export const explainMessages = {
  'explain.reason.unknown-type': 'unknown widget type "{type}"',
  'explain.reason.missing-option': 'option "{key}" is not set',
  'explain.reason.no-gsd': 'not inside a GSD project (no .planning/ found above the working directory)',
  'explain.reason.gsdNothing': 'the GSD files have nothing for this widget right now',
  'explain.reason.no-rate-limits':
    'no rate_limits from Claude Code and none from the usage API yet (needs a Claude Pro/Max login; see `ccinfobar usage`)',
  'explain.reason.limitsWindow': 'this usage window is not in rate_limits',
  'explain.reason.provider-no-plan-limits': '{provider} sessions have no plan limits',
  'explain.reason.no-context-window':
    'Claude Code sent no context_window and the transcript has no usage yet (update Claude Code or send a message)',
  'explain.reason.no-transcript':
    'no transcript yet: Claude Code creates it with the first message of the session',
  'explain.reason.no-git': 'not a git repository, or git is not on PATH',
  'explain.reason.no-replies':
    'Claude has not answered in this session yet; it appears after the first reply',
  'explain.reason.payload-field-absent': 'Claude Code did not send {path}{since}',
  'explain.reason.error': 'the widget failed',
  'explain.reason.no-data': 'no data for this widget in the current session',
  'explain.reason.commandEmpty': 'the command failed or printed nothing',
  'explain.provider.apiKey': 'API key',
  'explain.provider.bedrock': 'Amazon Bedrock',
  'explain.provider.mantle': 'Bedrock Mantle',
  'explain.provider.anthropicAws': 'Anthropic on AWS',
  'explain.provider.vertex': 'Google Vertex AI',
  'explain.provider.foundry': 'Microsoft Foundry',
  'explain.provider.gateway': 'API gateway ({host})',
  'explain.provider.firstParty': 'Claude subscription',
} as const;
