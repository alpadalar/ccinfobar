export const doctorMessages = {
  'doctor.configIssue': '  line {line}, column {column}: {message}',
  'doctor.columnNote': '  (columns count UTF-16 code units)',
  'doctor.unknownWidget': '⚠ Unknown widget type "{type}" on line {line}',
  'doctor.badOption': '⚠ {type}: option "{key}" has an unsupported value',
  'doctor.gitHardeningOff': '  Git hardening off (gitHardening: false)',
  'doctor.noTraffic':
    '  Background update and usage checks off (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set)',
  'doctor.manifest': '  Manifest {file}: {count} recorded change(s)',
  'doctor.manifestEntry': '    {kind} in {file}',
  'doctor.backups': '  Backups {dir}',
  'doctor.winCommand':
    '⚠ The statusLine command has a backslash or a quoted first token; Git Bash may not run it. Run ccinfobar install again.',
  'doctor.tmpPruned': '  Removed {count} stale temp file(s)',
  'doctor.noPayload':
    '  No payload yet. Use Claude Code once with ccinfobar installed, or try `ccinfobar explain --scenario <name>`.',
  'doctor.limit.five_hour': '5-hour',
  'doctor.limit.seven_day': 'weekly',
  'doctor.limit.both': '5-hour and weekly',
  'doctor.note.limitFull':
    'Your {names} usage limit is at 100%, so Claude cannot reply right now. Context, cache and token widgets fill in after the next successful reply.',
  'doctor.note.noReplies':
    'This session has no replies yet (cost $0, no prompt cache). Send a message and run doctor again; context, cache and speed widgets need at least one answer.',
  'doctor.explainPointer': '  Details: `ccinfobar explain` (or `ccinfobar explain <widget-id>`)',
} as const;
