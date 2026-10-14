import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Args } from '../../src/cli/args.js';
import { runInit, runTheme } from '../../src/commands/manage.js';
import { ConfigBrokenError, defaultConfig, loadConfig, saveConfig } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-guard-'));

function withFile(text: string): string {
  const file = path.join(tmp(), 'config.json');
  fs.writeFileSync(file, text);
  return file;
}

const args = (positional: string[], flags: Args['flags'] = {}) => ({ positional, flags }) as Args;

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('loadConfig issues', () => {
  it('strips a UTF-8 BOM', () => {
    const loaded = loadConfig(withFile('﻿{"version":1,"lines":[]}'));
    expect(loaded.issue).toBeUndefined();
    expect(loaded.error).toBeUndefined();
    expect(loaded.exists).toBe(true);
  });

  it('locates a parse error', () => {
    const loaded = loadConfig(withFile('{\n "lines": [\n],\n}'));
    expect(loaded.issue).toEqual({ kind: 'parse', line: 4, column: 1, message: t('json.trailingComma') });
    expect(loaded.error).toBe(t('json.trailingComma'));
    expect(loaded.config).toEqual(defaultConfig());
  });

  it('flags a non-object root', () => {
    const loaded = loadConfig(withFile('[]'));
    expect(loaded.issue).toMatchObject({ kind: 'structure', line: 1, message: t('config.notObject') });
  });

  it('flags lines that is not an array at the key', () => {
    const loaded = loadConfig(withFile('{\n  "lines": {}\n}'));
    expect(loaded.issue).toMatchObject({ kind: 'structure', line: 2, message: t('config.linesNotArray') });
  });

  it('stays lenient about unknown widgets', () => {
    const loaded = loadConfig(withFile('{"lines":[[{"type":"no-such-widget"}]]}'));
    expect(loaded.issue).toBeUndefined();
  });
});

describe('saveConfig guard', () => {
  it('refuses to overwrite a broken file', () => {
    const file = withFile('{bad');
    let caught: unknown;
    try {
      saveConfig(defaultConfig(), file);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigBrokenError);
    expect((caught as ConfigBrokenError).issue.line).toBe(1);
    expect((caught as ConfigBrokenError).file).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('{bad');
  });

  it('refuses a structurally broken file', () => {
    const file = withFile('{"lines":{}}');
    expect(() => saveConfig(defaultConfig(), file)).toThrow(ConfigBrokenError);
  });

  it('overwrites when asked', () => {
    const file = withFile('{bad');
    saveConfig(defaultConfig(), file, { overwriteBroken: true });
    expect(loadConfig(file).issue).toBeUndefined();
  });

  it('writes missing and valid files as before', () => {
    const file = path.join(tmp(), 'config.json');
    saveConfig({ ...defaultConfig(), separator: ' / ' }, file);
    expect(loadConfig(file).config.separator).toBe(' / ');
    saveConfig({ ...defaultConfig(), separator: ' | ' }, file);
    expect(loadConfig(file).config.separator).toBe(' | ');
  });
});

describe('manage commands on a broken config', () => {
  it('init --force backs up the broken file, then overwrites it', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = withFile('{bad');
    runInit(args(['default'], { force: true }), file);
    expect(loadConfig(file).issue).toBeUndefined();
    const baks = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.bak'));
    expect(baks).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), baks[0]!), 'utf8')).toBe('{bad');
  });

  it('theme refuses and keeps the bytes', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = withFile('{\n  "theme": "x",\n}');
    runTheme(args(['powerline']), file);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "theme": "x",\n}');
    expect(String(err.mock.calls[0]?.[0])).toContain('line 3, column 1');
  });
});
