export const hookMessages = {
  'hooks.refused.unknownVersion':
    'Hooks need Claude Code {floor} or newer, and its version could not be detected. Open Claude Code once, then run `ccinfobar install --hooks` again. The status line was installed without hooks.',
  'hooks.refused.oldVersion':
    'Hooks need Claude Code {floor} or newer (found {version}). The status line was installed without hooks.',
  'hooks.asyncOmitted':
    'Claude Code {version} runs these hooks synchronously, so each prompt waits for one Node start.',
  'hooks.badFlag': '--hooks takes no value or =permission',
  'hooks.runnerCommand':
    'The hooks run the status line command through a package runner (npx, bunx or dlx) on every event, which is slow and may use the network. Install ccinfobar globally and pass --command ccinfobar instead.',
  'hooks.badArg': 'Unexpected argument "{arg}"; options take a value with =, such as --hooks=permission',
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
  'progress.added':
    '✓ Added the progress handlers for {events} (they run before each prompt; about 60-110 ms)',
  'progress.removed': '✓ Removed the progress handlers',
  'progress.none': 'No progress handlers in {file}',
  'progress.tty':
    '✓ Terminal progress uses the tty channel: the status line writes the bar itself, so no hook handlers are added (installed ones are removed).',
  'progress.held':
    '✓ Turned progress off. Its handlers stay until the bar clears at the next prompt; run `ccinfobar uninstall --progress` again to remove them.',
  'progress.refused.oldVersion': 'Terminal progress needs Claude Code {floor} or newer (found {version})',
  'progress.refused.unknownVersion':
    'Could not detect the Claude Code version; terminal progress needs {floor} or newer',
  'progress.dry.add': '  + {event} (progress): {command}',
  'progress.tip':
    'Tip: set "terminalProgressBarEnabled": false in Claude Code settings so the two bars do not flicker.',
  'progress.badFlag': '--progress takes no value',
  'progress.projectIgnored':
    '⚠ Terminal progress goes to user settings only; run `ccinfobar install --progress` without --project.',
  'progress.uninstallProject':
    '⚠ Progress handlers live in user settings only; `--project` ignores --progress.',
  'edit.detachFailed':
    'Could not start the editor in the background. Run `ccinfobar edit` in a terminal instead.',
  'edit.running': 'ccinfobar editor running at {url}',
  'edit.stopHint': 'Press Ctrl+C to stop',
  'edit.stopping': '\nStopping editor',
} as const;
