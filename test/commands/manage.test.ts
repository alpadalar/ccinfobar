import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import {
  runImport,
  runImportCommand,
  runInit,
  runTheme,
  runWidgets,
  usageLines,
} from '../../src/commands/manage.js';
import { usageErrorText } from '../../src/commands/usage-error.js';
import { tildify } from '../../src/core/paths.js';
import { listPresets } from '../../src/core/presets.js';
import type { UsageCache } from '../../src/data/usage.js';
import { withEnvLang, withLang } from '../helpers.js';

const root = path.join(process.env.CCINFOBAR_CONFIG_DIR!, 'manage');
const fixture = path.join(__dirname, '../fixtures/import/ccstatusline-settings.json');

const file = (name: string, text?: string): string => {
  fs.mkdirSync(root, { recursive: true });
  const f = path.join(root, name);
  if (text !== undefined) fs.writeFileSync(f, text);
  return f;
};

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

const capture = (fn: () => void) => {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  const error = vi
    .spyOn(console, 'error')
    .mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  try {
    fn();
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = undefined;
  }
  return { out, err };
};

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('init', () => {
  const init = (f: string, ...argv: string[]) => runInit(parseArgs(['init', ...argv]), f);

  it('keeps the current language when --force replaces the config', () => {
    const f = file('tr.json', JSON.stringify({ language: 'tr', lines: [[{ type: 'model' }]] }));
    capture(() => init(f, 'minimal', '--force'));
    expect(read(f).language).toBe('tr');
    expect(read(f).lines).not.toEqual([[{ type: 'model' }]]);
  });

  it('adds no language when the old config had none, or was broken', () => {
    const plain = file('plain.json', JSON.stringify({ lines: [] }));
    capture(() => init(plain, 'default', '--force'));
    expect(read(plain)).not.toHaveProperty('language');
    const broken = file('broken.json', '{"language": "tr", "lines": [');
    capture(() => init(broken, 'default', '--force'));
    expect(read(broken)).not.toHaveProperty('language');
    const fresh = file('fresh.json');
    capture(() => init(fresh, 'default'));
    expect(read(fresh)).not.toHaveProperty('language');
  });

  it('prints English and Turkish with the preset name translated and paths unchanged', () => {
    const f = file('words.json', '{}');
    const en = capture(() => init(f, 'default', '--force'));
    expect(en.out[0]).toBe(`✓ Wrote "Default" preset to ${tildify(f)}`);
    expect(en.out[1]).toMatch(/^ {2}Previous config: .+\.bak$/);
    const tr = withLang('tr', () => capture(() => init(f, 'default', '--force')));
    expect(tr.out[0]).toBe(`✓ "Varsayılan" hazır ayarı ${tildify(f)} dosyasına yazıldı`);
    expect(tr.out[1]).toMatch(/^ {2}Önceki yapılandırma: .+\.bak$/);
  });

  it('refuses an existing config and an unknown preset in both languages', () => {
    const f = file('exists.json', '{}');
    expect(capture(() => init(f, 'default')).err).toEqual([
      `${tildify(f)} already exists. Use --force to overwrite.`,
    ]);
    expect(withLang('tr', () => capture(() => init(f, 'default')).err)).toEqual([
      `${tildify(f)} zaten var. Üzerine yazmak için --force kullanın.`,
    ]);
    const ids = listPresets()
      .map((p) => p.id)
      .join(', ');
    expect(capture(() => init(f, 'nope')).err).toEqual([`Unknown preset "nope". Available: ${ids}`]);
    expect(withLang('tr', () => capture(() => init(f, 'nope\u001b[2J')).err)).toEqual([
      `Bilinmeyen hazır ayar "nope". Mevcut olanlar: ${ids}`,
    ]);
  });
});

