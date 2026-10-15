export const importMessages = {
  'import.cannotRead': 'Cannot read ccstatusline settings at {file}',
  'import.cannotParse': 'Cannot parse claude-powerline config at {file}',
  'import.tooLarge': '{file} is larger than 1 MB and was not read',
  'import.tool.gsd': 'GSD status line',
  'import.tool.custom': 'a custom status line',
  'import.note.noEquivalent': '{tool} widget "{name}" has no ccinfobar equivalent and was skipped',
  'import.note.noSegment': '{tool} segment "{name}" has no ccinfobar equivalent and was skipped',
  'import.note.customColors': 'custom {tool} colors were copied onto each widget',
  'import.note.defaultLayout': 'no {tool} config file found, imported its default layout',
  'import.note.hideState': '{name}: hiding when "{state}" is not supported, it stays visible',
} as const;
