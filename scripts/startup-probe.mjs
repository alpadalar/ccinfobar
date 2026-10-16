// Dev-only F2 startup breakdown: `nice -n -10 node scripts/startup-probe.mjs [--node <path>] [--onefile] [--json]`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const o = { node: process.execPath, dist: path.join(repo, 'dist'), rounds: 2, iterations: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--node') {
      const v = val();
      o.node = /[\\/]/.test(v) ? path.resolve(v) : v;
    } else if (a === '--dist') o.dist = path.resolve(val());
    else if (a === '--rounds') o.rounds = count(a, val());
    else if (a === '--iterations') o.iterations = count(a, val());
    else if (a === '--onefile') o.onefile = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: node scripts/startup-probe.mjs [--node <path>] [--dist <dir>] [--rounds 2] [--iterations 30] [--onefile] [--json]',
      );
      process.exit(0);
    } else fail(`unknown option ${a}`);
  }
  return o;
}

function count(flag, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1000) fail(`${flag} must be 1..1000`);
  return n;
}

class ProbeError extends Error {}

function fail(msg) {
  throw new ProbeError(msg);
}

// same as stats() in src/commands/bench.ts
function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const n = s.length;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { median: r2(median), min: r2(s[0]), p95: r2(s[Math.max(0, Math.ceil(0.95 * n) - 1)]) };
}

const r2 = (n) => Math.round(n * 100) / 100;

// copied from src/data/git.ts
const HARDEN = ['-c', 'core.fsmonitor=false', '--no-optional-locks'];
const SCOPED_RE = '^(remote\\.origin\\.url|filter\\..+\\.(clean|smudge|process))$';
const GIT_CMDS = {
  'git --version': ['--version'],
  'rev-parse': [...HARDEN, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'],
  'config --show-scope': [...HARDEN, 'config', '--show-scope', '--get-regexp', SCOPED_RE],
  'status --porcelain=v2': [...HARDEN, 'status', '--porcelain=v2', '--branch', '--show-stash'],
  'diff --shortstat': [...HARDEN, 'diff', 'HEAD', '--shortstat', '--no-ext-diff', '--no-textconv'],
};

function cliChunk(dist) {
  const entry = fs.readFileSync(path.join(dist, 'ccinfobar.js'), 'utf8');
  const name = /import\("\.\/chunks\/(cli-[^"]+\.js)"\)/.exec(entry)?.[1];
  if (!name) fail(`no cli chunk import in ${path.join(dist, 'ccinfobar.js')}; run npm run build`);
  return path.join(dist, 'chunks', name);
}

