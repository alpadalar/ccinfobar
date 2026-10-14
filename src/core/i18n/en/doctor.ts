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
  'doctor.explainPointer': '  Details: `ccinfobar explain` (or `ccinfobar explain <widget-id>`)',
} as const;
