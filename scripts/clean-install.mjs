import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const win = process.platform === 'win32';
const argv = process.argv.slice(2);
const onlyCase = argv.includes('--case') ? argv[argv.indexOf('--case') + 1] : null;
const skipBuild = argv.includes('--skip-build');
const MAX_OUT = 4000;

const base = fs.realpathSync.native(process.env.RUNNER_TEMP ?? os.tmpdir());
const failures = [];
const results = [];

const SETTINGS = { model: 'opus', permissions: { allow: ['Bash(ls:*)'] } };
const FOREIGN = { ...SETTINGS, statusLine: { type: 'command', command: 'echo foreign' } };
const CASES = [
  { name: 'a', label: 'no settings file', data: null },
  { name: 'b', label: 'settings without statusLine', data: SETTINGS },
  { name: 'c', label: 'foreign statusLine', data: FOREIGN },
  { name: 'd', label: 'foreign statusLine with BOM', data: FOREIGN, bom: true },
  { name: 'e', label: 'foreign statusLine with CRLF', data: FOREIGN, eol: '\r\n' },
  {
    name: 'f',
    label: 'foreign statusLine, 4-space indent, no final newline',
    data: FOREIGN,
    indent: '    ',
    finalNewline: false,
  },
  { name: 'g', label: 'foreign statusLine, mode 0600', data: FOREIGN, mode: 0o600, posixOnly: true },
];

function formatJson(data, o = {}) {
  const eol = o.eol ?? '\n';
  let s = JSON.stringify(data, null, o.indent ?? '  ');
  if (eol === '\r\n') s = s.replace(/\n/g, '\r\n');
  return `${o.bom ? '﻿' : ''}${s}${o.finalNewline === false ? '' : eol}`;
}

function trim(s) {
  const t = (s ?? '').trim();
  return t.length > MAX_OUT ? `${t.slice(0, MAX_OUT)}\n[... ${t.length - MAX_OUT} more chars]` : t;
}

