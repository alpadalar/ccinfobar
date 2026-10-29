import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { type BuildOptions, type BuildResult, build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { stubEnv } from './worker-env.js';

const root = path.resolve(__dirname, '../..');

interface WorkerOpts {
  root: string;
  outfile?: string;
  format?: 'esm' | 'iife';
  globalName?: string;
}
type Built = BuildResult<{ write: false; metafile: true }>;

let workerBuildOptions: (o: WorkerOpts) => BuildOptions;
let esm: Built;
let iife: Built;

const inMemory = (o: BuildOptions): Promise<Built> =>
  build({ ...o, write: false, logLevel: 'silent' }) as Promise<Built>;

beforeAll(async () => {
  const href = pathToFileURL(path.join(root, 'scripts/worker-options.mjs')).href;
  ({ workerBuildOptions } = await import(href));
  esm = await inMemory(workerBuildOptions({ root }));
  iife = await inMemory(workerBuildOptions({ root, format: 'iife', globalName: 'W' }));
}, 60_000);

// what workerd offers without nodejs_compat (subset the Worker may use)
function webContext(): vm.Context {
  return vm.createContext({
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    AbortSignal,
    AbortController,
    ReadableStream,
    structuredClone,
    atob,
    btoa,
    console,
  });
}

interface WorkerModule {
  default: { fetch(req: Request, env: unknown): Promise<Response> };
}

function loadIife(): WorkerModule {
  const ctx = webContext();
  vm.runInContext(iife.outputFiles[0]!.text, ctx, { filename: 'worker.js' });
  return (ctx as { W: WorkerModule }).W;
}

describe('worker bundle (D-03)', () => {
  it('builds one ESM file with no Node globals or imports', () => {
    expect(esm.errors).toEqual([]);
    expect(esm.outputFiles).toHaveLength(1);
    const out = esm.outputFiles[0]!;
    expect(out.text).toMatch(/export\s*\{[^}]*default/);
    expect(out.text).not.toMatch(/node:/);
    expect(out.text).not.toMatch(/\bBuffer\b/);
    expect(out.text).not.toMatch(/process\./);
    expect(out.text).not.toMatch(/require\(/);
    expect(out.text).not.toMatch(/__dirname/);
    expect(out.text).not.toMatch(/setImmediate/);
    expect(out.contents.length).toBeLessThan(150 * 1024);
  });

  it('pulls in neither i18n tables nor edit.ts', () => {
    const inputs = Object.keys(esm.metafile.inputs).map((f) => f.split(path.sep).join('/'));
    expect(inputs.some((f) => f.endsWith('src/market/worker/index.ts'))).toBe(true);
    expect(inputs.filter((f) => f.includes('src/core/i18n/'))).toEqual([]);
    expect(inputs.filter((f) => f.endsWith('src/core/edit.ts'))).toEqual([]);
    expect(inputs.filter((f) => f.includes('node_modules'))).toEqual([]);
  });

  it('uses the options wrangler expects', () => {
    const o = workerBuildOptions({ root, outfile: path.join(root, 'worker/dist/index.js') });
    expect(o).toMatchObject({
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      minify: false,
      legalComments: 'none',
    });
    expect(o.entryPoints).toEqual([path.join(root, 'src/market/worker/index.ts')]);
    expect(o.outfile).toBe(path.join(root, 'worker/dist/index.js'));
  });

  it.each(['undefined/index.js', 'dist/index.js'])(
    'refuses a relative outfile (an unset path once wrote undefined/ at the repo root): %s',
    (outfile) => {
      expect(() => workerBuildOptions({ root, outfile })).toThrow(/absolute/);
    },
  );

  it.each(['node:fs', 'fs', 'fs/promises', 'buffer'])(
    'fails the build on an import of %s',
    async (spec) => {
      const { entryPoints: _, ...opts } = workerBuildOptions({ root });
      const run = inMemory({
        ...opts,
        stdin: {
          contents: `import './src/market/worker/index.ts';\nimport '${spec}';\n`,
          resolveDir: root,
          sourcefile: 'probe.ts',
          loader: 'ts',
        },
      });
      await expect(run).rejects.toThrow(/node import in worker: /);
    },
    30_000,
  );

  it('answers /v1/meta.json in a context with Web globals only', async () => {
    const W = loadIife();
    const res = await W.default.fetch(new Request('http://w.test/v1/meta.json'), stubEnv().env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const meta = (await res.json()) as { protocol: number };
    expect(meta.protocol).toBe(1);
  });

  it('answers / with the landing page in the same context', async () => {
    const W = loadIife();
    const res = await W.default.fetch(new Request('http://w.test/'), stubEnv().env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toContain('<html');
  });

  it('has no Node globals to lean on inside the context', () => {
    const ctx = webContext();
    expect(vm.runInContext('typeof process + typeof Buffer + typeof require', ctx)).toBe(
      'undefinedundefinedundefined',
    );
  });
});

describe('worker build wiring', () => {
  it('build.mjs --worker writes worker/dist/index.js with the shared options', () => {
    const src = fs.readFileSync(path.join(root, 'scripts/build.mjs'), 'utf8');
    expect(src).toContain("from './worker-options.mjs'");
    expect(src).toMatch(/includes\('--worker'\)\) await worker\(\)/);
    expect(src).toMatch(
      /workerBuildOptions\(\{ root, outfile: path\.join\(root, 'worker\/dist\/index\.js'\) \}\)/,
    );
  });

  it('keeps the bundle and wrangler state out of git and Biome', () => {
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
    expect(ignore).toContain('/worker/dist/');
    expect(ignore).toContain('/worker/.wrangler/');
    const biome = JSON.parse(fs.readFileSync(path.join(root, 'biome.json'), 'utf8'));
    expect(biome.files.includes).toEqual(expect.arrayContaining(['!worker/dist', '!worker/.wrangler']));
  });
});
