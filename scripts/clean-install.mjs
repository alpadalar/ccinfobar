import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const win = process.platform === 'win32';
const argv = process.argv.slice(2);
const caseArg = argv.includes('--case') ? (argv[argv.indexOf('--case') + 1] ?? '') : null;
const onlyCase = caseArg?.startsWith('--') ? '' : caseArg;
const skipBuild = argv.includes('--skip-build');
const MAX_OUT = 4000;

const base = fs.realpathSync.native(process.env.RUNNER_TEMP ?? os.tmpdir());
const failures = [];
const results = [];
const owned = new Set();

function remove(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  owned.delete(dir);
}

process.on('exit', () => {
  for (const dir of owned) {
    try {
      remove(dir);
    } catch (e) {
      console.error(`could not remove ${dir}: ${e.message}`);
    }
  }
});

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
    pid: r.pid,
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
    if (
      /^(path|ci|claude_config_dir|claude_securestorage_config_dir|home|userprofile|appdata|localappdata|tmp|temp|tmpdir)$/i.test(
        k,
      )
    )
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
    npm_config_logs_dir: path.join(d.npmCache, '_logs'),
    npm_config_userconfig: path.join(d.home, '.npmrc'),
    npm_config_update_notifier: 'false',
    // a hashed keychain service, so macOS never finds the real token
    CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(d.home, '.claude'),
    COLUMNS: '200',
  });
  // fake claude shadows any real one
  env.PATH = [d.fakeBin, win ? d.prefix : path.join(d.prefix, 'bin'), basePath].join(path.delimiter);
  return env;
}

function makeRoot(prefix = 'ccib-ci-') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, prefix)));
  if (inside(root, base)) owned.add(root);
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
    fakeBin: path.join(root, 'fake bin'),
  };
  for (const [k, v] of Object.entries(d)) if (k !== 'root') fs.mkdirSync(v, { recursive: true });
  return d;
}

const CONTAINED = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'npm_config_prefix',
  'npm_config_cache',
  'npm_config_logs_dir',
  'npm_config_userconfig',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
];

function assertSafe(d, env) {
  const home = path.resolve(os.homedir());
  for (const key of ['HOME', 'USERPROFILE']) {
    if (samePath(path.resolve(env[key]), home)) {
      console.error(`refusing to run: child ${key} is the real home ${home}`);
      process.exit(2);
    }
  }
  if (!inside(d.root, base)) {
    console.error(`refusing to run: ${d.root} is not inside ${base}`);
    process.exit(2);
  }
  for (const key of CONTAINED) {
    if (typeof env[key] !== 'string' || !inside(path.resolve(env[key]), d.root)) {
      console.error(`refusing to run: child ${key}=${env[key]} is not inside ${d.root}`);
      process.exit(2);
    }
  }
  const first = env.PATH.split(path.delimiter)[0];
  if (!samePath(first, d.fakeBin) || !inside(path.resolve(first), d.root)) {
    console.error(`refusing to run: child PATH does not start with ${d.fakeBin}`);
    process.exit(2);
  }
}

const FAKE_VERSION = '2.1.299 (Claude Code)';

function fakeClaude(d) {
  if (win) return fs.writeFileSync(path.join(d.fakeBin, 'claude.cmd'), `@echo ${FAKE_VERSION}\r\n`);
  const file = path.join(d.fakeBin, 'claude');
  fs.writeFileSync(file, `#!/bin/sh\necho '${FAKE_VERSION}'\n`);
  fs.chmodSync(file, 0o755);
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

function uninstallCcinfobar(ctx, seeded, step = 'uninstall') {
  const r = ccinfobar(ctx, ['uninstall']);
  if (r.status !== 0) return failRun(ctx, step, r, `exit ${r.status}`);
  const file = settingsFile(ctx.d);
  if (!seeded) {
    if (fs.existsSync(file)) failRun(ctx, step, r, `${file} still exists`);
    return r;
  }
  if (!fs.existsSync(file)) return failRun(ctx, step, r, `${file} is gone`);
  const got = fs.readFileSync(file);
  if (!got.equals(seeded.bytes)) failRun(ctx, step, r, byteMismatch(seeded.bytes, got));
  if (!win) {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== seeded.mode)
      failRun(ctx, step, r, `mode ${mode.toString(8)} != seed ${seeded.mode.toString(8)}`);
  }
  return r;
}

