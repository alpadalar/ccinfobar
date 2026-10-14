import type { LoadResult } from '../core/config.js';
import { t } from '../core/i18n/index.js';
import { tildify } from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';

export interface CliIo {
  tty: boolean;
  log(line: string): void;
  error(line: string): void;
}

export function cliIo(): CliIo {
  return {
    tty: !!process.stdout.isTTY,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

export function reportConfigIssue(loaded: LoadResult, io: CliIo): boolean {
  if (!loaded.issue) return false;
  const { line, column, message } = loaded.issue;
  io.error(
    t('config.issue', {
      file: sanitizeText(tildify(loaded.path)),
      line,
      column,
      message: sanitizeText(message),
    }),
  );
  io.error(t('explain.runDoctor'));
  return true;
}
