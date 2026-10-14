import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SettingsFixtureOpts {
  data?: unknown;
  text?: string;
  bom?: boolean;
  eol?: '\n' | '\r\n';
  indent?: string;
  finalNewline?: boolean;
  mode?: number;
  symlink?: boolean;
}

export interface SettingsFixture {
  dir: string;
  file: string;
  real: string;
  linked: boolean;
  env: NodeJS.ProcessEnv;
}

export function formatJson(
  data: unknown,
  o: Pick<SettingsFixtureOpts, 'bom' | 'eol' | 'indent' | 'finalNewline'> = {},
): string {
  const eol = o.eol ?? '\n';
  let s = JSON.stringify(data, null, o.indent ?? '  ');
  if (eol === '\r\n') s = s.replace(/\n/g, '\r\n');
  return `${o.bom ? '﻿' : ''}${s}${o.finalNewline === false ? '' : eol}`;
}

// symlink: file -> dotfiles/settings.json; linked false where symlinks need privileges
export function settingsFixture(opts: SettingsFixtureOpts = {}): SettingsFixture {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-settings-')));
  const file = path.join(dir, 'settings.json');
  let real = file;
  let linked = false;
  if (opts.symlink) {
    const target = path.join(dir, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.symlinkSync(target, file);
      real = target;
      linked = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
    }
  }
  const text = opts.text ?? (opts.data === undefined ? null : formatJson(opts.data, opts));
  if (text !== null) {
    fs.writeFileSync(real, text);
    if (opts.mode !== undefined) fs.chmodSync(real, opts.mode);
  }
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: dir,
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
  };
  return { dir, file, real, linked, env };
}
