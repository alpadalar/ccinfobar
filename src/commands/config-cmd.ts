import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Args } from '../cli/args.js';
import {
  ConfigBrokenError,
  type ConfigIssue,
  inspectConfigText,
  normalizeConfig,
  saveConfig,
} from '../core/config.js';
import { getPath, PathError, type PathSegment, parsePath, setPath, unsetPath } from '../core/config-path.js';
import { t } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { tildify } from '../core/paths.js';

export interface ConfigIo {
  out(s: string): void;
  err(s: string): void;
}

const STD_IO: ConfigIo = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => console.error(s),
};

const SUBCOMMANDS = ['get', 'set', 'unset'];

const plain = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function runConfig(args: Args, cfgFile: string, io: ConfigIo = STD_IO): void {
  const fail = (msg: string) => {
    io.err(msg);
    process.exitCode = 1;
  };
  const broken = (issue: ConfigIssue) =>
    fail(t('cfg.brokenFile', { file: tildify(cfgFile), line: issue.line, column: issue.column }));

  const [sub, pathText, valueText] = args.positional;
  if (!sub || !SUBCOMMANDS.includes(sub) || !pathText || (sub === 'set' && valueText === undefined)) {
    fail(t('cfg.usage'));
    return;
  }

  let path: PathSegment[];
  try {
    path = parsePath(pathText);
  } catch (e) {
    const segment = e instanceof PathError && e.code === 'protoSegment' ? e.segment : undefined;
    fail(segment ? t('cfg.protoSegment', { segment }) : t('cfg.badPath', { path: pathText }));
    return;
  }

  let text: string | null = null;
  try {
    text = fs.readFileSync(cfgFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      fail(t('cfg.readError', { file: tildify(cfgFile), message: (e as Error).message }));
      return;
    }
  }
  const inspected = text === null ? null : inspectConfigText(text);
  if (inspected?.issue) {
    broken(inspected.issue);
    return;
  }

  try {
    const loaded = loadForUse(cfgFile);
    if (loaded.issue) {
      broken(loaded.issue);
      return;
    }
    // no file yet: start from what the user sees
    const raw = inspected ? inspected.raw : plain(loaded.config);

    if (sub === 'get') {
      const got = getPath(loaded.config, path);
      if (!got.found || got.value === undefined) {
        fail(t('cfg.missing', { path: pathText }));
        return;
      }
      io.out(typeof got.value === 'string' ? got.value : JSON.stringify(got.value, null, 2));
      return;
    }

    if (sub === 'set') {
      const value = parseValue(valueText!);
      const normalized = normalizeConfig(setPath(raw, path, value));
      const got = getPath(normalized, path);
      if (!got.found || !isDeepStrictEqual(plain(got.value), plain(value))) {
        fail(t('cfg.rejected', { path: pathText }));
        return;
      }
      saveConfig(normalized, cfgFile);
      io.out(t('cfg.set', { path: pathText }));
      return;
    }

    const removed = unsetPath(raw, path);
    if (!removed.found) {
      fail(t('cfg.missing', { path: pathText }));
      return;
    }
    const normalized = normalizeConfig(removed.value);
    const parent = getPath(raw, path.slice(0, -1)).value;
    const back = Array.isArray(parent) ? { found: false, value: undefined } : getPath(normalized, path);
    saveConfig(normalized, cfgFile);
    io.out(
      back.found && back.value !== undefined
        ? t('cfg.resetDefault', { path: pathText, value: JSON.stringify(back.value) })
        : t('cfg.unset', { path: pathText }),
    );
  } catch (e) {
    if (e instanceof ConfigBrokenError) broken(e.issue);
    else if (e instanceof PathError) fail(t('cfg.badPath', { path: pathText }));
    else fail(t('cfg.writeError', { file: tildify(cfgFile), message: (e as Error).message }));
  }
}
