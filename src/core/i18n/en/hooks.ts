export const hookMessages = {
  'hooks.refused.unknownVersion':
    'Hooks need Claude Code 2.1.101 or newer, and its version could not be detected. Open Claude Code once, then run `ccinfobar install --hooks` again. The status line was installed without hooks.',
  'hooks.refused.oldVersion':
    'Hooks need Claude Code {floor} or newer (found {version}). The status line was installed without hooks.',
  'hooks.asyncOmitted':
    'Claude Code {version} runs these hooks synchronously, so each prompt waits for one Node start.',
  'hooks.badFlag': '--hooks takes no value or =permission',
  'hooks.unmanaged': '{event}: already present (not managed)',
} as const;