function run(file, args, o = {}) {
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    env: o.env,
    cwd: o.cwd,
    input: o.input,
    timeout: o.timeout ?? 30_000,
    windowsHide: true,
    windowsVerbatimArguments: !!o.verbatim,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`,
    command: [file, ...args].join(' '),
  };
}

function fail(ctx, step, info = {}) {
  ctx.failed = true;
  const f = { case: ctx.name, step, ...info };
  failures.push(f);
  const lines = [`FAIL case ${ctx.name} step ${step}${info.shell ? ` shell ${info.shell}` : ''}`];
  if (info.detail) lines.push(`  ${info.detail}`);
  if (info.command !== undefined) lines.push(`  command: ${info.command}`);
  if (info.stdout !== undefined) lines.push(`  stdout:\n${trim(info.stdout)}`);
  if (info.stderr !== undefined) lines.push(`  stderr:\n${trim(info.stderr)}`);
  console.error(lines.join('\n'));
}

function failRun(ctx, step, r, detail, shell) {
  fail(ctx, step, { detail, shell, command: r.command, stdout: r.stdout, stderr: r.stderr });
}

function npmCli() {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const env = process.env.npm_execpath;
  if (env && /npm-cli\.js$/.test(env)) candidates.push(env);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    try {
      const real = fs.realpathSync(path.join(dir, 'npm'));
      if (/npm-cli\.js$/.test(real)) candidates.push(real);
    } catch {}
  }
  const cli = candidates.find((c) => fs.existsSync(c));
  if (!cli) throw new Error(`npm-cli.js not found next to ${process.execPath}`);
  return cli;
}

function samePath(a, b) {
  return win ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function childEnv(d) {
  const env = {};
  let basePath = '';
  for (const [k, v] of Object.entries(process.env)) {
    if (/^path$/i.test(k)) basePath = v ?? '';
    if (/^(path|ci|claude_config_dir|home|userprofile|appdata|localappdata|tmp|temp|tmpdir)$/i.test(k))
      continue;
    if (/^(ccinfobar_|npm_|claude_code_|anthropic_|xdg_)/i.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    HOME: d.home,
    USERPROFILE: d.home,
    APPDATA: d.appdata,
    LOCALAPPDATA: d.localappdata,
    XDG_CONFIG_HOME: d.xdgConfig,
    XDG_CACHE_HOME: d.xdgCache,
    XDG_DATA_HOME: d.xdgData,
    TMPDIR: d.tmp,
    TEMP: d.tmp,
    TMP: d.tmp,
    npm_config_prefix: d.prefix,
    npm_config_cache: d.npmCache,
    npm_config_update_notifier: 'false',
    COLUMNS: '200',
  });
  env.PATH = [win ? d.prefix : path.join(d.prefix, 'bin'), basePath].join(path.delimiter);
  return env;
}

function makeRoot() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'ccib-ci-')));
  const d = {
    root,
    home: path.join(root, 'home'),
    appdata: path.join(root, 'appdata'),
    localappdata: path.join(root, 'localappdata'),
    xdgConfig: path.join(root, 'xdg-config'),
    xdgCache: path.join(root, 'xdg-cache'),
    xdgData: path.join(root, 'xdg-data'),
    tmp: path.join(root, 'tmp'),
    prefix: path.join(root, 'pre fix'),
    npmCache: path.join(root, 'npm-cache'),
    work: path.join(root, 'work dir'),
  };
  for (const [k, v] of Object.entries(d)) if (k !== 'root') fs.mkdirSync(v, { recursive: true });
  return d;
}

function assertSafe(d, env) {
  const home = os.homedir();
  for (const key of ['HOME', 'USERPROFILE']) {
    if (samePath(path.resolve(env[key]), path.resolve(home))) {
      console.error(`refusing to run: child ${key} is the real home ${home}`);
      process.exit(2);
    }
  }
  if (!inside(d.root, base)) {
    console.error(`refusing to run: ${d.root} is not inside ${base}`);
    process.exit(2);
  }
}

function settingsFile(d) {
  return path.join(d.home, '.claude', 'settings.json');
}

function installedPackageJson(d) {
  return win
    ? path.join(d.prefix, 'node_modules', 'ccinfobar', 'package.json')
    : path.join(d.prefix, 'lib', 'node_modules', 'ccinfobar', 'package.json');
}

function ccinfobar(ctx, args, o = {}) {
  if (win) {
    return run('cmd.exe', ['/d', '/s', '/c', `"ccinfobar ${args.join(' ')}"`], {
      env: ctx.env,
      cwd: ctx.d.work,
      verbatim: true,
      ...o,
    });
  }
  return run(path.join(ctx.d.prefix, 'bin', 'ccinfobar'), args, { env: ctx.env, cwd: ctx.d.work, ...o });
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function byteMismatch(seed, got) {
  const i = firstDiff(seed, got);
  const at = (buf) => (i < buf.length ? buf[i].toString(16).padStart(2, '0') : 'EOF');
  return [
    `bytes differ at index ${i} (seed ${seed.length} bytes, now ${got.length} bytes)`,
    `seed[${i}]=${at(seed)} context ${seed.subarray(i, i + 16).toString('hex')}`,
    `now[${i}]=${at(got)} context ${got.subarray(i, i + 16).toString('hex')}`,
  ].join('\n  ');
}

function seed(ctx) {
  const file = settingsFile(ctx.d);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (ctx.spec.data === null) return null;
  fs.writeFileSync(file, formatJson(ctx.spec.data, ctx.spec));
  if (ctx.spec.mode !== undefined) fs.chmodSync(file, ctx.spec.mode);
  return { bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 };
}

function readCommand(ctx) {
  const file = settingsFile(ctx.d);
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const cmd = JSON.parse(text)?.statusLine?.command;
    if (typeof cmd === 'string' && cmd) return cmd;
    fail(ctx, 'settings', { detail: `statusLine.command is not a string in ${file}`, stdout: text });
  } catch (e) {
    fail(ctx, 'settings', { detail: `cannot read ${file}: ${e.message}` });
  }
  return null;
}

function installStep(ctx, tgz) {
  const r = run(process.execPath, [ctx.npm, 'install', '-g', tgz, '--no-audit', '--no-fund'], {
    env: ctx.env,
    cwd: ctx.d.work,
    timeout: 60_000,
  });
  if (r.status !== 0) {
    failRun(ctx, 'npm install', r, `exit ${r.status}`);
    return false;
  }
  ctx.env.npm_config_offline = 'true';
  ctx.env.npm_config_registry = 'http://127.0.0.1:9/';
  return true;
}

function installCcinfobar(ctx) {
  const pj = installedPackageJson(ctx.d);
  const before = fs.statSync(pj).mtimeMs;
  const r = ccinfobar(ctx, ['install', '--yes']);
  const problems = [];
  if (r.status !== 0) problems.push(`exit ${r.status}`);
  if (!r.stdout.includes(`Installing ccinfobar ${pkg.version}`))
    problems.push(`missing "Installing ccinfobar ${pkg.version}"`);
  if (ctx.spec.data?.statusLine && !r.stdout.includes('Replaced:')) problems.push('missing "Replaced:"');
  if (r.stdout.includes('with npm')) problems.push('install mentioned npm');
  if (fs.statSync(pj).mtimeMs !== before) problems.push('install reinstalled the global package');
  if (problems.length) failRun(ctx, 'install', r, problems.join('; '));
  return problems.length === 0;
}

function uninstallCcinfobar(ctx, seeded) {
  const r = ccinfobar(ctx, ['uninstall']);
  if (r.status !== 0) return failRun(ctx, 'uninstall', r, `exit ${r.status}`);
  const file = settingsFile(ctx.d);
  if (!seeded) {
    if (fs.existsSync(file)) failRun(ctx, 'uninstall', r, `${file} still exists`);
    return;
  }
  if (!fs.existsSync(file)) return failRun(ctx, 'uninstall', r, `${file} is gone`);
  const got = fs.readFileSync(file);
  if (!got.equals(seeded.bytes)) failRun(ctx, 'uninstall', r, byteMismatch(seeded.bytes, got));
  if (!win) {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== seeded.mode)
      failRun(ctx, 'uninstall', r, `mode ${mode.toString(8)} != seed ${seeded.mode.toString(8)}`);
  }
}

function renderCase(_ctx, _command) {}

function runCase(spec, tgz, npm) {
  const d = makeRoot();
  const env = childEnv(d);
  assertSafe(d, env);
  const ctx = { name: spec.name, spec, d, env, npm, failed: false };
  console.log(`case ${spec.name} (${spec.label}): root ${d.root}`);
  try {
    if (!installStep(ctx, tgz)) return ctx;
    const seeded = seed(ctx);
    if (!installCcinfobar(ctx)) return ctx;
    const command = readCommand(ctx);
    if (command) renderCase(ctx, command);
    uninstallCcinfobar(ctx, seeded);
  } catch (e) {
    fail(ctx, 'driver', { detail: e.stack ?? String(e) });
  } finally {
    fs.rmSync(d.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return ctx;
}

function build() {
  if (skipBuild) return;
  const r = run(process.execPath, [path.join(repo, 'scripts', 'build.mjs')], { cwd: repo, timeout: 120_000 });
  if (r.status !== 0) {
    console.error(`build failed (exit ${r.status})\n${trim(r.stdout)}\n${trim(r.stderr)}`);
    process.exit(1);
  }
}

function pack(npm, packDir) {
  const r = run(process.execPath, [npm, 'pack', '--pack-destination', packDir], {
    cwd: repo,
    timeout: 60_000,
  });
  const tgz = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  if (r.status !== 0 || !tgz) {
    console.error(`npm pack failed (exit ${r.status})\n${trim(r.stdout)}\n${trim(r.stderr)}`);
    process.exit(1);
  }
  return path.join(packDir, tgz);
}

function main() {
  const cases = CASES.filter((c) => !onlyCase || c.name === onlyCase);
  if (!cases.length) {
    console.error(`unknown case ${onlyCase}; use a..g`);
    process.exit(2);
  }
  console.log(`ccinfobar ${pkg.version} clean install on ${process.platform}, node ${process.version}`);
  console.log(`temp base ${base}`);
  build();
  const npm = npmCli();
  const packDir = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'ccib-pack-')));
  try {
    const tgz = pack(npm, packDir);
    for (const spec of cases) {
      if (spec.posixOnly && win) {
        console.log(`SKIP case ${spec.name} (${spec.label}): POSIX only`);
        continue;
      }
      const ctx = runCase(spec, tgz, npm);
      results.push(ctx);
      console.log(`${ctx.failed ? 'FAIL' : 'PASS'} case ${spec.name} (${spec.label})`);
    }
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  const failed = results.filter((c) => c.failed).length;
  console.log(`${results.length - failed}/${results.length} cases passed, ${failures.length} failure(s)`);
  process.exit(failed ? 1 : 0);
}

main();
