import { describe, it } from 'vitest';

describe('catalog store', () => {
  it.todo('save new writes entries/<u-id>.json with rev 1');
  it.todo('save with an existing kind+name and mode new throws exists with id/version/name (D-06)');
  it.todo('update appends, overwrite replaces in place');
  it.todo('restore appends a new version');
  it.todo('a stale rev throws changed (no lost update)');
  it.todo('replace writes .bak with the previous bytes first');
  it.todo('unknown keys survive a rewrite');
  it.todo('a BOM-prefixed entry file is read');
  it.todo('one corrupt file does not hide the others');
  it.todo('delete moves to trash and keeps the newest 20');
  it.todo('an entry over 1 MiB is refused, history is never pruned');
});
