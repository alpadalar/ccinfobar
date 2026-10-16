export const reportMessages = {
  'report.col.day': 'Day',
  'report.col.week': 'Week',
  'report.col.month': 'Month',
  'report.col.project': 'Project',
  'report.col.sessions': 'Sessions',
  'report.col.input': 'Input',
  'report.col.output': 'Output',
  'report.col.cacheRead': 'Cache read',
  'report.col.cacheWrite': 'Cache write',
  'report.col.total': 'Total',
  'report.col.cost': 'Cost (est.)',
  'report.col.active': 'Active',
  'report.subtotal': 'subtotal',
  'report.total': 'total',
  'report.partialMark': '*',
  'report.tokensMark': '+',
  'report.empty': 'No usage found in {dir}',
  'report.badPeriod': 'Unknown period "{value}". Use day, week or month.',
  'report.badSince':
    'Bad --since value "{value}". Use YYYY-MM-DD or a count of days, weeks or months (7d, 4w, 3m).',
  'report.badUntil':
    'Bad --until value "{value}". Use YYYY-MM-DD or a count of days, weeks or months (7d, 4w, 3m).',
  'report.badOrder': 'The start date {value} is after the end date.',
  'report.badFormat': 'Unknown format "{value}". Use table, csv or json.',
  'report.formatConflict': 'Pick one output format: --format, --csv or --json.',
  'report.projectValue': '--project needs a value: part of a project path, or "." for the current project.',
  'report.progress': {
    one: 'Scanning transcripts: {count} file, {mb} MB',
    other: 'Scanning transcripts: {count} files, {mb} MB',
  },
  'report.rebuilt': {
    one: 'Rebuilt the cost ledger summary and re-read {count} transcript',
    other: 'Rebuilt the cost ledger summary and re-read {count} transcripts',
  },
  'report.reread': {
    one: 'Re-read {count} transcript; there is no cost ledger to rebuild yet',
    other: 'Re-read {count} transcripts; there is no cost ledger to rebuild yet',
  },
  'report.rebuildFailed': 'Could not rewrite the cost ledger summary.',
  'report.keptDeleted': {
    one: 'Kept history of {count} deleted transcript',
    other: 'Kept history of {count} deleted transcripts',
  },
  'report.note.estimate': 'Costs are estimates at list prices; on a subscription they are not what you pay.',
  'report.note.ledger-since':
    'The cost ledger starts on {date}; earlier costs are estimated from transcripts.',
  'report.note.unpriced': {
    one: 'No price for {models} ({count} request); its cost is not counted.',
    other: 'No price for {models} ({count} requests); their cost is not counted.',
  },
  'report.note.non-usd': 'Costs in {currency} are not in the USD totals: {amount}.',
  'report.note.profile-price': 'Prices for {vendor} models come from the built-in {vendor} profile.',
  'report.note.partial': '* Partial cost: the ledger joined late or some requests have no price.',
  'report.note.approx-project': {
    one: '{count} session has its project guessed from a folder name.',
    other: '{count} sessions have their project guessed from a folder name.',
  },
  'report.note.ledger-only': {
    one: '{count} session has a cost but no transcript left, so tokens and time show —.',
    other: '{count} sessions have a cost but no transcript left, so tokens and time show —.',
  },
  'report.note.tokens-partial':
    '+ Tokens and time leave out sessions in the row that have a cost but no transcript left.',
  'report.note.file-cap': {
    one: 'Stopped after {count} transcript file; some usage may be missing.',
    other: 'Stopped after {count} transcript files; some usage may be missing.',
  },
  'report.note.line-skipped': {
    one: '{count} oversized transcript line was skipped.',
    other: '{count} oversized transcript lines were skipped.',
  },
  'report.note.deleted-transcripts': {
    one: '{count} deleted transcript is still counted from the report index.',
    other: '{count} deleted transcripts are still counted from the report index.',
  },
  'report.note.rebuild-kept': {
    one: 'The rebuild kept {count} deleted transcript from the old index.',
    other: 'The rebuild kept {count} deleted transcripts from the old index.',
  },
  'report.note.keys-lost': {
    one: 'The report index lost its request keys, so requests copied from {count} deleted transcript may be counted twice.',
    other:
      'The report index lost its request keys, so requests copied from {count} deleted transcripts may be counted twice.',
  },
  'report.note.old-zone': {
    one: '{count} deleted transcript keeps its days in the time zone it was read in.',
    other: '{count} deleted transcripts keep their days in the time zone they were read in.',
  },
} as const;