describe('import', () => {
  it('reports in English and Turkish and keeps the language', () => {
    const f = file('import.json', JSON.stringify({ language: 'tr', lines: [] }));
    const en = capture(() => runImport('ccstatusline', { file: fixture, command: '' }, f));
    expect(en.out[0]).toMatch(/^✓ Imported \d+ widgets from ccstatusline \(.+ccstatusline-settings\.json\)$/);
    expect(en.out[1]).toMatch(/^ {2}Previous ccinfobar config: .+\.bak$/);
    expect(read(f).language).toBe('tr');
    const tr = withLang('tr', () =>
      capture(() => runImport('ccstatusline', { file: fixture, command: '' }, f)),
    );
    expect(tr.out[0]).toMatch(/^✓ ccstatusline kaynağından \d+ bileşen içe aktarıldı \(.+\.json\)$/);
    expect(tr.out[1]).toMatch(/^ {2}Önceki ccinfobar yapılandırması: /);
  });

  it('prints notes after the imported line and resolves tool names', () => {
    const src = file(
      'cc.json',
      JSON.stringify({
        lines: [
          [
            { id: '1', type: 'git-branch', metadata: { hide: 'no-git,zero' } },
            { id: '2', type: 'jj-revision' },
          ],
        ],
      }),
    );
    const f = path.join(root, 'notes.json');
    const out = capture(() => runImport('ccstatusline', { file: src, command: '' }, f)).out;
    expect(out).toEqual([
      `✓ Imported 1 widgets from ccstatusline (${tildify(src)})`,
      '  ⚠ git-branch: hiding when "zero" is not supported, it stays visible',
      '  ⚠ ccstatusline widget "jj-revision" has no ccinfobar equivalent and was skipped',
    ]);
    const g = path.join(root, 'upper.json');
    const upper = capture(() => runImportCommand(parseArgs(['import', 'CCSTATUSLINE', '--file', src]), g));
    expect(upper.err).toEqual([]);
    expect(read(g).lines[0]).toEqual([{ id: '1', type: 'git-branch' }]);
  });

  it('translates the failure, usage and exists lines', () => {
    const f = file('fail.json');
    const missing = path.join(root, 'none.json');
    const en = capture(() => runImport('ccstatusline', { file: missing, command: '' }, f));
    expect(en.err[0]).toBe(`✗ Import failed: Cannot read ccstatusline settings at ${missing}`);
    const tr = withLang('tr', () =>
      capture(() => runImport('ccstatusline', { file: missing, command: '' }, f)),
    );
    expect(tr.err[0]).toMatch(/^✗ İçe aktarma başarısız oldu: /);
    const cmd = (...argv: string[]) => runImportCommand(parseArgs(['import', ...argv]), f);
    expect(capture(() => cmd('nope')).err).toEqual([
      'Usage: ccinfobar import <ccstatusline|claude-powerline> [--file <path>] [--force]',
    ]);
    expect(withLang('tr', () => capture(() => cmd('nope')).err)).toEqual([
      'Kullanım: ccinfobar import <ccstatusline|claude-powerline> [--file <path>] [--force]',
    ]);
    let code: typeof process.exitCode;
    capture(() => {
      runImportCommand(parseArgs(['import', 'ccstatusline', '--file', missing]), path.join(root, 'n.json'));
      code = process.exitCode;
    });
    expect(code).toBe(1);
    const old = file('old.json', '{}');
    expect(capture(() => runImportCommand(parseArgs(['import', 'ccstatusline']), old)).err).toEqual([
      `${tildify(old)} already exists. Use --force to replace it (a backup is kept).`,
    ]);
  });
});

describe('theme', () => {
  const theme = (f: string, ...argv: string[]) => runTheme(parseArgs(['theme', ...argv]), f);

  it('prints the current theme and unknown theme in both languages', () => {
    const f = file('theme.json', JSON.stringify({ theme: 'nord', lines: [] }));
    const en = capture(() => theme(f));
    expect(en.out).toEqual(['Nord (nord), style powerline', 'Run `ccinfobar themes` to see all themes.']);
    const tr = withEnvLang('tr', () => capture(() => theme(f)));
    expect(tr.out).toEqual([
      'Nord (nord), stil powerline',
      'Tüm temaları görmek için `ccinfobar themes` çalıştırın.',
    ]);
    expect(capture(() => theme(f, 'nope')).err).toEqual([
      'Unknown theme "nope". Run `ccinfobar themes` to list them.',
    ]);
    expect(withEnvLang('tr', () => capture(() => theme(f, 'nope')).err)).toEqual([
      'Bilinmeyen tema "nope". Temaları listelemek için `ccinfobar themes` çalıştırın.',
    ]);
  });

  it('sets a theme with the name unchanged', () => {
    const f = file('set.json', JSON.stringify({ lines: [] }));
    expect(capture(() => theme(f, 'nord')).out[0]).toBe('✓ Theme set to Nord');
    expect(withEnvLang('tr', () => capture(() => theme(f, 'classic')).out[0])).toMatch(
      /^✓ Tema .+ olarak ayarlandı$/,
    );
  });
});

