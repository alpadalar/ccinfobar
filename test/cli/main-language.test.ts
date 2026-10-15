import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configLanguage } from '../../src/cli/lang.js';
import { main } from '../../src/cli/main.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { startEditor } from '../../src/editor/server.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function configFile(body: string): string {
  const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'main-lang-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, body);
  return file;
}

async function capture(argv: string[]): Promise<string> {
  const out: string[] = [];
  const push = (s: unknown) => void out.push(String(s));
  vi.spyOn(console, 'log').mockImplementation(push);
  vi.spyOn(console, 'error').mockImplementation(push);
  await main(argv);
  vi.restoreAllMocks();
  return out.join('\n');
}

describe('configLanguage', () => {
  it.each([
    ['{"language":"tr"}', { language: 'tr' }],
    ['{"language":"TR"}', { language: 'tr' }],
    ['{"language":"auto"}', undefined],
    ['{"language":"xx"}', undefined],
    ['{}', undefined],
    ['{"language":"tr","lines":{}}', undefined],
    ['{"language":"tr",', undefined],
  ])('%s gives %j', (body, want) => {
    expect(configLanguage(configFile(body))).toEqual(want);
  });

  it('is undefined for a missing file', () => {
    expect(configLanguage(path.join(process.env.CCIB_TEST_ROOT!, 'nope', 'config.json'))).toBeUndefined();
  });
});

describe('main applies the config language once', () => {
  const tr = () => configFile('{"language":"tr"}');

  it('lists widgets in the config language', async () => {
    const en = await capture(['widgets', '--config', configFile('{}')]);
    const out = await capture(['widgets', '--config', tr()]);
    expect(out).not.toBe(en);
    expect(out).toContain('Git');
  });

  it('names an unknown init preset in the config language', async () => {
    const out = await capture(['init', 'nope', '--config', tr()]);
    expect(out).toContain('Bilinmeyen hazır ayar "nope"');
  });

  it.each(['preview', 'explain', 'bench'])('lists %s scenarios in the config language', async (cmd) => {
    const out = await capture([cmd, '--scenario', '--config', tr()]);
    expect(out.split('\n')[0]).toBe('Senaryolar (--scenario <name> ile kullanın):');
  });

  it('reports an unknown scenario in the config language', async () => {
    const out = await capture(['preview', '--scenario', 'nope', '--config', tr()]);
    expect(out).toContain('Bilinmeyen senaryo "nope". Senaryolar:');
  });

  it('keeps the env language for help and a broken config', async () => {
    let help = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      help += String(s);
      return true;
    });
    await main(['help', '--config', tr()]);
    vi.restoreAllMocks();
    expect(help).toContain('A customizable, GSD-aware status line');
    const broken = await capture(['init', 'nope', '--config', configFile('{"language":"tr",')]);
    expect(broken).toContain('Unknown preset "nope"');
  });

  it('prints the editor console lines in the cli language', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => void out.push(String(s)));
    setLanguage('tr');
    const handle = await startEditor({ configPath: configFile('{}'), open: false, port: 0 });
    await handle.close();
    expect(out.join('\n')).toContain('ccinfobar editörü çalışıyor');
  });
});