function inside(root, p) {
  const rel = path.relative(root, path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function childEnv(root) {
  const env = { ...process.env };
  for (const k of ['CCINFOBAR_CONFIG', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_OPTIONS']) delete env[k];
  Object.assign(env, {
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    CCINFOBAR_CONFIG_DIR: path.join(root, 'cfg'),
    CCINFOBAR_CACHE_DIR: path.join(root, 'cache'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    NODE_COMPILE_CACHE: path.join(root, 'compile-cache'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CCINFOBAR_NO_UPDATE: '1',
    CCINFOBAR_NO_USAGE_API: '1',
    CCINFOBAR_NO_JOBS: '1',
    COLUMNS: '140',
  });
  for (const k of [
    'HOME',
    'CCINFOBAR_CONFIG_DIR',
    'CCINFOBAR_CACHE_DIR',
    'CLAUDE_CONFIG_DIR',
    'NODE_COMPILE_CACHE',
  ]) {
    if (!inside(root, env[k])) fail(`${k} is outside the probe dir`);
    fs.mkdirSync(env[k], { recursive: true });
  }
  return env;
}

function payload(cwd) {
  const p = JSON.parse(fs.readFileSync(path.join(repo, 'test/fixtures/payload.json'), 'utf8'));
  p.cwd = cwd;
  p.workspace = { ...p.workspace, current_dir: cwd, project_dir: cwd };
  return JSON.stringify(p);
}

async function buildOnefile(out) {
  const esbuild = createRequire(path.join(repo, 'package.json'))('esbuild');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const web = path.join(repo, 'src/editor/web');
  const js = await esbuild.build({
    entryPoints: [path.join(web, 'app.ts')],
    bundle: true,
    write: false,
    minify: true,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
  });
  const css = fs.readFileSync(path.join(web, 'style.css'), 'utf8');
  const html = fs
    .readFileSync(path.join(web, 'index.html'), 'utf8')
    .replace('<!--STYLE-->', () => `<style>${css}</style>`)
    .replace(
      '<!--SCRIPT-->',
      () => `<script>${js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`,
    );
  await esbuild.build({
    entryPoints: [path.join(repo, 'src/bin.ts')],
    outfile: out,
    splitting: false,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    minify: false,
    legalComments: 'none',
    logLevel: 'error',
    define: { __VERSION__: JSON.stringify(pkg.version), __EDITOR_HTML__: JSON.stringify(html) },
  });
}

// same checks as installKind() in src/data/update-state.ts
function installKindLike(entry, prefix) {
  let real = entry;
  try {
    real = fs.realpathSync(entry);
  } catch {}
  const p = real.replace(/\\/g, '/');
  if (/\/_npx\//.test(p)) return 'npx';
  if (p.startsWith(`${prefix.replace(/\\/g, '/')}/`)) return 'local';
  if (p.includes('/Cellar/ccinfobar/')) return 'brew';
  if (/\/node_modules\/ccinfobar\/dist\//.test(p)) return 'npm-global';
  if (fs.existsSync(path.join(path.dirname(path.dirname(real)), '.git'))) return 'source';
  return 'unknown';
}

function installKindCost(entry, prefix) {
  const t0 = process.hrtime.bigint();
  const kind = installKindLike(entry, prefix);
  const first = Number(process.hrtime.bigint() - t0) / 1e3;
  const n = 10_000;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) installKindLike(entry, prefix);
  return { kind, firstUs: r2(first), perCallUs: r2(Number(process.hrtime.bigint() - t1) / 1e3 / n) };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (path.isAbsolute(o.node) && !fs.existsSync(o.node)) fail(`no node at ${o.node}`);
  const entry = path.join(o.dist, 'ccinfobar.js');
  const chunk = cliChunk(o.dist);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-probe-'));
  try {
    const env = childEnv(root);
    const nongit = path.join(root, 'cwd');
    fs.mkdirSync(nongit);
    const info = spawnSync(
      o.node,
      [
        '-p',
        'JSON.stringify([process.version, process.config.variables.node_use_node_snapshot, process.config.variables.node_use_node_code_cache])',
      ],
      { env, encoding: 'utf8' },
    );
    const [version, snapshot, codeCache] = JSON.parse(info.stdout);
    const empty = path.join(root, 'empty.mjs');
    fs.writeFileSync(empty, '');
    const imp = path.join(root, 'import.mjs');
    fs.writeFileSync(
      imp,
      `import module from 'node:module';\nmodule.enableCompileCache?.();\nawait import(${JSON.stringify(pathToFileURL(chunk).href)});\n`,
    );
    const onefile = path.join(root, 'onefile', 'ccinfobar.js');
    if (o.onefile) await buildOnefile(onefile);

    const gitInput = payload(repo);
    const noCacheEnv = { ...env, NODE_DISABLE_COMPILE_CACHE: '1' };
    const variants = {
      control: { args: ['-e', '0'], cwd: repo },
      empty: { args: [empty], cwd: repo },
      import: { args: [imp], cwd: repo },
      'render-nongit': { args: [entry], cwd: nongit, input: payload(nongit) },
      'render-git': { args: [entry], cwd: repo, input: gitInput },
      'render-nocache': { args: [entry], cwd: repo, input: gitInput, env: noCacheEnv },
      ...(o.onefile ? { 'render-onefile': { args: [onefile], cwd: repo, input: gitInput } } : {}),
    };
    const names = Object.keys(variants);

    const run = (name, capture = false) => {
      const v = variants[name];
      const t0 = process.hrtime.bigint();
      const r = spawnSync(o.node, v.args, {
        cwd: v.cwd,
        env: v.env ?? env,
        input: v.input ?? '',
        stdio: ['pipe', capture ? 'pipe' : 'ignore', 'pipe'],
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (r.error || r.status !== 0) fail(`${name} failed (${r.status ?? r.error?.code}): ${r.stderr}`);
      return capture ? r.stdout : ms;
    };

    for (const name of names) for (let w = 0; w < 2; w++) run(name);
    const out = { split: run('render-git', true) };
    if (!out.split.trim()) fail('render printed nothing');
    if (o.onefile) out.onefile = run('render-onefile', true);

    const samples = Object.fromEntries(names.map((n) => [n, []]));
    const perRound = Object.fromEntries(names.map((n) => [n, []]));
    for (let round = 0; round < o.rounds; round++) {
      const these = Object.fromEntries(names.map((n) => [n, []]));
      for (let i = 0; i < o.iterations; i++) {
        const k = (round * o.iterations + i) % names.length;
        for (const name of [...names.slice(k), ...names.slice(0, k)]) these[name].push(run(name));
      }
      for (const n of names) {
        samples[n].push(...these[n]);
        perRound[n].push(stats(these[n]).median);
      }
    }

    const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', CCINFOBAR_GIT_EMPTY: '' };
    const gitSamples = Object.fromEntries(Object.keys(GIT_CMDS).map((c) => [c, []]));
    for (let i = 0; i < o.rounds * o.iterations; i++) {
      for (const [name, args] of Object.entries(GIT_CMDS)) {
        const t0 = process.hrtime.bigint();
        const r = spawnSync('git', args, { cwd: repo, env: gitEnv, stdio: 'ignore', windowsHide: true });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (r.error || (r.status !== 0 && r.status !== 1)) fail(`git ${name} failed`);
        gitSamples[name].push(ms);
      }
    }

    const v = Object.fromEntries(names.map((n) => [n, stats(samples[n])]));
    const d = (a, b) => r2(v[a].median - v[b].median);
    const result = {
      node: o.node,
      version,
      snapshot,
      codeCache,
      rounds: o.rounds,
      iterations: o.iterations,
      variants: v,
      perRound,
      deltas: {
        esmLoader: d('empty', 'control'),
        moduleLoad: d('import', 'empty'),
        render: d('render-nongit', 'import'),
        git: d('render-git', 'render-nongit'),
        compileCache: d('render-nocache', 'render-git'),
        ...(o.onefile ? { onefile: d('render-git', 'render-onefile') } : {}),
      },
      ...(o.onefile ? { onefileIdentical: out.onefile === out.split } : {}),
      git: Object.fromEntries(
        Object.entries(gitSamples).map(([n, ms]) => {
          const s = stats(ms);
          return [n, { median: s.median, min: s.min }];
        }),
      ),
      installKind: {
        probeNode: process.version,
        ...installKindCost(entry, path.join(env.CCINFOBAR_CONFIG_DIR, 'app')),
      },
    };
    if (o.json) console.log(JSON.stringify(result));
    else print(result);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function print(r) {
  console.log(`node ${r.version} (${r.node}), snapshot ${r.snapshot}, code cache ${r.codeCache}`);
  console.log(`${r.rounds} rounds x ${r.iterations} iterations, interleaved`);
  console.log('');
  const row = (a, b, c, e) => `${a.padEnd(22)}${b.padStart(10)}${c.padStart(10)}${e.padStart(10)}`;
  console.log(row('variant', 'median', 'min', 'p95'));
  for (const [n, s] of Object.entries(r.variants))
    console.log(row(n, s.median.toFixed(1), s.min.toFixed(1), s.p95.toFixed(1)));
  console.log('');
  for (const [n, ms] of Object.entries(r.deltas))
    console.log(`${n.padEnd(22)}${ms.toFixed(1).padStart(10)} ms`);
  if ('onefileIdentical' in r) console.log(`onefile output identical: ${r.onefileIdentical}`);
  console.log('');
  console.log(row('git', 'median', 'min', ''));
  for (const [n, s] of Object.entries(r.git)) console.log(row(n, s.median.toFixed(2), s.min.toFixed(2), ''));
  console.log('');
  console.log(
    `installKind (${r.installKind.kind}): first call ${r.installKind.firstUs} us, then ${r.installKind.perCallUs} us per call`,
  );
}

try {
  await main();
} catch (err) {
  if (!(err instanceof ProbeError)) throw err;
  console.error(`startup-probe: ${err.message}`);
  process.exitCode = 1;
}
