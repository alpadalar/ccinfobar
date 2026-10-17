import '../core/i18n/lazy.js';
import { t } from '../core/i18n/index.js';
import { padVisible, visibleWidth } from '../core/width.js';
import { importerList } from '../importers/registry.js';

export function importHelp(): string {
  const list = importerList().map((i) => [
    [i.source, ...(i.aliases ?? [])].join(', '),
    `${i.name} (${i.repo})`,
    i.shown ?? t('import.help.fromCommand'),
  ]);
  const ids = Math.max(...list.map((r) => visibleWidth(r[0]!)));
  const names = Math.max(...list.map((r) => visibleWidth(r[1]!)));
  return [
    t('import.help.title'),
    t('cmd.import.usage'),
    '',
    t('import.help.tools'),
    ...list.map(([id, name, file]) => `  ${padVisible(id!, ids)}  ${padVisible(name!, names)}  ${file}`),
    '',
    t('import.help.footer'),
    '',
  ].join('\n');
}
