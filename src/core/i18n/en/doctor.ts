export const doctorMessages = {
  'doctor.configIssue': '  line {line}, column {column}: {message}',
  'doctor.refreshHint':
    '  Time-based widgets ({widgets}) only update when Claude Code re-runs the status line. Run `ccinfobar install --refresh 5` to refresh every 5 s; Claude Code does not re-run it on hook events or while a permission dialog is open.',
  'doctor.refreshHintRules':
    '  Time rules on {items} only change when Claude Code re-runs the status line. Run `ccinfobar install --refresh 5` to refresh every 5 s.',
  'doctor.columnNote': '  (columns count UTF-16 code units)',
  'doctor.unknownWidget': '⚠ Unknown widget type "{type}" on line {line}',
  'doctor.badOption': '⚠ {type}: option "{key}" has an unsupported value',
  'doctor.badRule': '⚠ Widget {id}: {key} is ignored ({problem})',
  'doctor.hiddenByRule': 'hidden by rule',
  'doctor.http.item': '  http on line {line}: {url}, sends {env}',
  'doctor.http.noEnv': 'no env vars',
  'doctor.http.noUrl': '⚠ http on line {line}: no url set; the item shows nothing',
  'doctor.http.badUrl': '⚠ http on line {line}: url: {error}; the item shows nothing',
  'doctor.http.badHeader': '⚠ http on line {line}: {error} (this header is dropped)',
  'doctor.http.refusedHeader': '⚠ http on line {line}: headers: {error}; the item shows nothing',
  'doctor.http.badPath': '⚠ http on line {line}: path: {error}; the item shows nothing',
  'doctor.http.plain':
    '⚠ http on line {line}: {host} uses plain http, so the reply can be read or changed on the way. Use https.',
  'doctor.gitHardeningOff': '  Git hardening off (gitHardening: false)',
  'doctor.manifest': '  Manifest {file}: {count} recorded change(s)',
  'doctor.manifestEntry': '    {kind} in {file}',
  'doctor.backups': '  Backups {dir}',
  'doctor.winCommand':
    '⚠ The statusLine command has a backslash or a quoted first token; Git Bash may not run it. Run ccinfobar install again.',
  'doctor.tmpPruned': '  Removed {count} stale temp file(s)',
  'doctor.noPayload':
    '  No payload yet. Use Claude Code once with ccinfobar installed, or try `ccinfobar explain --scenario <name>`.',
  'doctor.row.workspaceHidden': 'hidden (workspace mode)',
  'doctor.limit.five_hour': '5-hour',
  'doctor.limit.seven_day': 'weekly',
  'doctor.limit.both': '5-hour and weekly',
  'doctor.note.limitFull':
    'Your {names} usage limit is at 100%, so Claude cannot reply right now. Context, cache and token widgets fill in after the next successful reply.',
  'doctor.note.noReplies':
    'This session has no replies yet (cost $0, no prompt cache). Send a message and run doctor again; context, cache and speed widgets need at least one answer.',
  'doctor.explainPointer': '  Details: `ccinfobar explain` (or `ccinfobar explain <widget-id>`)',
  'doctor.hooks.off':
    '  Hooks: off. Run `ccinfobar install --hooks` for exact turn, permission and subagent state.',
  'doctor.hooks.summary': '  Hooks: {count} installed by ccinfobar (recorded with Claude Code {versions})',
  'doctor.hooks.entry': '    {event} (Claude Code {claudeCode})',
  'doctor.hooks.edited':
    '⚠ The {event} hook was changed or removed outside ccinfobar; ccinfobar leaves it alone.',
  'doctor.hooks.missingBinary':
    '⚠ Hook command not found: {command} ({count} hook(s)). Claude Code shows a hook error on each event. Run `ccinfobar install --hooks` again, or `ccinfobar uninstall` to remove them.',
  'doctor.hooks.disableAll':
    '⚠ disableAllHooks is on in {layer} settings ({file}): Claude Code runs no hooks and no status line',
  'doctor.hooks.managedOnly':
    '⚠ allowManagedHooksOnly is on in managed settings ({file}): user hooks are ignored and only a managed statusLine runs',
  'doctor.hooks.managedNote':
    '  Only file-based managed settings were checked (not MDM or registry policies)',
  'doctor.hooks.lastEvent': '  Last hook event {age} ago (last payload session)',
  'doctor.hooks.noEvents': '  No hook events logged for the last payload session yet',
} as const;
