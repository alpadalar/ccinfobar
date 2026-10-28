import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

const readLines = (rel: string): string[] => {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
};

const release = readLines('.github/workflows/release.yml');
const ci = readLines('.github/workflows/ci.yml');
const releaseText = release.join('\n');
const ciText = ci.join('\n');

const indent = (l: string): number => l.length - l.trimStart().length;

// job name -> timeout-minutes (undefined when missing)
function jobs(all: string[]): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  const start = all.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return out;
  let current: string | undefined;
  for (let i = start + 1; i < all.length; i++) {
    const l = all[i]!;
    if (l.trim() === '' || l.trim().startsWith('#')) continue;
    if (indent(l) === 0) break;
    const job = /^ {2}([a-z][\w-]*):\s*$/.exec(l);
    if (job) {
      current = job[1]!;
      out[current] = undefined;
      continue;
    }
    const t = /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(l);
    if (t && current) out[current] = Number(t[1]);
  }
  return out;
}

describe('release workflow', () => {
  it('pins every action by commit SHA with a version comment', () => {
    const uses = release.filter((l) => /\buses:/.test(l)).map((l) => l.replace(/^.*uses:\s*/, '').trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u, `unpinned action: ${u}`).toMatch(
        /^actions\/(?:checkout|setup-node)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
      );
    }
  });

  it('pins every action in every job of ci.yml by commit SHA with a version comment', () => {
    const uses = ci.filter((l) => /\buses:/.test(l)).map((l) => l.replace(/^.*uses:\s*/, '').trim());
    expect(uses.length).toBeGreaterThanOrEqual(12);
    for (const u of uses) {
      expect(u, `unpinned action: ${u}`).toMatch(
        /^actions\/(?:checkout|setup-node)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
      );
    }
  });

  it('has no floating tags and pins npm', () => {
    expect(releaseText).not.toMatch(/@latest/);
    expect(releaseText).not.toMatch(/@v\d+(?:\s|$)/m);
    expect(ciText).not.toMatch(/@v\d+(?:\s|$)/m);
    expect(releaseText).toMatch(/npm install -g npm@\d+\.\d+\.\d+/);
  });

  it('checks the tag against package.json before npm ci', () => {
    const tag = release.findIndex((l) => l.includes('GITHUB_REF_NAME') && l.includes('!='));
    const npmCi = release.findIndex((l) => l.includes('npm ci'));
    expect(tag).toBeGreaterThan(-1);
    expect(npmCi).toBeGreaterThan(tag);
    const block = release.slice(Math.max(0, tag - 4), tag + 1).join('\n');
    expect(block).toContain('package.json');
    expect(release[tag]).toContain('exit 1');
  });

  it('gives every job a high timeout', () => {
    for (const [name, all] of [
      ['release.yml', release],
      ['ci.yml', ci],
    ] as const) {
      const map = jobs(all);
      expect(Object.keys(map).length, `${name} has no jobs`).toBeGreaterThan(0);
      for (const [job, mins] of Object.entries(map)) {
        expect(mins, `${name} job ${job} timeout-minutes`).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it('keeps permissions to id-token and contents write', () => {
    const at = release.findIndex((l) => /^permissions:\s*$/.test(l));
    expect(at).toBeGreaterThan(-1);
    const keys: string[] = [];
    for (let i = at + 1; i < release.length; i++) {
      const l = release[i]!;
      if (l.trim() === '') continue;
      if (indent(l) === 0) break;
      keys.push(l.trim());
    }
    expect(keys.sort()).toEqual(['contents: write', 'id-token: write']);
  });

  it('cancels only a superseded run of the same ref in ci.yml', () => {
    const at = ci.findIndex((l) => /^concurrency:\s*$/.test(l));
    expect(at).toBeGreaterThan(-1);
    expect(ci[at + 1]).toBe('  group: ${{ github.workflow }}-${{ github.ref }}');
    expect(ci[at + 2]).toBe('  cancel-in-progress: true');
    expect(at).toBeLessThan(ci.findIndex((l) => /^jobs:\s*$/.test(l)));
  });

  it('matches the changelog heading by fixed string and edits or creates the release from a notes file', () => {
    expect(releaseText).toContain('index($0, "## [" tag "]") == 1');
    expect(releaseText).not.toContain('$0 ~');
    expect(releaseText).toContain('> notes.md');
    expect(releaseText).toContain("grep -q '[^[:space:]]' notes.md || echo 'See CHANGELOG.md' > notes.md");
    expect(releaseText).not.toContain('[ -s notes.md ]');
    expect(releaseText).toContain('gh release edit "$GITHUB_REF_NAME" --notes-file notes.md');
    const upload = 'gh release upload "$GITHUB_REF_NAME" ccinfobar.tgz ccinfobar-*.tgz --clobber';
    expect(releaseText).toContain(upload);
    const edit = release.findIndex((l) => l.includes('gh release edit'));
    const up = release.findIndex((l) => l.includes(upload));
    const other = release.findIndex((l) => l.trim() === 'else');
    expect(up).toBeGreaterThan(edit);
    expect(up).toBeLessThan(other);
    expect(releaseText).toMatch(/gh release create .*\\\n?.*--notes-file notes\.md/);
    expect(releaseText).not.toMatch(/--notes "/);
    expect(releaseText).not.toContain('&& exit 0');
  });

  it('publishes without repeating the check', () => {
    expect(releaseText).toContain('npm publish --access public --ignore-scripts');
    expect(releaseText.match(/npm run check/g)).toHaveLength(1);
    expect(releaseText.match(/npm run build/g)).toHaveLength(1);
  });

  it('keeps every job timeout at its current value', () => {
    expect(Object.values(jobs(release))).toEqual([60]);
    expect(Object.values(jobs(ci))).toEqual([30, 60, 60, 45, 30, 30]);
  });
});
