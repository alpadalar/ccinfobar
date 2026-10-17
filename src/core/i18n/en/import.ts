export const importMessages = {
  'import.cannotRead': 'Cannot read ccstatusline settings at {file}',
  'import.cannotParse': 'Cannot parse claude-powerline config at {file}',
  'import.cannotReadTool': 'Cannot read {tool} config at {file}',
  'import.cannotParseTool': 'Cannot parse {tool} config at {file}',
  'import.tooLarge': '{file} is larger than 1 MB and was not read',
  'import.notFound': 'no {tool} config found ({file}); pass its path with --file',
  'import.shownCommand': 'path from the status line command',
  'import.tool.gsd': 'GSD status line',
  'import.tool.custom': 'a custom status line',
  'import.help.title': "Import another status line's layout into ccinfobar",
  'import.help.tools': 'Tools',
  'import.help.fromCommand': 'status line command',
  'import.help.footer':
    "Without --file each tool's own default file is read. --dry-run shows the mapping and writes nothing.",
  'import.note.noEquivalent': '{tool} widget "{name}" has no ccinfobar equivalent and was skipped',
  'import.note.noSegment': '{tool} segment "{name}" has no ccinfobar equivalent and was skipped',
  'import.note.customColors': 'custom {tool} colors were copied onto each widget',
  'import.note.defaultLayout': 'no {tool} config file found, imported its default layout',
  'import.note.selfUpdate': '{tool} segment "{name}" was dropped: ccinfobar updates itself',
  'import.note.usageApi':
    '{tool} segment "{name}": usage API options ({options}) were dropped, ccinfobar never sends your token to a custom host',
  'import.note.lineBreak': {
    one: '{tool} breaks the line after 1 segment: the remaining widgets start a second line ({tool} counts only segments that show something, so the split can differ)',
    other:
      '{tool} breaks the line after {count} segments: the remaining widgets start a second line ({tool} counts only segments that show something, so the split can differ)',
  },
  'import.note.iconColor': '{tool} segment "{name}": icon color dropped, the widget has one color',
  'import.note.commandDir': 'read the {tool} config next to the status line command: {file}',
  'import.note.themeFile': '{tool} theme "{name}" is set in the status line command, read from {file}',
  'import.note.themeBuiltin':
    '{tool} theme "{name}" is set in the status line command, imported its built-in theme',
  'import.note.themeUnknown':
    '{tool} theme "{name}" is set in the status line command but was not found, imported its default theme',
  'import.note.themeUnsafe':
    '{tool} theme "{name}" in the status line command is not a safe theme name and was ignored',
  'import.note.themeApprox': '{tool} theme "{name}" is approximated by the {theme} theme',
  'import.note.themeMissing': '{tool} theme "{name}" has no ccinfobar equivalent, used the {theme} theme',
  'import.note.styleApprox': '{tool} style "{name}" is approximated by the {style} style',
  'import.note.ignoredSettings': '{tool} settings not imported: {names}',
  'import.note.secretDropped': '{tool} setting "{name}" holds a secret and was not copied',
  'import.note.fileIgnored': '{tool} reads its settings from the status line command, --file was ignored',
  'import.cshipNotFound': 'no cship config found',
  'import.cshipNoLines': 'cship config has no lines ({file})',
  'import.note.starshipConfig':
    'read the {tool} config from $STARSHIP_CONFIG: {file} (cship itself only uses it for Starship modules)',
  'import.note.noModule': '{tool} module "{name}" has no ccinfobar equivalent and was skipped',
  'import.note.moduleApprox': '{tool} module "{name}" is approximated by the {widget} widget',
  'import.note.thresholdColors':
    '{tool} module "{name}": warn/critical thresholds and styles became ccinfobar threshold colors (yellow from 50%, red from 80%)',
  'import.note.noThreshold':
    '{tool} module "{name}": warn/critical thresholds were dropped, the {widget} widget has no threshold colors',
  'import.note.moduleOptions':
    '{tool} module "{name}": {options} not imported, the widget uses its own format',
  'import.note.unknownStyle': '{tool} style of "{name}": {tokens} not supported, ignored',
  'import.note.fillChar': '{tool} fill character "{symbol}" is shown as spaces',
  'import.note.starshipPrompt':
    '{tool} $starship_prompt was dropped: ccinfobar does not run Starship; a command widget running "starship prompt" could show it (none was created)',
  'import.note.starshipModule':
    'Starship module "{name}" has no ccinfobar equivalent and was dropped; a command widget running "starship module {name}" could show it (none was created)',
  'import.note.spanLiteral':
    '{tool} styled text "{text}" is shown as written: variables inside [ ] are not expanded',
  'import.note.emptySpans': {
    one: '{tool}: {count} styled span without visible text (a powerline transition) was dropped',
    other: '{tool}: {count} styled spans without visible text (powerline transitions) were dropped',
  },
  'import.note.gapsReplaced':
    '{tool}: modules separated by {gaps} now use the most common separator, {separator}',
  'import.note.hudIgnored': '{file} is not a JSON object and was ignored',
  'import.note.hudApprox': '{tool} "{name}" is approximated by the {widget} widget',
  'import.note.hudShownAlways':
    '{tool} setting "{name}" = {value} hides {widget} below that value, ccinfobar always shows it',
  'import.note.hudNoThreshold':
    '{tool} setting "{name}" = {value} was dropped, the {widget} widget has no threshold colors',
  'import.note.hudContextThresholds':
    '{tool} context thresholds {warn}%/{critical}% became ccinfobar threshold colors (yellow from 50%, red from 80%)',
  'import.note.hudBreakdown':
    '{tool} token breakdown is always shown ({tool} shows it from {value}% context)',
  'import.note.hudExternalUsage':
    '{tool} setting "{name}" was dropped: ccinfobar takes usage only from Claude Code and never reads or writes other files',
  'import.note.hudLanguage':
    '{tool} language "{name}" was not imported: ccinfobar keeps its own language setting',
  'import.note.hudExtraCmd':
    '{tool} runs --extra-cmd only when CLAUDE_HUD_ALLOW_EXTRA_CMD is set, and it is not set in your environment or settings.json',
  'import.note.hideState': '{name}: hiding when "{state}" is not supported, it stays visible',
  'import.note.targetDropped': '{kind} "{target}" was dropped (not confirmed)',
  'import.note.targetChanged':
    '{kind} "{target}" changed when it was cleaned: line breaks became spaces, escape and control characters were removed',
  'import.note.unsafeLink': 'link "{url}" has an unsafe URL and was dropped',
  'import.kind.command': 'command',
  'import.kind.http': 'http',
  'import.kind.link': 'link',
  'import.targetsHeader': 'This layout runs commands or opens URLs:',
  'import.target': '  {kind}: {target}',
  'import.keepPrompt': { one: 'Keep this item?', other: 'Keep these {count} items?' },
  'import.targetsDropped': {
    one: 'Dropped {count} command/URL item.',
    other: 'Dropped {count} command/URL items.',
  },
  'import.rerun': 'To keep them, run: {command}',
  'import.rerunAddFile': 'To keep them, run: {command} (add --file with the path of the source file)',
  'import.rerunAddCommand':
    'To keep them, run: {command} (add --command with your previous status line command)',
  'import.rerunAddBoth':
    'To keep them, run: {command} (add --file with the path of the source file and --command with your previous status line command)',
  'import.spaces': '\u27e8{count} spaces\u27e9',
  'import.targetLong': '  {kind}: {count} characters, too long to review, dropped',
  'import.note.targetTooLong':
    '{kind} with {count} characters was dropped (too long to review, --allow-commands keeps it)',
  'import.approxHeader': 'Approximated:',
  'import.dropHeader': 'Dropped:',
  'import.infoHeader': 'Notes:',
  'import.dryRunHeader': 'Preview with sample data:',
  'import.dryRunDone': 'Dry run: nothing was written.',
} as const;
