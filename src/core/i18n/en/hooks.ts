export const hookMessages = {
  'hooks.refused.unknownVersion':
    'Hooks need Claude Code {floor} or newer, and its version could not be detected. Open Claude Code once, then run `ccinfobar install --hooks` again. The status line was installed without hooks.',
  'hooks.refused.oldVersion':
    'Hooks need Claude Code {floor} or newer (found {version}). The status line was installed without hooks.',
  'hooks.asyncOmitted':
    'Claude Code {version} runs these hooks synchronously, so each prompt waits for one Node start.',
  'hooks.badFlag': '--hooks takes no value or =permission',
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
  'hooks.reason.notActive': 'Turn on ccinfobar as the status line first (Install above).',
  'hooks.reason.unknownVersion':
    'Hooks need Claude Code {floor} or newer, and its version could not be detected. Open Claude Code once, then restart the editor.',
  'hooks.reason.oldVersion': 'Hooks need Claude Code {floor} or newer (found {version}).',
  'hooks.badBody': 'enabled must be true or false; permission must be true, false or left out',
  'hooks.uninstallProject': '⚠ Hooks live in user settings only; `--project` ignores --hooks.',
  'edit.detachFailed':
    'Could not start the editor in the background. Run `ccinfobar edit` in a terminal instead.',
} as const;
