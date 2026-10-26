import '../core/i18n/lazy.js';
import { encodeShare } from '../catalog/share-code.js';
import type { Args } from '../cli/args.js';
import { t, withLanguage } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { sanitizeText } from '../core/sanitize.js';
import { MAX_CODE_CHARS } from '../core/share-code.js';
import { kindText, shortTarget } from '../importers/confirm.js';
import { type CliIo, cliIo, reportConfigIssue } from './io.js';

export function runShare(args: Args, cfgFile: string, io: CliIo = cliIo()): void {
  const loaded = loadForUse(cfgFile);
  if (reportConfigIssue(loaded, io)) {
    process.exitCode = 1;
    return;
  }
  if (loaded.error) {
    io.error(`✗ ${t('share.failed', { error: sanitizeText(loaded.error) })}`);
    process.exitCode = 1;
    return;
  }
  const included = args.flags['include-commands'] === true;
  const r = encodeShare(loaded.config, { includeCommands: included });
  if (!r.ok) {
    io.error(`✗ ${t(r.errorId, r.params)}`);
    process.exitCode = 1;
    return;
  }
  if (args.flags.json === true) {
    const dropped = r.dropped.map((x) => ({ kind: x.kind, target: x.target }));
    io.log(
      withLanguage('en', () =>
        JSON.stringify({ schema: 1, code: r.code, chars: r.chars, max: MAX_CODE_CHARS, included, dropped }),
      ),
    );
    return;
  }
  io.log(r.code);
  io.error(t('share.size', { chars: r.chars }));
  for (const x of r.dropped)
    io.error(t('share.dropped', { kind: kindText(x.kind), target: shortTarget(x.target) }));
  if (r.dropped.length) io.error(t('share.includeHint'));
  io.error(t('share.openHint'));
}
