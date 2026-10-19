import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CatalogEntry, ENTRY_LIMITS, type EntryContent, newEntry } from '../../src/catalog/model.js';
import {
  CatalogStoreError,
  catalogDir,
  commitEntry,
  deleteEntry,
  findByName,
  listEntries,
  readEntry,
  restoreEntry,
  type SaveInput,
  STORE_LOCK,
  saveEntry,
  updateShare,
  writeProfile,
} from '../../src/catalog/store.js';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-catalog-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-16T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const fileOf = (id: string) => path.join(dir, 'entries', `${id}.json`);
const bytes = (id: string) => fs.readFileSync(fileOf(id));
const rawOf = (id: string) => JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) as Record<string, any>;

const content = (model = 'model'): EntryContent => ({
  layout: { lines: [[{ id: 'm', type: model }]] },
  appearance: { theme: 'nord' },
});

const input = (over: Partial<SaveInput> = {}): SaveInput => ({
  kind: 'bundle',
  name: 'Nord cockpit',
  description: 'Cool',
  author: 'me',
  content: content(),
  share: true,
  mode: 'new',
  now: at(0),
  ...over,
});

function codeOf(fn: () => unknown): { code: string; data: Record<string, unknown> } | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof CatalogStoreError) return { code: e.code, data: e.data };
    throw e;
  }
  return null;
}

function handWrite(id: string, text: string): void {
  fs.mkdirSync(path.join(dir, 'entries'), { recursive: true });
  fs.writeFileSync(fileOf(id), text);
}

function stored(id: string, now = '2026-10-16T09:00:00.000Z'): CatalogEntry {
  const e = newEntry({
    id,
    kind: 'preset',
    name: id,
    description: '',
    author: '',
    content: { layout: { lines: [[{ id: 'm', type: 'model' }]] } },
    share: false,
    now,
  });
  return { ...e, rev: 1 };
}

