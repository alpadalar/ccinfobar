export const installMessages = {
  'install.installing': 'Installing ccinfobar {version}',
  'install.wrote': '✓ statusLine set to "{command}" in {file}',
  'install.foreignHeader': '{file} already has a statusLine from another tool.',
  'install.current': '  current:  {command}',
  'install.proposed': '  proposed: {command}',
  'install.refreshDiff': '  refreshInterval: {current} -> {proposed}',
  'install.refreshHint':
    'Time-based widgets ({widgets}) only update when Claude Code re-runs the status line. Add `--refresh 5` to refresh every 5 s; Claude Code does not re-run it on hook events and hides it while a permission prompt or the help menu is open.',
  'install.refreshHintRules':
    'Time rules on {items} only change when Claude Code re-runs the status line. Add `--refresh 5` to refresh every 5 s.',
  'install.refreshHintRotation':
    'Theme rotation by the hour or by minutes switches themes only when Claude Code re-runs the status line; `ccinfobar install --refresh 5` keeps it on time while idle.',
  'install.refreshOne': 'refreshInterval 1 starts Node every second; 5 is usually enough.',
  'install.paddingDiff': '  padding: {current} -> {proposed}',
  'install.replacePrompt': 'Replace?',
  'install.kept': 'Kept the current statusLine. Nothing was changed.',
  'install.replaced': 'Replaced: {command}',
  'install.dryRun': 'Dry run: nothing was written.',
  'install.dryRunGlobal': 'Would install ccinfobar {version} with npm first.',
  'install.dryRunFile': 'Would set statusLine in {file}',
  'install.dryRunProjects': {
    one: "Would also replace GSD's status line in {count} project:",
    other: "Would also replace GSD's status line in {count} projects:",
  },
  'install.unset': 'unset',
  'install.stale':
    'The statusLine in {file} changed while installing; nothing was written. Run install again.',
  'install.unchanged': 'statusLine already runs ccinfobar; nothing to change.',
  'install.subagentsProjectIgnored': '--subagents only applies to user settings; ignored with --project.',
  'install.hideVimProjectIgnored':
    '--hide-vim-indicator only applies to user settings; ignored with --project.',
  'install.subagentsUninstallProject': '--subagents only applies to user settings; ignored with --project.',
  'install.dry.subagentAdd': 'Would set subagentStatusLine to "{command}"',
  'install.dry.subagentRewrite': 'Would update subagentStatusLine from "{from}" to "{command}"',
  'install.dry.subagentReplace':
    'Would replace the subagentStatusLine "{from}" with "{command}" (asked first)',
  'install.dry.hideVim': 'Would set statusLine.hideVimModeIndicator',
  'install.dry.hideVimOff': 'Would remove statusLine.hideVimModeIndicator',
  'install.hideVimPrompt':
    "Your status line shows the vim mode and Claude Code shows it too. Hide Claude Code's indicator?",
  'install.hideVimSet':
    '✓ statusLine.hideVimModeIndicator set; Claude Code no longer shows the vim mode itself',
  'install.hideVimUnset': '✓ statusLine.hideVimModeIndicator removed',
  'install.dry.subagentKeep': 'subagentStatusLine already runs ccinfobar',
  'install.subagentReplacePrompt': 'Replace the current subagentStatusLine ({command})?',
  'install.subagentsKept': 'Kept the current subagentStatusLine.',
  'install.subagentsAdded': '✓ subagentStatusLine set to "{command}"',
  'install.subagentsRewritten': '✓ subagentStatusLine updated to "{command}"',
  'install.subagentsReplaced':
    '✓ subagentStatusLine set to "{command}" (replaced {previous}; uninstall brings it back)',
  'install.subagentsRemoved': '✓ subagentStatusLine removed',
  'install.subagentsRestored': '✓ subagentStatusLine restored to "{command}"',
  'install.subagentsKeptEdited': 'subagentStatusLine was changed by hand; kept',
  'install.subagentsNone': 'No ccinfobar subagentStatusLine in {file}',
  'install.backup': '  Backup: {file}',
  'install.legacyPrompt':
    "This statusLine mentions ccinfobar but was not recorded by it: {command}. Treat it as ccinfobar's?",
  'install.unsafePath':
    'Cannot build a safe command for {path}: it contains {chars}. Move ccinfobar to a path without them.',
  'install.projectsTaken': {
    one: "✓ Also replaced GSD's status line in {count} project:",
    other: "✓ Also replaced GSD's status line in {count} projects:",
  },
  'install.manifestReadOnly':
    '{file} was written by a newer ccinfobar or is damaged; not changing any settings. Move it aside to continue.',
  'install.manifestBusy': 'Another ccinfobar command is updating {file}; try again in a moment.',
  'install.needsConfirm': 'Confirm replacing the current statusLine first.',
  'install.confirmNeedsCurrent': 'A confirmed install must send the statusLine it was shown.',
  'install.prompt.yes': '[Y/n]',
  'install.prompt.no': '[y/N]',
  'install.importManual':
    'Found {tool} as your current status line. Its settings cannot be imported automatically.',
  'install.importSkipped':
    'ccinfobar already has a config, so the previous status line was not imported; run `ccinfobar install --import` to import it.',
  'install.importPrompt': 'Found {tool} as your current status line. Import its layout into ccinfobar?',
  'install.noCommand':
    '✗ No ccinfobar install to point Claude Code at. Install it with: npm install -g ccinfobar',
  'install.projectWins': '  It now wins over "{command}" from {file}.',
  'install.projectLocal':
    '  settings.local.json stays out of git; `ccinfobar uninstall --project` undoes it.',
  'install.config': '  Config: {file}',
  'install.bringsBack': '  `ccinfobar uninstall` brings back {tool}.',
  'install.projectOwn': '⚠ {file} sets its own statusLine, which wins in this project.',
  'install.projectHint': '  Run `{command} install --project` here to use ccinfobar in it too.',
  'install.customize': '  Customize with `{command} edit` (browser) or `{command} tui` (terminal).',
  'install.setup.updating': 'Updating the global ccinfobar {old} to {version} ...',
  'install.setup.global': 'Installing ccinfobar {version} globally (skip with --no-global) ...',
  'install.setup.installed': '✓ Installed {bin}',
  'install.setup.notOnPath': '  {dir} is not on your PATH; add it to type `ccinfobar` directly.',
  'install.setup.updateFailed': '⚠ Could not update the global ccinfobar {old}: {error}',
  'install.setup.globalFailed': '⚠ Global install failed: {error}',
  'install.setup.missingGlobal':
    '⚠ The global ccinfobar at {bin} points to a missing file and is not used; reinstall it with `npm install -g ccinfobar@latest` or remove it with `npm rm -g ccinfobar`',
  'install.setup.staleGlobal':
    '⚠ The global ccinfobar {old} is older than {version} and is not used; update it with `npm install -g ccinfobar@latest` or remove it with `npm rm -g ccinfobar`',
  'install.setup.pinned': 'Installing a pinned copy of ccinfobar {version} in {dir} ...',
  'install.setup.failed': '✗ Could not install ccinfobar: {error}',
  'install.setup.notFound': 'npm finished but ccinfobar was not found',
  'install.setup.noPermission': "no permission to write to npm's global folder (EACCES)",
  'install.setup.npmFailed': 'npm install failed',
  'install.settings.cannotParse': 'Cannot parse {file}: {reason}',
  'install.settings.notObject': 'not a JSON object',
  'install.settings.changed': '{file} changed while writing; try again',
  'uninstall.restoredExact': '✓ Restored {file} exactly as it was before ccinfobar',
  'uninstall.restoredPrevious': '✓ Restored the previous statusLine: {command}',
  'uninstall.removed': '✓ Removed ccinfobar from {file}',
  'uninstall.deletedFile': '✓ Removed {file}; ccinfobar had created it',
  'uninstall.foreign': "The statusLine in {file} is not ccinfobar's; left it alone: {command}",
  'uninstall.goneRestored':
    'statusLine was already removed from {file}; restored the previous one: {command}',
  'uninstall.goneNothing': 'statusLine was already removed from {file}; nothing to do',
  'uninstall.notInstalled': 'ccinfobar is not installed in {file}',
  'uninstall.releasedProjects': {
    one: '✓ Gave {count} project its own status line back',
    other: '✓ Gave {count} projects their own status line back',
  },
  'editor.planTitle': 'Install ccinfobar in Claude Code',
  'editor.planCurrent': 'Current status line',
  'editor.planProposed': 'New status line',
  'editor.planReplace': 'Replace it',
  'editor.planCancel': 'Keep current',
  'editor.installed': 'Installed. Backups are in {dir}',
  'editor.refreshHint':
    'These widgets only update when Claude Code refreshes the status line: {widgets}. Claude Code does not refresh it on hook events and hides it while a permission prompt or the help menu is open.',
  'editor.refreshUse': 'Use {n} s refresh',
  'tui.replaceQuestion': 'Replace "{current}" with "{proposed}"?',
  'tui.installed': 'Installed: statusLine runs "{command}". Backups are in {dir}',
  'usage.apiNote':
    'With usageApi on (the default), ccinfobar asks api.anthropic.com/api/oauth/usage for your plan limits with your local Claude login, only when Claude Code sends no rate_limits; set "usageApi": false to turn it off.',
  'usage.apiOff':
    'Usage API fetch is off (usageApi: false or CCINFOBAR_NO_USAGE_API); plan limits come only from what Claude Code sends.',
} as const;
