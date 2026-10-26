import { describe, expect, it } from 'vitest';
import { sampleGit, sampleJj } from '../../src/core/sample.js';
import type { JjReader } from '../../src/data/jj.js';
import { forkInfo } from '../../src/widgets/git.js';
import { ctxWith, renderWidget, withLang } from '../helpers.js';

const JJ_TYPES = ['jj-bookmarks', 'jj-workspace', 'jj-revision', 'jj-description', 'jj-changes'];

function jj(over: Partial<JjReader> = {}): () => JjReader {
  return () => ({ ...sampleJj(), ...over });
}

const forked = () => ({
  ...sampleGit(),
  remoteUrl: 'git@github.com:me/demo.git',
  upstreamUrl: 'git@github.com:acme/demo.git',
});

describe('jj widgets', () => {
  it('render bookmarks with a limit and separator', () => {
    const ctx = ctxWith({ jj: jj({ bookmarks: () => ['main', 'dev', 'x', 'y'] }) });
    expect(renderWidget('jj-bookmarks', ctx)).toBe('main, dev, x +1');
    expect(renderWidget('jj-bookmarks', ctx, { options: { separator: ' | ', maxBookmarks: 2 } })).toBe(
      'main | dev +2',
    );
    expect(renderWidget('jj-bookmarks', ctx, { options: { maxBookmarks: 0 } })).toBe('main +3');
    expect(renderWidget('jj-bookmarks', ctxWith({ jj: jj({ bookmarks: () => [] }) }))).toBeNull();
    expect(renderWidget('jj-bookmarks', ctxWith({ jj: jj({ bookmarks: () => null }) }))).toBeNull();
  });

  it('render the workspace', () => {
    expect(renderWidget('jj-workspace', ctxWith())).toBe('default');
    expect(renderWidget('jj-workspace', ctxWith(), { options: { hideDefault: true } })).toBeNull();
    const other = ctxWith({ jj: jj({ workspace: () => 'review' }) });
    expect(renderWidget('jj-workspace', other, { options: { hideDefault: true } })).toBe('review');
  });

  it('render the change id and description', () => {
    expect(renderWidget('jj-revision', ctxWith())).toBe('kkmpptxz');
    expect(renderWidget('jj-description', ctxWith())).toBe('Wire GSD widgets into renderer');
    const empty = ctxWith({ jj: jj({ change: () => ({ id: 'kk', description: '' }) }) });
    expect(renderWidget('jj-description', empty)).toBe('(no description)');
    expect(withLang('tr', () => renderWidget('jj-description', empty))).toBe('(açıklama yok)');
  });

  it('render line changes, snapshotting by default', () => {
    const seen: boolean[] = [];
    const ctx = ctxWith({
      jj: jj({
        diff: (snapshot) => {
          seen.push(snapshot);
          return { insertions: 42, deletions: 10 };
        },
      }),
    });
    expect(renderWidget('jj-changes', ctx)).toBe('+42 -10');
    expect(renderWidget('jj-changes', ctx, { options: { snapshot: false } })).toBe('+42 -10');
    expect(seen).toEqual([true, false]);
  });

  it('return null without a jj repo', () => {
    for (const type of JJ_TYPES) {
      expect(renderWidget(type, ctxWith({ jj: () => null }))).toBeNull();
    }
    const none = ctxWith({ jj: jj({ change: () => null, diff: () => null }) });
    expect(renderWidget('jj-revision', none)).toBeNull();
    expect(renderWidget('jj-description', none)).toBeNull();
    expect(renderWidget('jj-changes', none)).toBeNull();
  });
});

describe('fork detection', () => {
  it('reads the upstream or fork remote', () => {
    expect(forkInfo(forked())).toEqual({ fork: 'me/demo', parent: 'acme/demo' });
    expect(
      forkInfo({
        ...sampleGit(),
        remoteUrl: 'git@github.com:acme/demo.git',
        forkUrl: 'https://github.com/me/demo',
      }),
    ).toEqual({ fork: 'me/demo', parent: 'acme/demo' });
    expect(
      forkInfo({
        ...sampleGit(),
        remoteUrl: 'git@github.com:acme/demo.git',
        upstreamUrl: 'git@github.com:Acme/Demo',
      }),
    ).toBeNull();
    expect(forkInfo(sampleGit())).toBeNull();
    expect(
      forkInfo({ ...sampleGit(), remoteUrl: null, upstreamUrl: 'git@github.com:acme/demo.git' }),
    ).toBeNull();
    expect(forkInfo(null)).toBeNull();
  });

  it('git-is-fork marks a fork', () => {
    const ctx = ctxWith({ git: forked });
    expect(renderWidget('git-is-fork', ctx)).toBe('⑂');
    expect(renderWidget('git-is-fork', ctxWith({ git: forked, config: { charset: 'text' } }))).toBe('fork');
    expect(renderWidget('git-is-fork', ctx, { options: { symbol: 'F' } })).toBe('F');
    expect(renderWidget('git-is-fork', ctx, { options: { showParent: true } })).toBe('⑂ acme/demo');
    expect(renderWidget('git-is-fork', ctxWith())).toBeNull();
    expect(renderWidget('git-is-fork', ctxWith({ git: () => null }))).toBeNull();
  });

  it('git-repo shows only the owner in a fork when asked', () => {
    const on = { options: { ownerOnlyWhenFork: true } };
    expect(renderWidget('git-repo', ctxWith({ git: forked }), on)).toBe('acme');
    expect(renderWidget('git-repo', ctxWith({ git: forked }))).toBe('acme/acme-app');
    expect(renderWidget('git-repo', ctxWith(), on)).toBe('acme/acme-app');
  });
});