describe('catalog store', () => {
  it('catalogDir sits under the config dir', () => {
    const cfg = path.join(dir, 'cfg');
    expect(catalogDir({ CCINFOBAR_CONFIG_DIR: cfg })).toBe(path.join(cfg, 'catalog'));
  });

  it('save new writes entries/<u-id>.json with rev 1', () => {
    const e = saveEntry(input(), dir);
    expect(e.id).toMatch(/^u-[0-9a-f]{12}$/);
    expect(fs.readdirSync(path.join(dir, 'entries'))).toEqual([`${e.id}.json`]);
    const raw = rawOf(e.id);
    expect(raw).toMatchObject({ schema: 1, id: e.id, rev: 1, kind: 'bundle', slug: 'nord-cockpit' });
    expect(raw.version).toBe(1);
    expect(raw.versions).toHaveLength(1);
    expect(raw.share).toEqual({ wanted: true, state: 'pending', remote: null, lastError: null });
    expect(raw.createdAt).toBe(at(0).toISOString());
    expect(fs.readFileSync(fileOf(e.id), 'utf8').endsWith('}\n')).toBe(true);
    expect(e.rev).toBe(1);
    expect(fs.existsSync(`${fileOf(e.id)}.bak`)).toBe(false);
    const quiet = saveEntry(input({ kind: 'theme', name: 'Quiet', share: false }), dir);
    expect(quiet.share.state).toBe('local');
    expect(quiet.id).not.toBe(e.id);
  });

  it('save with an existing kind+name and mode new throws exists with id/version/name (D-06)', () => {
    const e = saveEntry(input(), dir);
    for (const name of ['Nord cockpit', 'nord  cockpit ', 'NORD COCKPIT']) {
      expect(codeOf(() => saveEntry(input({ name }), dir))).toEqual({
        code: 'exists',
        data: { id: e.id, version: 1, name: 'Nord cockpit' },
      });
    }
    expect(fs.readdirSync(path.join(dir, 'entries'))).toHaveLength(1);
    const preset = saveEntry(input({ kind: 'preset', content: { layout: content().layout } }), dir);
    expect(preset.id).not.toBe(e.id);
    expect(findByName('bundle', 'NORD cockpit', dir)?.id).toBe(e.id);
    expect(findByName('preset', 'nord cockpit', dir)?.id).toBe(preset.id);
    expect(findByName('theme', 'nord cockpit', dir)).toBeNull();
  });

  it('rejects bad names, kinds and content', () => {
    expect(codeOf(() => saveEntry(input({ name: '   ' }), dir))?.code).toBe('bad-name');
    expect(codeOf(() => saveEntry(input({ name: 'x'.repeat(65) }), dir))?.code).toBe('bad-name');
    expect(codeOf(() => saveEntry(input({ name: 'a\u0007b' }), dir))?.code).toBe('bad-name');
    expect(saveEntry(input({ name: 'ç'.repeat(64) }), dir).name).toBe('ç'.repeat(64));
    expect(codeOf(() => saveEntry(input({ content: null as any }), dir))?.code).toBe('bad-content');
    expect(
      codeOf(() =>
        saveEntry(input({ kind: 'preset', name: 'P', content: { appearance: { theme: 'x' } } }), dir),
      )?.code,
    ).toBe('bad-content');
    expect(codeOf(() => saveEntry(input({ kind: 'nope' as any, name: 'K' }), dir))?.code).toBe('bad-content');
  });

  it('keeps only the kind keys and no personal keys in stored content', () => {
    const e = saveEntry(
      input({
        kind: 'preset',
        content: {
          layout: { lines: [], budget: { daily: 5 } } as any,
          appearance: { theme: 'nord' },
        },
      }),
      dir,
    );
    expect(rawOf(e.id).versions[0].content).toEqual({ layout: { lines: [] } });
  });

  it('an update or overwrite with a share change is one write and keeps the overwritten backup', () => {
    const e = saveEntry(input(), dir);
    const v1 = bytes(e.id);
    const o = saveEntry(input({ mode: 'overwrite', content: content('git'), shareChange: false }), dir);
    expect(o.rev).toBe(2);
    expect(o.share).toMatchObject({ wanted: false, state: 'local' });
    expect(fs.readFileSync(`${fileOf(e.id)}.bak`).equals(v1)).toBe(true);
    const u = saveEntry(input({ mode: 'update', content: content('cost'), shareChange: false }), dir);
    expect(u.rev).toBe(3);
    expect(u.share.wanted).toBe(false);
    const kept = saveEntry(input({ mode: 'update', content: content('cwd'), share: true }), dir);
    expect(kept.share.wanted).toBe(false);
  });

  it('update appends, overwrite replaces in place', () => {
    const e = saveEntry(input(), dir);
    const up = saveEntry(input({ mode: 'update', content: content('cost'), note: 'two', now: at(1) }), dir);
    expect(up.id).toBe(e.id);
    expect(up.version).toBe(2);
    expect(up.versions).toHaveLength(2);
    expect(up.rev).toBe(2);
    expect(up.versions[1]).toMatchObject({ version: 2, note: 'two', at: at(1).toISOString() });
    const ow = saveEntry(
      input({ mode: 'overwrite', id: e.id, rev: 2, content: content('git'), description: 'New', now: at(2) }),
      dir,
    );
    expect(ow.version).toBe(2);
    expect(ow.versions).toHaveLength(2);
    expect(ow.rev).toBe(3);
    expect(ow.description).toBe('New');
    const raw = rawOf(e.id);
    expect(raw.versions[1].content.layout.lines[0][0].type).toBe('git');
    expect(raw.versions[1].overwrittenAt).toBe(at(2).toISOString());
    expect(raw.versions[0].content.layout.lines[0][0].type).toBe('model');
    expect(raw.updatedAt).toBe(at(2).toISOString());
    expect(raw.share.state).toBe('pending');
    expect(codeOf(() => saveEntry(input({ mode: 'update', name: 'Other' }), dir))?.code).toBe('not-found');
    expect(codeOf(() => saveEntry(input({ mode: 'update', id: '../x' }), dir))?.code).toBe('bad-id');
    expect(codeOf(() => saveEntry(input({ mode: 'update', id: 'u-000000000000' }), dir))?.code).toBe(
      'not-found',
    );
  });

  it('restore appends a new version', () => {
    const e = saveEntry(input(), dir);
    saveEntry(input({ mode: 'update', content: content('cost') }), dir);
    const r = restoreEntry(e.id, 1, 2, 'restored v1', dir);
    expect(r.version).toBe(3);
    expect(r.versions).toHaveLength(3);
    expect(r.versions[2]).toMatchObject({ version: 3, restoredFrom: 1, note: 'restored v1' });
    expect(r.versions[2]!.content).toEqual(r.versions[0]!.content);
    expect(rawOf(e.id).rev).toBe(3);
    expect(codeOf(() => restoreEntry(e.id, 9, 3, 'x', dir))?.code).toBe('no-version');
    expect(codeOf(() => restoreEntry('u-000000000000', 1, 1, 'x', dir))?.code).toBe('not-found');
  });

  it('a stale rev throws changed (no lost update)', () => {
    const e = saveEntry(input(), dir);
    saveEntry(input({ mode: 'update', content: content('cost') }), dir);
    const before = bytes(e.id);
    const bak = fs.readFileSync(`${fileOf(e.id)}.bak`);
    expect(codeOf(() => saveEntry(input({ mode: 'update', id: e.id, rev: 1 }), dir))?.code).toBe('changed');
    expect(codeOf(() => saveEntry(input({ mode: 'overwrite', rev: 1 }), dir))?.code).toBe('changed');
    expect(codeOf(() => restoreEntry(e.id, 1, 1, 'x', dir))?.code).toBe('changed');
    expect(codeOf(() => updateShare(e.id, false, 1, dir))?.code).toBe('changed');
    const cur = readEntry(e.id, dir)!.entry;
    expect(codeOf(() => commitEntry(cur, 1, dir))?.code).toBe('changed');
    expect(codeOf(() => commitEntry({ ...cur, id: 'u-111111111111' }, 2, dir))?.code).toBe('not-found');
    expect(codeOf(() => commitEntry({ ...cur, id: '../evil' }, 0, dir))?.code).toBe('bad-id');
    expect(bytes(e.id).equals(before)).toBe(true);
    expect(fs.readFileSync(`${fileOf(e.id)}.bak`).equals(bak)).toBe(true);
    const fresh = newEntry({ ...input(), author: 'me', id: e.id, now: at(5).toISOString() });
    expect(codeOf(() => commitEntry(fresh, 0, dir))?.code).toBe('changed');
    expect(bytes(e.id).equals(before)).toBe(true);
  });

  it('updateShare changes the share state and bumps rev', () => {
    const e = saveEntry(input(), dir);
    const off = updateShare(e.id, false, 1, dir);
    expect(off.share).toMatchObject({ wanted: false, state: 'local' });
    expect(off.rev).toBe(2);
    expect(off.version).toBe(1);
    expect(updateShare(e.id, true, 2, dir).share.state).toBe('pending');
  });

  it('replace writes .bak with the previous bytes first', () => {
    const e = saveEntry(input(), dir);
    const v1 = bytes(e.id);
    saveEntry(input({ mode: 'update', content: content('cost') }), dir);
    expect(fs.readFileSync(`${fileOf(e.id)}.bak`).equals(v1)).toBe(true);
    const v2 = bytes(e.id);
    updateShare(e.id, false, 2, dir);
    expect(fs.readFileSync(`${fileOf(e.id)}.bak`).equals(v2)).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'entries')).sort()).toEqual([`${e.id}.json`, `${e.id}.json.bak`]);
  });

  it('unknown keys survive a rewrite', () => {
    const e = saveEntry(input(), dir);
    const raw = rawOf(e.id);
    raw.futureKey = 1;
    raw.versions[0].extra = true;
    const text = JSON.stringify(raw, null, 2).replace('{', '{\n  "__proto__": { "polluted": true },');
    handWrite(e.id, text);
    saveEntry(input({ mode: 'update', content: content('cost') }), dir);
    const after = rawOf(e.id);
    expect(after.futureKey).toBe(1);
    expect(after.versions[0].extra).toBe(true);
    expect(after.versions[1].extra).toBeUndefined();
    expect(after.version).toBe(2);
    expect(Object.hasOwn(after, '__proto__')).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
    expect(fs.readFileSync(`${fileOf(e.id)}.bak`, 'utf8')).toBe(text);
  });

  it('nested unknown keys survive share, update, overwrite and restore (D-04)', () => {
    const e = saveEntry(input(), dir);
    updateShare(e.id, false, 1, dir);
    const raw = rawOf(e.id);
    raw.future = 1;
    raw.share.future = 2;
    raw.share.remote = { endpoint: 'https://m.example', id: 'me/x', version: 1, hash: 'a'.repeat(64) };
    raw.share.remote.publishedAt = '2026-10-16T10:00:00.000Z';
    raw.share.remote.future = 3;
    raw.versions[0].future = 4;
    raw.versions[0].content.future = 5;
    handWrite(e.id, JSON.stringify(raw, null, 2));
    const check = (after: Record<string, any>) => {
      expect(after.future).toBe(1);
      expect(after.share.future).toBe(2);
      expect(after.share.remote.future).toBe(3);
      expect(after.versions[0].future).toBe(4);
      expect(after.versions[0].content.future).toBe(5);
    };
    updateShare(e.id, true, 2, dir);
    check(rawOf(e.id));
    saveEntry(input({ mode: 'update', content: content('cost') }), dir);
    check(rawOf(e.id));
    saveEntry(input({ mode: 'overwrite', content: content('git') }), dir);
    check(rawOf(e.id));
    restoreEntry(e.id, 1, 5, '', dir, at(9));
    const after = rawOf(e.id);
    check(after);
    expect(after.versions.map((v: any) => v.version)).toEqual([1, 2, 3]);
    expect(after.versions[2].content.future).toBeUndefined();
  });

  it('the review wait and unknown remote keys survive share and update (D-09, CR-01)', () => {
    const e = saveEntry(input(), dir);
    const raw = rawOf(e.id);
    raw.share.state = 'published';
    raw.share.remote = {
      endpoint: 'https://m.example',
      id: 'me/x',
      version: 1,
      hash: 'a'.repeat(64),
      publishedAt: '2026-10-16T10:00:00.000Z',
      review: 'pending',
      future: 'x',
    };
    handWrite(e.id, JSON.stringify(raw, null, 2));
    expect(readEntry(e.id, dir)!.entry.share.remote?.review).toBe('pending');
    updateShare(e.id, false, 1, dir);
    expect(rawOf(e.id).share.remote).toMatchObject({ review: 'pending', future: 'x' });
    updateShare(e.id, true, 2, dir);
    saveEntry(input({ mode: 'update', content: content('cost') }), dir);
    expect(rawOf(e.id).share.remote).toMatchObject({ review: 'pending', future: 'x' });
    expect(readEntry(e.id, dir)!.entry.share.remote?.review).toBe('pending');
    const other = rawOf(e.id);
    other.share.remote.review = 'other';
    handWrite(e.id, JSON.stringify(other, null, 2));
    saveEntry(input({ mode: 'update', content: content('git') }), dir);
    const after = rawOf(e.id).share.remote;
    expect(after.future).toBe('x');
    expect('review' in after).toBe(false);
  });

  it('an overwrite drops the unknown content keys of the version it replaces', () => {
    const e = saveEntry(input(), dir);
    const raw = rawOf(e.id);
    raw.versions[0].content.future = 5;
    raw.versions[0].content.theme = { name: 'old' };
    handWrite(e.id, JSON.stringify(raw, null, 2));
    saveEntry(input({ mode: 'overwrite', content: content('git') }), dir);
    const v = rawOf(e.id).versions[0];
    expect(v.content.future).toBeUndefined();
    expect(v.content.theme).toBeUndefined();
    expect(v.content.layout.lines[0][0].type).toBe('git');
  });

  it('a BOM-prefixed entry file is read', () => {
    const e = stored('u-aaaaaaaaaaaa');
    const text = `﻿${JSON.stringify(e, null, 2)}\n`;
    handWrite(e.id, text);
    expect(listEntries(dir).map((x) => x.id)).toEqual([e.id]);
    expect(readEntry(e.id, dir)?.entry.name).toBe(e.id);
    expect(findByName('preset', e.id, dir)?.id).toBe(e.id);
    const up = saveEntry(
      input({ kind: 'preset', name: e.id, mode: 'update', content: { layout: { lines: [] } } }),
      dir,
    );
    expect(up.version).toBe(2);
    expect(fs.readFileSync(`${fileOf(e.id)}.bak`, 'utf8')).toBe(text);
    expect(fs.readFileSync(fileOf(e.id), 'utf8').charCodeAt(0)).toBe(0x7b);
  });

  it('one corrupt file does not hide the others', () => {
    const a = stored('u-aaaaaaaaaaaa', '2026-10-16T09:00:00.000Z');
    const b = stored('u-bbbbbbbbbbbb', '2026-10-16T09:05:00.000Z');
    const c = stored('u-cccccccccccc', '2026-10-16T09:00:00.000Z');
    handWrite(a.id, JSON.stringify(a));
    handWrite(b.id, JSON.stringify(b));
    handWrite(c.id, JSON.stringify(c));
    handWrite('u-dddddddddddd', '{ not json');
    handWrite('u-eeeeeeeeeeee', JSON.stringify({ ...a, id: 'u-eeeeeeeeeeee', versions: [] }));
    handWrite('u-ffffffffffff', JSON.stringify(a));
    handWrite('notes', JSON.stringify(a));
    expect(listEntries(dir).map((x) => x.id)).toEqual([b.id, a.id, c.id]);
    expect(readEntry('u-dddddddddddd', dir)).toBeNull();
    expect(readEntry('u-ffffffffffff', dir)).toBeNull();
    expect(listEntries(path.join(dir, 'missing'))).toEqual([]);
  });

  it('lists a safe layout for invalid stored content', () => {
    const e = stored('u-aaaaaaaaaaaa');
    const bad = {
      ...e,
      versions: [
        { ...e.versions[0]!, content: { layout: { lines: 'oops', align: 'bogus', budget: { daily: 1 } } } },
      ],
    };
    handWrite(e.id, JSON.stringify(bad));
    const [got] = listEntries(dir);
    expect(got!.versions[0]!.content.layout).toEqual({ lines: [] });
    const good = stored('u-bbbbbbbbbbbb');
    good.versions[0]!.content = {
      layout: { lines: [[{ type: 'model', bogus: 1 } as any]], align: 'center' },
      appearance: { theme: 'nord', padding: 99, icons: 'emoji' } as any,
    };
    handWrite(good.id, JSON.stringify(good));
    const listed = listEntries(dir).find((x) => x.id === good.id)!;
    expect(listed.versions[0]!.content).toEqual({
      layout: { lines: [[{ id: 'model-0', type: 'model' }]], align: 'center' },
      appearance: { theme: 'nord', padding: 4 },
    });
    expect(readEntry(good.id, dir)!.entry.versions[0]!.content).toEqual(good.versions[0]!.content);
  });

  it('delete moves to trash and keeps the newest 20', () => {
    const e = saveEntry(input(), dir);
    saveEntry(input({ mode: 'update', content: content('cost') }), dir);
    const before = bytes(e.id);
    const trashed = deleteEntry(e.id, dir, at(10)).file;
    expect(path.dirname(trashed)).toBe(path.join(dir, 'trash'));
    expect(path.basename(trashed).startsWith(`${e.id}-`)).toBe(true);
    expect(fs.readFileSync(trashed).equals(before)).toBe(true);
    expect(fs.existsSync(fileOf(e.id))).toBe(false);
    expect(fs.existsSync(`${fileOf(e.id)}.bak`)).toBe(false);
    expect(readEntry(e.id, dir)).toBeNull();
    expect(codeOf(() => deleteEntry(e.id, dir))?.code).toBe('not-found');
    expect(codeOf(() => deleteEntry('../x', dir))?.code).toBe('bad-id');

    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const x = saveEntry(input({ name: `Entry ${i}`, now: at(20 + i) }), dir);
      ids.push(x.id);
      deleteEntry(x.id, dir, at(20 + i));
    }
    const left = fs.readdirSync(path.join(dir, 'trash'));
    expect(left).toHaveLength(20);
    expect(left.some((n) => n.startsWith(e.id))).toBe(false);
    expect(left.some((n) => n.startsWith(ids[0]!))).toBe(false);
    for (const id of ids.slice(1)) expect(left.some((n) => n.startsWith(id))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'entries'))).toEqual([]);
  });

  it('an entry over 1 MiB is refused, history is never pruned', () => {
    const big = (n: number): EntryContent => ({
      layout: { lines: [[{ id: 't', type: 'text', options: { text: 'x'.repeat(n) } }]] },
    });
    expect(
      codeOf(() => saveEntry(input({ kind: 'preset', content: big(ENTRY_LIMITS.fileBytes) }), dir))?.code,
    ).toBe('too-large');
    expect(fs.existsSync(path.join(dir, 'entries')) ? fs.readdirSync(path.join(dir, 'entries')) : []).toEqual(
      [],
    );
    const e = saveEntry(input({ kind: 'preset', content: big(600_000) }), dir);
    const before = bytes(e.id);
    expect(
      codeOf(() => saveEntry(input({ kind: 'preset', mode: 'update', content: big(600_000) }), dir)),
    ).toEqual({
      code: 'too-large',
      data: { id: e.id, limit: ENTRY_LIMITS.fileBytes },
    });
    expect(bytes(e.id).equals(before)).toBe(true);
    expect(fs.existsSync(`${fileOf(e.id)}.bak`)).toBe(false);
    expect(rawOf(e.id).versions).toHaveLength(1);
    expect(
      saveEntry(input({ kind: 'preset', mode: 'overwrite', content: big(10) }), dir).versions,
    ).toHaveLength(1);
  });

  it('readEntry rejects ids that are not u-<12 hex>', () => {
    handWrite('U-ABC', JSON.stringify(stored('u-aaaaaaaaaaaa')));
    expect(readEntry('../x', dir)).toBeNull();
    expect(readEntry('U-ABC', dir)).toBeNull();
    expect(readEntry('u-aaaaaaaaaaaa', dir)).toBeNull();
    expect(readEntry('', dir)).toBeNull();
  });

  it('readEntry returns the file and the raw object', () => {
    const e = saveEntry(input(), dir);
    const s = readEntry(e.id, dir)!;
    expect(s.file).toBe(fileOf(e.id));
    expect(s.raw.id).toBe(e.id);
    expect(s.entry).toEqual(e);
  });

  describe('store lock (WR-11)', () => {
    const lockFile = () => path.join(dir, '.lock');
    const wait = STORE_LOCK.waitMs;
    afterEach(() => {
      STORE_LOCK.waitMs = wait;
    });

    it('a write takes the lock and removes it afterwards, also after a refused write', () => {
      const e = saveEntry(input(), dir);
      expect(fs.existsSync(lockFile())).toBe(false);
      expect(codeOf(() => updateShare(e.id, false, 7, dir))?.code).toBe('changed');
      expect(fs.existsSync(lockFile())).toBe(false);
      expect(updateShare(e.id, false, 1, dir).rev).toBe(2);
    });

    it('a second writer is refused with busy while another holds the lock', () => {
      const e = saveEntry(input(), dir);
      const before = bytes(e.id);
      fs.writeFileSync(lockFile(), '');
      STORE_LOCK.waitMs = 60;
      expect(codeOf(() => updateShare(e.id, false, 1, dir))?.code).toBe('busy');
      expect(codeOf(() => saveEntry(input({ name: 'Other' }), dir))?.code).toBe('busy');
      expect(codeOf(() => writeProfile({ author: 'x' }, dir))?.code).toBe('busy');
      expect(bytes(e.id).equals(before)).toBe(true);
      expect(listEntries(dir)).toHaveLength(1);
      expect(fs.existsSync(lockFile())).toBe(true);
    });

    it('a writer waits for another process to finish, then goes ahead', async () => {
      const e = saveEntry(input(), dir);
      fs.writeFileSync(lockFile(), '');
      const child = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => require("fs").rmSync(process.argv[1], { force: true }), 300)', lockFile()],
        { stdio: 'ignore' },
      );
      const exited = once(child, 'exit');
      await once(child, 'spawn');
      STORE_LOCK.waitMs = 10_000;
      const next = updateShare(e.id, false, 1, dir);
      expect(next.rev).toBe(2);
      expect(fs.existsSync(lockFile())).toBe(false);
      await exited;
    });

    it('a lock older than 10 s is taken over', () => {
      const e = saveEntry(input(), dir);
      fs.writeFileSync(lockFile(), '');
      const old = new Date(Date.now() - 20_000);
      fs.utimesSync(lockFile(), old, old);
      STORE_LOCK.waitMs = 60;
      expect(updateShare(e.id, false, 1, dir).rev).toBe(2);
      expect(fs.existsSync(lockFile())).toBe(false);
    });

    it('two writers with the same rev: the second sees the first and is refused', () => {
      const e = saveEntry(input(), dir);
      const a = readEntry(e.id, dir)!.entry;
      const b = readEntry(e.id, dir)!.entry;
      commitEntry({ ...a, description: 'from the CLI' }, a.rev, dir);
      expect(codeOf(() => commitEntry({ ...b, description: 'from the editor' }, b.rev, dir))?.code).toBe(
        'changed',
      );
      expect(rawOf(e.id).description).toBe('from the CLI');
    });
  });
});