const GIT_BASH = process.env.CLAUDE_CODE_GIT_BASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe';
const PS_ARGS = ['-NoProfile', '-NonInteractive'];
const UNICODE_DIR = 'work dir \u00fc';
let unicodeDone = false;

function shells() {
  if (!win) {
    return [
      { name: 'sh', file: '/bin/sh', args: (c) => ['-c', c] },
      { name: 'bash', file: 'bash', args: (c) => ['-c', c] },
    ];
  }
  const out = [
    { name: 'git bash', file: GIT_BASH, args: (c) => ['-c', c] },
    { name: 'powershell', file: 'powershell.exe', args: (c) => [...PS_ARGS, '-Command', c], soft: true },
  ];
  if (spawnSync('where', ['pwsh'], { windowsHide: true }).status === 0)
    out.push({ name: 'pwsh', file: 'pwsh', args: (c) => [...PS_ARGS, '-Command', c] });
  out.push({ name: 'cmd', file: 'cmd.exe', args: (c) => ['/d', '/s', '/c', `"${c}"`], verbatim: true });
  return out;
}

function payload(dir) {
  const p = JSON.parse(fs.readFileSync(path.join(repo, 'test', 'fixtures', 'payload.json'), 'utf8'));
  delete p.rate_limits;
  p.cwd = dir;
  p.workspace = { ...p.workspace, current_dir: dir, project_dir: dir };
  p.transcript_path = '';
  return JSON.stringify(p);
}

function plain(s) {
  return s
    .replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u00a0/g, ' ');
}

function renderProblems(r, expect) {
  const out = plain(r.stdout);
  const problems = [];
  if (r.status !== 0) problems.push(`exit ${r.status}`);
  if (!out.split(/\r?\n/).some((l) => l.trim())) problems.push('no output line');
  if (!out.includes('Opus 5.5')) problems.push('missing "Opus 5.5"');
  if (out.includes('ccinfobar:') || out.includes('invalid JSON')) problems.push('error text in output');
  if (expect && !out.includes(expect)) problems.push(`missing "${expect}"`);
  return problems;
}

function render(ctx, shell, command, dir, o = {}) {
  const r = run(shell.file, (o.args ?? shell.args)(command), {
    env: ctx.env,
    cwd: dir,
    input: payload(dir),
    timeout: 20_000,
    verbatim: shell.verbatim,
  });
  return { r, problems: renderProblems(r, o.expect) };
}

function renderCase(ctx, command) {
  ctx.rendered = true;
  for (const shell of shells()) {
    const { r, problems } = render(ctx, shell, command, ctx.d.work);
    if (problems.length) failRun(ctx, 'render', r, problems.join('; '), shell.name);
    else console.log(`  render ${shell.name}: ok`);
  }
  if (unicodeDone) return;
  unicodeDone = true;
  const dir = path.join(ctx.d.root, UNICODE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const shell of shells()) {
    const { r, problems } = render(ctx, shell, command, dir, { expect: UNICODE_DIR });
    if (!problems.length) console.log(`  render ${shell.name} non-ASCII cwd: ok`);
    else if (shell.soft) console.log(`WARN ${shell.name} non-ASCII cwd: ${problems.join('; ')}`);
    else failRun(ctx, 'render non-ASCII cwd', r, problems.join('; '), shell.name);
  }
  if (win) {
    const restricted = (c) => [...PS_ARGS, '-ExecutionPolicy', 'Restricted', '-Command', c];
    const ps = { name: 'powershell', file: 'powershell.exe' };
    const { r, problems } = render(ctx, ps, command, ctx.d.work, { args: restricted });
    if (!problems.length) console.log('  render powershell restricted policy: ok');
    else failRun(ctx, 'render with Restricted policy', r, problems.join('; '), ps.name);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function norm(s) {
  return win ? s.replace(/\\/g, '/').toLowerCase() : s;
}

function rootForms(root) {
  const forms = new Set([root]);
  try {
    forms.add(fs.realpathSync.native(root));
    forms.add(fs.realpathSync(root));
  } catch {}
  if (process.platform === 'darwin') {
    for (const f of [...forms])
      forms.add(f.startsWith('/private/') ? f.slice('/private'.length) : `/private${f}`);
  }
  return [...forms].map(norm);
}

function processList() {
  const r = win
    ? run(
        'powershell.exe',
        [
          ...PS_ARGS,
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
        ],
        { timeout: 20_000 },
      )
    : run('ps', ['-A', '-o', 'pid=,command='], { timeout: 20_000 });
  if (r.status !== 0) throw new Error(`process list failed: ${r.command}\n${trim(r.stderr)}`);
  const list = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) !== process.pid && Number(m[1]) !== r.pid) list.push({ pid: m[1], cmd: m[2] });
  }
  return list;
}

