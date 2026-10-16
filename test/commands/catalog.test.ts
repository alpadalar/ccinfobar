import { describe, it } from 'vitest';

describe('catalog command', () => {
  it.todo('list prints user entries then system entries grouped by kind');
  it.todo('list --json is English and has schema 1');
  it.todo('show <ref> prints a preview');
  it.todo('apply writes with a backup and keeps language and personal keys');
  it.todo('apply --dry-run writes nothing');
  it.todo('save asks --update or --overwrite on a name clash when not a TTY');
  it.todo('save remembers the author (D-07)');
  it.todo('history lists versions; restore appends');
  it.todo('share/unshare change the publish state');
  it.todo('delete needs --yes when not a TTY');
  it.todo('publish with no endpoint sends nothing and keeps entries waiting (D-09)');
});
