import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BuildOptions, build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const WF = '.github/workflows/market-deploy.yml';
const WRANGLER = '../node_modules/.bin/wrangler';

const readLines = (rel: string): string[] => {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
};
const lines = readLines(WF);
const text = lines.join('\n');

const indent = (l: string): number => l.length - l.trimStart().length;
const blank = (l: string): boolean => l.trim() === '' || l.trim().startsWith('#');

// line indices of a key body
function body(all: string[], at: number): number[] {
  const out: number[] = [];
  const base = indent(all[at]!);
  for (let i = at + 1; i < all.length; i++) {
    const l = all[i]!;
    if (blank(l)) continue;
    if (indent(l) <= base) break;
    out.push(i);
  }
  return out;
}

const find = (re: RegExp, from = 0): number => {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i]!)) return i;
  return -1;
};

interface Step {
  at: number;
  key: number;
  idx: number[];
  run: string;
  env: number[];
  workdir: string | undefined;
  uses: string | undefined;
}

function steps(): Step[] {
  const job = find(/^ {2}deploy:\s*$/);
  if (job < 0) return [];
  const s = find(/^\s+steps:\s*$/, job);
  if (s < 0) return [];
  const idx = body(lines, s);
  const first = idx[0] === undefined ? -1 : indent(lines[idx[0]]!);
  const out: Step[] = [];
  for (const i of idx) {
    const l = lines[i]!;
    if (indent(l) === first && l.trimStart().startsWith('- ')) {
      out.push({ at: i, key: first + 2, idx: [i], run: '', env: [], workdir: undefined, uses: undefined });
    } else out.at(-1)?.idx.push(i);
  }
  for (const st of out) {
    for (const i of st.idx) {
      const l = lines[i]!;
      const k = l.trimStart().replace(/^- /, '');
      const at = i === st.at ? st.key : indent(l);
      if (at !== st.key) continue;
      const m = /^([\w-]+):\s*(.*)$/.exec(k);
      if (!m) continue;
      const [, name, value] = m;
      if (name === 'run') {
        st.run =
          value === '|'
            ? body(lines, i)
                .map((j) => lines[j]!.trim())
                .join('\n')
            : value!.trim();
      } else if (name === 'env') st.env = body(lines, i);
      else if (name === 'working-directory') st.workdir = value!.trim();
      else if (name === 'uses') st.uses = value!.trim();
    }
  }
  return out;
}

const topBlock = (key: string): string[] => {
  const at = find(new RegExp(`^${key}:\\s*$`));
  return at < 0 ? [] : body(lines, at).map((i) => lines[i]!);
};

