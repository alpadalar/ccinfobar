import { describe, it } from 'vitest';

describe('catalog model', () => {
  it.todo('splitContent keeps only LAYOUT_KEYS for preset');
  it.todo('splitContent keeps only APPEARANCE_KEYS for theme');
  it.todo('stripPersonal drops budget, profiles, language, update, charset');
  it.todo('newEntry starts at version 1 with share pending when share is on (D-08)');
  it.todo('appendVersion adds version n+1 and keeps history (D-06)');
  it.todo('overwriteVersion keeps the version number (D-06)');
  it.todo('restoreVersion appends a copy with restoredFrom (D-06)');
  it.todo('setShare moves local↔pending and published→withdraw-pending (D-08)');
  it.todo('shareView reports outdated when the latest hash differs');
  it.todo('mergeRaw keeps unknown top-level and per-version keys (D-04)');
  it.todo('slug keeps the existing output; marketSlug matches the protocol id rule (D-26)');
});
