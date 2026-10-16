export const doctorMessages = {
  'doctor.configIssue': '  line {line}, column {column}: {message}',
  'doctor.refreshHint':
    '  Time-based widgets ({widgets}) only update when Claude Code re-runs the status line. Run `ccinfobar install --refresh 5` to refresh every 5 s; Claude Code does not re-run it on hook events or while a permission dialog is open.',
  'doctor.refreshHintRules':
    '  Time rules on {items} only change when Claude Code re-runs the status line. Run `ccinfobar install --refresh 5` to refresh every 5 s.',
  'doctor.lineCut':
    '  ⚠ Line {line} needs {need} columns and is cut with "…". Lower widthOffset, set "overflow": "priority" to drop low-priority widgets, or "overflow": "wrap".',
  'doctor.lineCutMode':
    '  ⚠ Line {line} needs {need} columns and is still cut with "…" under "overflow": "{mode}". Move widgets to another line or lower widthOffset.',
  'doctor.jetbrains':
    '  JetBrains terminal detected. Set "glyphMode": "jetbrains" (or "auto") so emoji line up.',
  'doctor.priorityTui':
    '  "overflow": "priority" does not apply to the tui style; panel cells use their own breakpoints.',
  'doctor.columnNote': '  (columns count UTF-16 code units)',
  'doctor.language': '  Language: {name} ({id}, from {source})',
  'doctor.languageFrom.config': 'config',
  'doctor.languageFrom.Intl': 'system locale',
  'doctor.languageFrom.default': 'default',
  'doctor.languageDropped': '⚠ language "{value}" is not supported and is ignored (use {values})',
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
  'doctor.hooks.progressEntry': '    {event} (progress), Claude Code {claudeCode}',
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
  'doctor.progress.ccBar':
    '⚠ Claude Code draws its own progress bar too. Set "terminalProgressBarEnabled": false in {file} so the two do not flicker.',
  'doctor.progress.noHandlers':
    '⚠ Terminal progress is on but its hook handlers are missing. Run `ccinfobar install --progress`.',
  'doctor.progress.strayHandlers':
    '⚠ Progress hook handlers are installed but progress is off. Run `ccinfobar uninstall --progress`.',
  'doctor.progress.terminal':
    '⚠ This terminal is not known to show OSC 9;4 progress; set "progress.terminals": "always" to try anyway.',
  'doctor.progress.oldClaude': '⚠ Terminal progress needs Claude Code 2.1.141 or newer (found {version}).',
  'doctor.progress.ttyHandlers':
    '⚠ Progress uses the tty channel, so its hook handlers only add prompt latency. Run `ccinfobar install --progress` to remove them.',
  'doctor.progress.ttyWindows': '⚠ "channel": "tty" does not work on Windows; use "auto".',
  'doctor.progress.tmux':
    '⚠ Inside tmux the tty channel needs "tmuxPassthrough": true and `set -g allow-passthrough on`.',
  'doctor.node': '{mark} Node.js {version} (needs 20+)',
  'doctor.config': '{mark} Config {file}',
  'doctor.configMissing': '{mark} Config {file} (not created yet, defaults in use)',
  'doctor.statusLine': '{mark} Claude Code statusLine in {file}: {command}',
  'doctor.statusLineUnset': '{mark} Claude Code statusLine in {file}: not set',
  'doctor.projectOverride': '✗ {file} overrides it with: {command}',
  'doctor.projectOverrideFix': '  Run `{command} install --project` in {dir} to use ccinfobar there.',
  'doctor.lastPayload': '{mark} Last payload {file}',
  'doctor.cacheDir': '  Cache dir {dir}',
  'doctor.detectedWidth': '  Detected width {width}',
  'doctor.detectedWidthUnknown': '  Detected width unknown',
  'doctor.update.off': '  Update checks off',
  'doctor.update.available': '✗ Update available: {current} → {latest} (run `ccinfobar update`)',
  'doctor.update.upToDate': '✓ Up to date ({mode} mode, {kind} install, last checked {when})',
  'doctor.update.neverChecked': '✓ Up to date ({mode} mode, {kind} install, not checked yet)',
  'doctor.update.availableBrew': '✗ Update available: {current} → {latest} (run `brew upgrade ccinfobar`)',
  'doctor.update.brew':
    '✓ Up to date ({mode} mode, updates via brew upgrade ccinfobar (Homebrew install), last checked {when})',
  'doctor.update.neverCheckedBrew':
    '✓ Up to date ({mode} mode, updates via brew upgrade ccinfobar (Homebrew install), not checked yet)',
  'doctor.update.failed': '  Last update check failed: {error}',
  'doctor.updateMode.auto': 'auto',
  'doctor.updateMode.notify': 'notify',
  'doctor.updateMode.off': 'off',
  'doctor.installKind.npm-global': 'npm-global',
  'doctor.installKind.local': 'local',
  'doctor.installKind.npx': 'npx',
  'doctor.installKind.brew': 'Homebrew',
  'doctor.installKind.source': 'source',
  'doctor.installKind.unknown': 'unknown',
  'doctor.enableHint': '\nRun `{command} install` to enable it in Claude Code.',
  'doctor.widgets.heading': '\nWidgets',
  'doctor.lastPayloadFields': '  Last payload: Claude Code {version}, fields: {fields}',
  'doctor.unknownVersion': 'unknown version',
  'doctor.widthLine': '\n  Width: {width} columns detected, {usable} usable after widthOffset',
  'doctor.widthLineUnknown': '\n  Width: unknown columns detected, {usable} usable after widthOffset',
  'doctor.widthNone': 'no',
  'doctor.usage.claudeCode': 'Usage limits: from Claude Code',
  'doctor.usage.off': 'Usage limits: usage API off (usageApi: false)',
  'doctor.usage.notCalled': 'Usage limits: usage API not called yet',
  'doctor.usage.fresh': 'Usage limits: from the usage API, {age} min old',
  'doctor.usage.freshError': 'Usage limits: from the usage API, {age} min old (last error: {error})',
  'doctor.usage.noData': 'Usage limits: no data from the usage API',
  'doctor.usage.noDataError': 'Usage limits: no data from the usage API (last error: {error})',
  'doctor.http.envSet': '{name} (set)',
  'doctor.http.envUnset': '{name} (unset)',
  'doctor.row.hidden': 'hidden',
  'doctor.row.hiddenEmpty': 'hidden (hideEmpty)',
  'doctor.row.error': 'error',
  'doctor.row.empty': 'shows —',
} as const;
