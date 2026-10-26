import { type MessageId, t } from '../core/i18n/index.js';
import { PRESETS } from '../core/presets.js';
import { VERSION } from '../core/version.js';
import { padVisible, visibleWidth } from '../core/width.js';

type Row = [usage: string, text: MessageId];

export const USAGE: Row[] = [
  ['ccinfobar', 'help.cmd.render'],
  ['ccinfobar edit', 'help.cmd.edit'],
  ['ccinfobar edit --detach', 'help.cmd.editDetach'],
  ['ccinfobar edit --open <code>', 'help.cmd.editOpen'],
  ['ccinfobar tui', 'help.cmd.tui'],
  ['ccinfobar install', 'help.cmd.install'],
  ['ccinfobar install --project', 'help.cmd.installProject'],
  ['ccinfobar install --no-global', 'help.cmd.installNoGlobal'],
  ['ccinfobar install --dry-run', 'help.cmd.installDryRun'],
  ['ccinfobar install --hooks', 'help.cmd.installHooks'],
  ['ccinfobar install --progress', 'help.cmd.installProgress'],
  ['ccinfobar uninstall', 'help.cmd.uninstall'],
  ['ccinfobar uninstall --hooks', 'help.cmd.uninstallHooks'],
  ['ccinfobar uninstall --progress', 'help.cmd.uninstallProgress'],
  ['ccinfobar import <tool>', 'help.cmd.import'],
  ['ccinfobar import <tool> --dry-run', 'help.cmd.importDryRun'],
  ['ccinfobar themes', 'help.cmd.themes'],
  ['ccinfobar themes --list', 'help.cmd.themesList'],
  ['ccinfobar theme <id>', 'help.cmd.theme'],
  ['ccinfobar theme new <id>', 'help.cmd.themeNew'],
  ['ccinfobar theme rotate <id...> [--every hour|day|week|<min>] [--shuffle]', 'help.cmd.themeRotate'],
  ['ccinfobar theme rotate --weekdays mon=nord,...', 'help.cmd.themeRotateWeekdays'],
  ['ccinfobar theme rotate off', 'help.cmd.themeRotateOff'],
  ['ccinfobar init [preset]', 'help.cmd.init'],
  ['ccinfobar catalog list|show|history', 'help.cmd.catalog'],
  ['ccinfobar catalog install <publisher>/<slug>', 'help.cmd.catalogInstall'],
  ['ccinfobar catalog apply <ref|code>|save <name>', 'help.cmd.catalogSave'],
  ['ccinfobar catalog publish', 'help.cmd.catalogPublish'],
  ['ccinfobar catalog login|logout', 'help.cmd.catalogLogin'],
  ['ccinfobar share', 'help.cmd.share'],
  ['ccinfobar preview', 'help.cmd.preview'],
  ['ccinfobar preview --scenario <name>', 'help.cmd.previewScenario'],
  ['ccinfobar preview --glyph-mode <mode>', 'help.cmd.previewGlyphMode'],
  ['ccinfobar update', 'help.cmd.update'],
  ['ccinfobar usage', 'help.cmd.usage'],
  ['ccinfobar widgets', 'help.cmd.widgets'],
  ['ccinfobar doctor', 'help.cmd.doctor'],
  ['ccinfobar explain [widget-id]', 'help.cmd.explain'],
  ['ccinfobar explain --scenario <name>', 'help.cmd.explainScenario'],
  ['ccinfobar bench', 'help.cmd.bench'],
  ['ccinfobar report', 'help.cmd.report'],
  ['ccinfobar report --period day|week|month', 'help.cmd.reportPeriod'],
  ['ccinfobar report --csv|--json', 'help.cmd.reportFormat'],
  ['ccinfobar report --rebuild', 'help.cmd.reportRebuild'],
  ['ccinfobar config get <path>', 'help.cmd.configGet'],
  ['ccinfobar config set <path> <value>', 'help.cmd.configSet'],
  ['ccinfobar config unset <path>', 'help.cmd.configUnset'],
  ['ccinfobar hook <Event>', 'help.cmd.hook'],
];

export const OPTIONS: Row[] = [
  ['--config <file>', 'help.opt.config'],
  ['--payload <file>', 'help.opt.payload'],
  ['--width <n>', 'help.opt.width'],
  ['--scenario <name>', 'help.opt.scenario'],
  ['--runs <n>', 'help.opt.runs'],
  ['--json', 'help.opt.json'],
  ['--csv', 'help.opt.csv'],
  ['--show-values', 'help.opt.showValues'],
  ['--refresh <seconds>', 'help.opt.refresh'],
  ['--project', 'help.opt.project'],
  ['--project <filter>', 'help.opt.reportProject'],
  ['--since <date> / --until <date>', 'help.opt.since'],
  ['--all', 'help.opt.all'],
  ['--format table|csv|json', 'help.opt.format'],
  ['--import / --no-import', 'help.opt.import'],
  ['--file <path>', 'help.opt.file'],
  ['--allow-commands', 'help.opt.allowCommands'],
  ['--include-commands', 'help.opt.includeCommands'],
  ['--command <cmd>', 'help.opt.command'],
  ['--hooks[=permission]', 'help.opt.hooks'],
  ['--progress', 'help.opt.progress'],
  ['-y, --yes', 'help.opt.yes'],
  ['--dry-run', 'help.opt.dryRun'],
  ['--port <n>', 'help.opt.port'],
  ['--detach', 'help.opt.detach'],
  ['--no-open', 'help.opt.noOpen'],
  ['--no-detect', 'help.opt.noDetect'],
  ['--list', 'help.opt.list'],
  ['-v, --version', 'help.opt.version'],
  ['-h, --help', 'help.opt.help'],
];

const COL = 32;
const INDENT = ' '.repeat(COL + 2);

function rows(list: Row[], presets: string): string[] {
  const out: string[] = [];
  for (const [usage, id] of list) {
    const [first = '', ...rest] = t(id, { presets }).split('\n');
    // at least two spaces before the description
    if (visibleWidth(usage) <= COL - 2) out.push(`  ${padVisible(usage, COL)}${first}`);
    else out.push(`  ${usage}`, INDENT + first);
    for (const line of rest) out.push(INDENT + line);
  }
  return out;
}

export function help(): string {
  const presets = PRESETS.map((p) => p.id).join(', ');
  return [
    t('help.title', { version: VERSION }),
    t('help.tagline'),
    '',
    t('help.usage'),
    ...rows(USAGE, presets),
    '',
    t('help.options'),
    ...rows(OPTIONS, presets),
    '',
  ].join('\n');
}