function pollLeftovers(ctx) {
  const forms = rootForms(ctx.d.root);
  const start = Date.now();
  for (;;) {
    const left = processList().filter((p) => forms.some((f) => norm(p.cmd).includes(f)));
    if (!left.length) return console.log(`  no leftover process after ${Date.now() - start} ms`);
    if (Date.now() - start >= 30_000) {
      fail(ctx, 'leftover processes', {
        detail: `still running after 30 s:\n${left.map((p) => `  ${p.pid} ${p.cmd}`).join('\n')}`,
      });
      for (const p of left) {
        try {
          process.kill(Number(p.pid), 'SIGKILL');
        } catch {}
      }
      return;
    }
    sleep(500);
  }
}

function cacheDir(d) {
  if (win) return path.join(d.localappdata, 'ccinfobar', 'cache');
  if (process.platform === 'darwin') return path.join(d.home, 'Library', 'Caches', 'ccinfobar');
  return path.join(d.xdgCache, 'ccinfobar');
}

function workerProof(ctx) {
  const dir = cacheDir(ctx.d);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const missing = [];
  if (!names.includes('update.json')) missing.push('update.json');
  // usage cache is keyed per account
  if (!names.some((f) => /^usage-[0-9a-f]{16}\.json$/.test(f))) missing.push('usage-<account>.json');
  if (missing.length) {
    const found = fs.existsSync(dir) ? names.join(', ') : '(no cache dir)';
    fail(ctx, 'workers', { detail: `missing ${missing.join(', ')} in ${dir}; found: ${found}` });
  } else console.log('  update and usage workers ran');
}

const HOOK_EVENTS = [
  'Notification',
  'SessionStart',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
];
const NEVER_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolBatch', 'PreModelSwitch', 'SessionEnd'];

function readSettings(ctx) {
  return JSON.parse(fs.readFileSync(settingsFile(ctx.d), 'utf8').replace(/^\uFEFF/, ''));
}

function hookSettingsProblems(hooks) {
  if (!hooks || typeof hooks !== 'object') return ['no hooks object'];
  const problems = [];
  const keys = Object.keys(hooks).sort();
  if (keys.join() !== HOOK_EVENTS.join()) problems.push(`hook events ${keys.join(', ')}`);
  const never = NEVER_EVENTS.filter((e) => e in hooks);
  if (never.length) problems.push(`never-registered events present: ${never.join(', ')}`);
  const notif = hooks.Notification;
  if (!Array.isArray(notif) || !notif.some((g) => g?.matcher === 'permission_prompt'))
    problems.push('Notification has no permission_prompt matcher');
  return problems;
}

function logLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function hookRun(ctx, shell, command, log) {
  const before = logLines(log).length;
  const input = JSON.stringify({
    session_id: `ci-${ctx.name}`,
    hook_event_name: 'UserPromptSubmit',
    prompt_id: `p-${shell.name}`,
  });
  const r = run(shell.file, shell.args(command), {
    env: ctx.env,
    cwd: ctx.d.work,
    input,
    timeout: 20_000,
    verbatim: shell.verbatim,
  });
  const problems = [];
  if (r.status !== 0) problems.push(`exit ${r.status}`);
  if (r.stdout) problems.push('stdout not empty');
  if (r.stderr) problems.push('stderr not empty');
  const lines = logLines(log);
  if (lines.length !== before + 1) problems.push(`log lines ${before} -> ${lines.length}, expected +1`);
  else {
    let last = null;
    try {
      last = JSON.parse(lines.at(-1));
    } catch {}
    if (last?.e !== 'UserPromptSubmit' || last?.p !== `p-${shell.name}`)
      problems.push(`unexpected log line ${lines.at(-1)}`);
  }
  if (problems.length) failRun(ctx, 'hooks', r, problems.join('; '), shell.name);
  else console.log(`  hook ${shell.name}: ok`);
}

