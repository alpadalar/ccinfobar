import { describe, it } from 'vitest';

describe('reference market server', () => {
  it.todo('register publisher returns a token once and stores only its sha256');
  it.todo('publish creates v1 and the index lists it');
  it.todo('a new version needs If-Match and answers 412 when stale');
  it.todo('overwrite is refused when allowOverwrite is false');
  it.todo('withdraw tombstones the entry and versions answer 410');
  it.todo('only the owner token may write its entries');
  it.todo('413 over 1 MiB, 415 without JSON, 429 past the rate limit');
  it.todo('path segments with traversal are rejected');
  it.todo('command/http content is rejected as data-only');
  it.todo('the data dir layout equals the static protocol paths');
});