describe('widgets', () => {
  // description column per category block
  const columns = (out: string[]) => {
    const blocks: number[][] = [];
    for (const line of out) {
      if (line.startsWith('\n')) blocks.push([]);
      else blocks.at(-1)!.push(/^ {2}\S+ +/.exec(line)![0].length);
    }
    return blocks;
  };

  it('starts every description at the same column in English and Turkish', () => {
    for (const lang of ['en', 'tr'] as const) {
      const out = withLang(lang, () => capture(() => runWidgets(parseArgs(['widgets']), '')).out);
      const blocks = columns(out);
      expect(blocks.length).toBeGreaterThan(3);
      for (const b of blocks) expect(new Set(b).size, lang).toBe(1);
    }
  });

  it('prints translated category headings and keeps the types', () => {
    const run = () => capture(() => runWidgets(parseArgs(['widgets']), '')).out.join('\n');
    const en = run();
    const tr = withLang('tr', run);
    expect(en).toContain('\nContext window\n');
    expect(tr).toContain('\nBağlam penceresi\n');
    expect(tr).toContain('\nGit\n');
    const types = (s: string) =>
      s
        .split('\n')
        .filter((l) => l.startsWith('  '))
        .map((l) => l.trim().split(' ')[0]);
    expect(types(tr)).toEqual(types(en));
  });
});

describe('usage', () => {
  const at = new Date(2026, 9, 14, 21, 7).getTime();
  const cache: UsageCache = {
    fetchedAt: at,
    error: 'rate limited by the usage API',
    rate_limits: {
      five_hour: { used_percentage: 41, resets_at: null },
      seven_day: { used_percentage: 7, resets_at: at },
      seven_day_models: [{ model: 'Opus', used_percentage: 3, resets_at: null }],
      spend_limit: { used_usd: 4.1, limit_usd: 10, used_percentage: 41 },
    },
  };
  const lines = (c: UsageCache) => {
    const out: string[] = [];
    const ok = usageLines(c, (l) => void out.push(l));
    return { ok, out };
  };

  it('prints the English lines unchanged', () => {
    expect(lines(cache)).toEqual({
      ok: true,
      out: [
        '✗ rate limited by the usage API',
        '  5-hour: 41%',
        '  weekly: 7%, resets Oct 14, 2026, 21:07',
        '  weekly Opus: 3%',
        '  extra usage: $4.1 of $10',
      ],
    });
  });

  it('prints Turkish words with numbers, model names and amounts unchanged', () => {
    expect(withLang('tr', () => lines(cache))).toEqual({
      ok: true,
      out: [
        "✗ kullanım API'si istekleri sınırladı",
        '  5 saatlik: 41%',
        '  haftalık: 7%, sıfırlanma: 14 Eki 2026 21:07',
        '  haftalık Opus: 3%',
        '  ek kullanım: $4.1 / $10',
      ],
    });
  });

  it('fails without limits and prints an unknown error as stored', () => {
    const r = withLang('tr', () => lines({ fetchedAt: at, error: 'socket hang up\u001b[2J' }));
    expect(r).toEqual({ ok: false, out: ['✗ socket hang up'] });
  });
});

describe('usageErrorText', () => {
  it('translates the errors usage.ts persists', () => {
    const known = [
      'no Claude login found',
      'rate limited by the usage API',
      'usage API returned 503',
      'usage API sent no limits',
    ];
    expect(known.map(usageErrorText)).toEqual(known);
    expect(withLang('tr', () => known.map(usageErrorText))).toEqual([
      'Claude giriş bilgisi bulunamadı',
      "kullanım API'si istekleri sınırladı",
      "kullanım API'si 503 döndürdü",
      "kullanım API'si limit bilgisi göndermedi",
    ]);
  });

  it('keeps other text, sanitized', () => {
    withLang('tr', () => {
      expect(usageErrorText('usage API returned 5030')).toBe('usage API returned 5030');
      expect(usageErrorText('__proto__')).toBe('__proto__');
      expect(usageErrorText('x\u001b]0;pwn\u0007y')).toBe('xy');
    });
  });
});
