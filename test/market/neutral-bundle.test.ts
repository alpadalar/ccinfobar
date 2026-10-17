import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// D-03: the Worker reuses these modules without Node or i18n code
describe('runtime-neutral market rules', () => {
  it('bundles protocol.ts and rules.ts for a neutral platform without i18n or edit.ts', async () => {
    const result = await build({
      stdin: {
        contents: [
          "export * from './src/market/protocol.ts';",
          "export * from './src/market/rules.ts';",
        ].join('\n'),
        resolveDir: root,
        sourcefile: 'neutral-entry.ts',
        loader: 'ts',
      },
      write: false,
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      metafile: true,
      mainFields: ['module', 'main'],
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs).map((f) => f.split(path.sep).join('/'));
    expect(inputs.some((f) => f.endsWith('src/market/rules.ts'))).toBe(true);
    expect(inputs.some((f) => f.endsWith('src/market/protocol.ts'))).toBe(true);
    expect(inputs.filter((f) => f.includes('src/core/i18n/'))).toEqual([]);
    expect(inputs.filter((f) => f.endsWith('src/core/edit.ts'))).toEqual([]);
    expect(inputs.filter((f) => f.includes('node_modules'))).toEqual([]);
    expect(result.outputFiles).toHaveLength(1);
    const out = result.outputFiles[0]!;
    expect(out.contents.length).toBeLessThan(40 * 1024);
    expect(out.text).not.toMatch(/['"]node:/);
    expect(out.text).not.toMatch(/\bBuffer\b|\brequire\(/);
  }, 30_000);
});
