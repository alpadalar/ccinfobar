export const hookMessages = {
  'hooks.refused.unknownVersion':
    'Hooks need Claude Code 2.1.101 or newer, and its version could not be detected. Open Claude Code once, then run `ccinfobar install --hooks` again. The status line was installed without hooks.',
  'hooks.refused.oldVersion':
    'Hooks need Claude Code {floor} or newer (found {version}). The status line was installed without hooks.',
  'hooks.asyncOmitted':
    'Claude Code {version} runs these hooks synchronously, so each prompt waits for one Node start.',
  'hooks.badFlag': '--hooks takes no value or =permission',
  'hooks.unmanaged': '{event}: already present (not managed)',
  'hooks.dry.add': '  + hook {event}: {command}',
  'hooks.dry.keep': '  = hook {event} (already installed)',
  'hooks.dry.rewrite': '  ~ hook {event}: {from} → {command}',
  'hooks.dry.skipUnmanaged': '  - hook {event}: already present (not managed)',
  'hooks.dry.skipVersion': '  - hook {event}: needs Claude Code {floor}+',
  'hooks.dry.unknownVersion': '  - hooks: Claude Code version not detected; hooks need {floor}+',
  'hooks.dry.oldVersion': '  - hooks: need Claude Code {floor}+ (found {version})',
  'hooks.added': '✓ hooks added: {events}',
  'hooks.kept': '  hooks already installed: {events}',
  'hooks.rewritten': '✓ hooks updated to the new command: {events}',
  'hooks.skippedUnmanaged': '  already present (not managed): {events}',
  'hooks.skippedVersion': '  skipped (needs a newer Claude Code): {events}',
  'hooks.projectIgnored':
    '⚠ Hooks go to user settings only; run `ccinfobar install --hooks` without --project.',
  'hooks.detected': '  Claude Code {version}',
  'hooks.removed': '✓ Removed ccinfobar hooks: {events}',
  'hooks.leftEdited': '  Left hooks changed outside ccinfobar: {events}',
  'hooks.none': 'No ccinfobar hooks in {file}',
  'hooks.uninstallProject': '⚠ Hooks live in user settings only; `--project` ignores --hooks.',
} as const;
