import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { install, uninstall } from '../../src/commands/install.js';

const settingsFile = (data: object | null) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-install-'));
  const file = path.join(dir, 'settings.json');
  if (data) fs.writeFileSync(file, JSON.stringify(data));
  return file;
};
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('install and uninstall', () => {
  it('backs up once, keeps other settings and restores the previous status line', () => {
    const previous = { type: 'command', command: '/usr/bin/ccstatusline', padding: 0 };
    const file = settingsFile({ model: 'opus', statusLine: previous });
    expect(install('/bin/ccinfobar', 10, file)).toBe(`${file}.ccinfobar-backup`);
    install('/bin/ccinfobar', 10, file);
    expect(read(`${file}.ccinfobar-backup`).statusLine).toEqual(previous);
    expect(read(file)).toEqual({
      model: 'opus',
      statusLine: { type: 'command', command: '/bin/ccinfobar', padding: 0, refreshInterval: 10 },
    });
    expect(uninstall(file)).toEqual({ removed: true, restored: previous });
    expect(read(file)).toEqual({ model: 'opus', statusLine: previous });
    expect(uninstall(file)).toEqual({ removed: false });
  });

  it('removes the status line when there was none before', () => {
    const file = settingsFile(null);
    expect(install('ccinfobar', undefined, file)).toBeNull();
    expect(uninstall(file)).toEqual({ removed: true, restored: null });
    expect(read(file)).toEqual({});
  });
});
