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

export const plainOutput = (tty: boolean, env: NodeJS.ProcessEnv = process.env): boolean => {
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0';
  return (!tty && !forced) || !!env.NO_COLOR || env.FORCE_COLOR === '0';
};

export const promptMarker = (fallback: boolean) => t(fallback ? 'install.prompt.yes' : 'install.prompt.no');

// y/yes and e/evet in any language
export function isYes(raw: string, fallback: boolean): boolean {
  const answer = raw.trim().toLowerCase();
  return answer === '' ? fallback : answer.startsWith('y') || answer.startsWith('e');
}

export async function ask(question: string, fallback: boolean): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback;
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return isYes(await rl.question(`${question} ${promptMarker(fallback)} `), fallback);
  } finally {
    rl.close();
  }
}

export interface PromptIo extends CliIo {
  ask(question: string, fallback: boolean): Promise<boolean>;
  columns?: number;
}

export function promptIo(): PromptIo {
  return {
    tty: !!process.stdin.isTTY && !!process.stdout.isTTY,
    ask,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    ...(process.stdout.columns ? { columns: process.stdout.columns } : {}),
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