function hooksCycle(ctx) {
  const seeded = seed(ctx);
  const r = ccinfobar(ctx, ['install', '--hooks', '--yes']);
  if (r.status !== 0) return failRun(ctx, 'hooks', r, `install --hooks exit ${r.status}`);
  let hooks;
  try {
    hooks = readSettings(ctx).hooks;
  } catch (e) {
    return failRun(ctx, 'hooks', r, `cannot read ${settingsFile(ctx.d)}: ${e.message}`);
  }
  const problems = hookSettingsProblems(hooks);
  if (problems.length) return failRun(ctx, 'hooks', r, problems.join('; '));
  const group = hooks.UserPromptSubmit.find((g) =>
    / hook UserPromptSubmit$/.test(g?.hooks?.[0]?.command ?? ''),
  );
  const command = group?.hooks[0].command;
  if (!command) return failRun(ctx, 'hooks', r, 'no ccinfobar UserPromptSubmit hook');
  console.log('  install --hooks: ok');
  const log = path.join(cacheDir(ctx.d), 'hooks', `ci-${ctx.name}.jsonl`);
  for (const shell of shells()) hookRun(ctx, shell, command, log);
  const u = uninstallCcinfobar(ctx, seeded, 'hooks uninstall');
  if (!u) return;
  const file = settingsFile(ctx.d);
  if (fs.existsSync(file)) {
    try {
      if ('hooks' in readSettings(ctx)) return failRun(ctx, 'hooks uninstall', u, 'hooks key left');
    } catch (e) {
      return failRun(ctx, 'hooks uninstall', u, `cannot read ${file}: ${e.message}`);
    }
  }
  if (!ctx.failed) console.log('  uninstall with hooks: settings restored');
}

function versionCheck(ctx) {
  const r = ccinfobar(ctx, ['--version']);
  if (r.status !== 0 || r.stdout.trim() !== pkg.version)
    failRun(ctx, 'version', r, `expected ${pkg.version}, got "${r.stdout.trim()}" (exit ${r.status})`);
}

function runCase(spec, tgz, npm) {
  const d = makeRoot();
  const env = childEnv(d);
  assertSafe(d, env);
  const ctx = { name: spec.name, spec, d, env, npm, failed: false };
  fakeClaude(d);
  console.log(`case ${spec.name} (${spec.label}): root ${d.root}`);
  try {
    if (!installStep(ctx, tgz)) return ctx;
    const seeded = seed(ctx);
    if (!installCcinfobar(ctx)) return ctx;
    const command = readCommand(ctx);
    if (command) renderCase(ctx, command);
    uninstallCcinfobar(ctx, seeded);
    if (ctx.rendered) {
      pollLeftovers(ctx);
      workerProof(ctx);
    }
    hooksCycle(ctx);
    versionCheck(ctx);
  } catch (e) {
    fail(ctx, 'driver', { detail: e.stack ?? String(e) });
  } finally {
    try {
      remove(d.root);
    } catch (e) {
      fail(ctx, 'cleanup', { detail: `cannot remove ${d.root}: ${e.message}` });
    }
  }
  return ctx;
}

function build(env) {
  if (skipBuild) return;
  const r = run(process.execPath, [path.join(repo, 'scripts', 'build.mjs')], {
    env,
    cwd: repo,
    timeout: 120_000,
  });
  if (r.status !== 0) {
    console.error(`build failed (exit ${r.status})\n${trim(r.stdout)}\n${trim(r.stderr)}`);
    process.exit(1);
  }
}

function pack(npm, packDir, env) {
  const r = run(process.execPath, [npm, 'pack', '--pack-destination', packDir], {
    env,
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
  const cases = CASES.filter((c) => onlyCase === null || c.name === onlyCase);
  if (!cases.length) {
    console.error(onlyCase ? `unknown case ${onlyCase}; use a..g` : '--case needs a name, a..g');
    process.exit(2);
  }
  console.log(`ccinfobar ${pkg.version} clean install on ${process.platform}, node ${process.version}`);
  console.log(`temp base ${base}`);
  const npm = npmCli();
  const packRoot = makeRoot('ccib-pack-');
  const packEnv = childEnv(packRoot);
  assertSafe(packRoot, packEnv);
  const packDir = path.join(packRoot.root, 'pack');
  fs.mkdirSync(packDir);
  try {
    build(packEnv);
    const tgz = pack(npm, packDir, packEnv);
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
    try {
      remove(packRoot.root);
    } catch (e) {
      console.error(`could not remove ${packRoot.root}: ${e.message}`);
    }
  }
  const failed = results.filter((c) => c.failed).length;
  console.log(`${results.length - failed}/${results.length} cases passed, ${failures.length} failure(s)`);
  process.exit(failed ? 1 : 0);
}

main();