describe('catalog store: cols', () => {
  it('round-trips cols per version, keeps it when a save has none and drops an invalid one', () => {
    const e = saveEntry(input({ cols: 150 }), dir);
    expect(rawOf(e.id).versions[0].cols).toBe(150);
    const two = saveEntry(input({ mode: 'update', id: e.id, content: content('cwd'), now: at(1) }), dir);
    expect(two.versions.map((v) => v.cols)).toEqual([150, 150]);
    const three = saveEntry(input({ mode: 'update', id: e.id, cols: 90, now: at(2) }), dir);
    expect(three.versions.at(-1)!.cols).toBe(90);
    const over = saveEntry(input({ mode: 'overwrite', id: e.id, content: content('cwd'), now: at(3) }), dir);
    expect(over.versions.at(-1)!.cols).toBe(90);
    const over2 = saveEntry(input({ mode: 'overwrite', id: e.id, cols: 200, now: at(4) }), dir);
    expect(readEntry(e.id, dir)?.entry.versions.map((v) => v.cols)).toEqual([150, 150, 200]);
    const bad = saveEntry(input({ mode: 'update', id: e.id, cols: 7, now: at(5) }), dir);
    expect(bad.versions.at(-1)!.cols).toBe(200);
    expect(over2.rev).toBeGreaterThan(0);
    const restored = restoreEntry(e.id, 1, bad.rev, '', dir, at(6));
    expect(restored.versions.at(-1)!.cols).toBe(150);
  });

  it('loads an old file without cols and a hand-edited invalid one', () => {
    const plain = stored('u-0000000000a1');
    handWrite(plain.id, JSON.stringify(plain));
    expect(readEntry(plain.id, dir)?.entry.versions[0]).not.toHaveProperty('cols');
    const raw = JSON.parse(JSON.stringify(stored('u-0000000000a2')));
    raw.versions[0].cols = 'huge';
    handWrite(raw.id, JSON.stringify(raw));
    const got = readEntry(raw.id, dir)?.entry;
    expect(got).toBeTruthy();
    expect(got!.versions[0]).not.toHaveProperty('cols');
    const next = saveEntry(
      input({ kind: 'preset', name: raw.id, mode: 'update', id: raw.id, now: at(1) }),
      dir,
    );
    expect(next.versions.map((v) => v.cols)).toEqual([undefined, undefined]);
    expect(next.versions.at(-1)).not.toHaveProperty('cols');
  });
});

describe('catalog store: themes carry no cols (WR-07)', () => {
  it('drops cols on save, update and a hand-edited theme file', () => {
    const e = saveEntry(input({ kind: 'theme', content: { appearance: { theme: 'nord' } }, cols: 150 }), dir);
    expect(e.versions[0]).not.toHaveProperty('cols');
    expect(rawOf(e.id).versions[0]).not.toHaveProperty('cols');
    const up = saveEntry(
      input({
        kind: 'theme',
        content: { appearance: { theme: 'nord' } },
        mode: 'update',
        id: e.id,
        cols: 90,
        now: at(1),
      }),
      dir,
    );
    expect(up.versions.at(-1)).not.toHaveProperty('cols');
    const raw = rawOf(e.id);
    raw.versions[0].cols = 150;
    handWrite(e.id, JSON.stringify(raw));
    expect(readEntry(e.id, dir)!.entry.versions[0]).not.toHaveProperty('cols');
  });
});