function pathsFilter(): string[] {
  const on = find(/^on:\s*$/);
  if (on < 0) return [];
  const push = body(lines, on).find((i) => /^\s+push:\s*$/.test(lines[i]!));
  if (push === undefined) return [];
  const p = body(lines, push).find((i) => /^\s+paths:\s*$/.test(lines[i]!));
  if (p === undefined) return [];
  return body(lines, p).map((i) =>
    lines[i]!.trim()
      .replace(/^- /, '')
      .replace(/^(['"])(.*)\1$/, '$2'),
  );
}

const globRe = (g: string): RegExp =>
  new RegExp(
    `^${g
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*')}$`,
  );
const matched = (file: string, globs: string[]): boolean => globs.some((g) => globRe(g).test(file));

let inputs: string[] = [];
beforeAll(async () => {
  const href = pathToFileURL(path.join(root, 'scripts/worker-options.mjs')).href;
  const { workerBuildOptions } = (await import(href)) as {
    workerBuildOptions: (o: { root: string }) => BuildOptions;
  };
  const r = await build({
    ...workerBuildOptions({ root }),
    write: false,
    absWorkingDir: root,
    logLevel: 'silent',
  });
  inputs = Object.keys(r.metafile!.inputs).map((f) => f.split(path.sep).join('/').replace(/\\/g, '/'));
}, 60_000);

describe('market deploy workflow', () => {
  it('exists', () => {
    expect(fs.existsSync(path.join(root, WF))).toBe(true);
    expect(text).toMatch(/^name: \S/m);
  });

  it('runs the locked wrangler devDependency and no wrangler action', () => {
    const pkg = JSON.parse(readLines('package.json').join('\n'));
    const lock = JSON.parse(readLines('package-lock.json').join('\n'));
    expect(pkg.devDependencies.wrangler).toBe('4.149.0');
    expect(pkg.dependencies?.wrangler).toBeUndefined();
    expect(lock.packages['node_modules/wrangler'].version).toBe('4.149.0');
    expect(text).not.toMatch(/wrangler@/);
    expect(text).not.toMatch(/npx --yes/);
    expect(text).not.toMatch(/wrangler-action/);
    for (const st of steps()) {
      if (st.run.includes('wrangler')) expect(st.run.startsWith(`${WRANGLER} `)).toBe(true);
    }
  });

  it('runs on dispatch and on push to main only, never for pull requests', () => {
    const on = topBlock('on').join('\n');
    expect(on).toMatch(/^ {2}workflow_dispatch:\s*$/m);
    expect(on).toMatch(/^ {2}push:\s*$/m);
    expect(on).toMatch(/^ {4}branches: \[main\]\s*$/m);
    expect(on).not.toMatch(/tags:/);
    expect(text).not.toMatch(/pull_request|pull_request_target|workflow_run|issue_comment/);
  });

  it('runs only in the owner repository once MARKET_URL is set', () => {
    const job = find(/^ {2}deploy:\s*$/);
    expect(job).toBeGreaterThan(-1);
    const cond = body(lines, job)
      .map((i) => lines[i]!)
      .find((l) => /^ {4}if:/.test(l));
    expect(cond).toBeDefined();
    expect(cond).toContain("github.repository == 'alpadalar/ccinfobar'");
    expect(cond).toContain("vars.MARKET_URL != ''");
    expect(cond).toContain('&&');
    expect(cond).not.toContain('||');
    expect(find(/^ {4}timeout-minutes: \d+\s*$/, job)).toBeGreaterThan(job);
  });

  it('reads the repository only and never cancels a running deploy', () => {
    expect(topBlock('permissions').map((l) => l.trim())).toEqual(['contents: read']);
    expect(topBlock('concurrency').map((l) => l.trim())).toEqual([
      'group: market-deploy',
      'cancel-in-progress: false',
    ]);
    expect(text).not.toMatch(/write-all|: write\s*$/m);
  });

  it('exposes the Cloudflare secrets only to wrangler steps', () => {
    const all = steps();
    const allowed = new Set<number>();
    for (const st of all) if (st.run.startsWith(`${WRANGLER} `)) for (const i of st.env) allowed.add(i);
    const uses = lines.flatMap((l, i) => (l.includes('secrets.') ? [i] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const i of uses) {
      expect(allowed.has(i), `line ${i + 1}: ${lines[i]}`).toBe(true);
      expect(lines[i]).toMatch(
        /^\s+(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID): \$\{\{ secrets\.(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID) \}\}\s*$/,
      );
    }
    expect(text).not.toMatch(/secrets\s*\[|toJSON\(secrets|secrets: inherit/);
    // R-14: the client secret is a Worker secret, not a workflow one
    expect(text).not.toMatch(/GITHUB_CLIENT_SECRET|wrangler secret/);
    const jobEnv = find(/^ {4}env:\s*$/);
    const jobEnvBody = jobEnv < 0 ? [] : body(lines, jobEnv).map((i) => lines[i]!.trim());
    expect(jobEnvBody).toEqual(["WRANGLER_SEND_METRICS: 'false'"]);
    expect(find(/^env:/)).toBe(-1);
  });

  it('installs, tests and builds without secrets', () => {
    const all = steps();
    const ci = all.find((s) => s.run.startsWith('npm ci'));
    expect(ci).toBeDefined();
    expect(ci!.env).toEqual([]);
    for (const st of all) {
      if (!st.run.startsWith(WRANGLER)) {
        expect(st.idx.some((i) => lines[i]!.includes('secrets.'))).toBe(false);
      }
    }
  });

  it('pins every action by a full commit SHA (IN-08)', () => {
    const uses = steps().flatMap((s) => (s.uses ? [s.uses] : []));
    expect(uses.length).toBe(2);
    for (const u of uses)
      expect(u).toMatch(/^actions\/(?:checkout|setup-node)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it('runs the steps in a safe order inside worker/', () => {
    const all = steps();
    const pos = (pred: (s: Step) => boolean): number => all.findIndex(pred);
    const checkout = pos((s) => s.uses?.startsWith('actions/checkout@') === true);
    const node = pos((s) => s.uses?.startsWith('actions/setup-node@') === true);
    const install = pos((s) => s.run.startsWith('npm ci'));
    const tests = pos((s) => s.run === 'npx vitest run test/market');
    const bundle = pos((s) => s.run === 'node scripts/build.mjs --worker');
    const dry = pos((s) => s.run === `${WRANGLER} deploy --dry-run`);
    // WR-06: a restore point in the job log before any migration
    const bookmark = pos((s) => s.run === `${WRANGLER} d1 time-travel info ccinfobar-market --json`);
    const migrate = pos((s) => s.run === `${WRANGLER} d1 migrations apply ccinfobar-market --remote`);
    const deploy = pos((s) => s.run === `${WRANGLER} deploy`);
    const smoke = pos((s) => s.run.includes('curl'));
    const order = [checkout, node, install, tests, bundle, dry, bookmark, migrate, deploy, smoke];
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(bookmark + 1).toBe(migrate);
    for (const n of [dry, bookmark, migrate, deploy]) expect(all[n]!.workdir).toBe('worker');
    expect(text).not.toMatch(/backs up|takes a backup/);
    expect(text).toMatch(/node-version: 22\.\d+\.\d+\s*$/m);
    const cfg = readLines('worker/wrangler.jsonc')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(JSON.parse(cfg).d1_databases[0].database_name).toBe('ccinfobar-market');
  });

  it('smoke-checks the landing page and meta.json with MARKET_URL from vars', () => {
    const smoke = steps().find((s) => s.run.includes('curl'));
    expect(smoke).toBeDefined();
    expect(smoke!.run).toMatch(/curl -fsS --max-time 20 [^\n]*\/v1\/meta\.json"/);
    expect(smoke!.run).toMatch(/curl -fsS --max-time 20 [^\n]*\/" -o \/dev\/null/);
    expect(smoke!.env.map((i) => lines[i]!.trim())).toEqual(['MARKET_URL: ${{ vars.MARKET_URL }}']);
  });

  it('the push paths filter covers every input of the Worker bundle', () => {
    const globs = pathsFilter();
    expect(inputs.length).toBeGreaterThan(5);
    expect(inputs.some((f) => f.endsWith('src/market/worker/index.ts'))).toBe(true);
    expect(inputs.filter((f) => !matched(f, globs))).toEqual([]);
    for (const f of ['scripts/build.mjs', 'scripts/worker-options.mjs', WF, 'worker/wrangler.jsonc']) {
      expect(matched(f, globs), f).toBe(true);
    }
    for (const f of fs.readdirSync(path.join(root, 'worker/migrations'))) {
      expect(matched(`worker/migrations/${f}`, globs), f).toBe(true);
    }
    for (const g of globs) {
      if (!g.includes('*')) expect(fs.existsSync(path.join(root, g)), g).toBe(true);
    }
  });

  it('the matcher handles ** and exact paths', () => {
    expect(matched('src/market/worker/a.ts', ['src/market/**'])).toBe(true);
    expect(matched('src/core/edit.ts', ['src/market/**', 'src/core/sanitize.ts'])).toBe(false);
    expect(matched('src/core/sanitize.ts', ['src/core/sanitize.ts'])).toBe(true);
    expect(matched('src/core/sanitizeX.ts', ['src/core/sanitize.ts'])).toBe(false);
    expect(matched('a/b/c.ts', ['a/*.ts'])).toBe(false);
  });
});

describe('ci workflow', () => {
  it('builds the Worker in the lint job and runs every test in the matrix', () => {
    const ci = readLines('.github/workflows/ci.yml');
    const lint = ci.findIndex((l) => /^ {2}lint:\s*$/.test(l));
    expect(lint).toBeGreaterThan(-1);
    const job = body(ci, lint).map((i) => ci[i]!.trim());
    const at = job.indexOf('- run: node scripts/build.mjs --worker');
    expect(at).toBeGreaterThan(job.indexOf('- run: npm run lint'));
    expect(ci.join('\n')).toMatch(/^ {6}- run: npm test\s*$/m);
  });
});
