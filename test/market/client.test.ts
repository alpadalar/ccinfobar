import { describe, it } from 'vitest';

describe('market client', () => {
  it.todo('no endpoint means zero fetch calls (D-09)');
  it.todo('http endpoints are refused except loopback');
  it.todo('redirects are same-origin, max 3, never on writes');
  it.todo('responses over the cap fail with too-large');
  it.todo('timeouts fail with a fixed code');
  it.todo('a version whose hash does not match is rejected');
  it.todo('error bodies map to protocol codes without echoing URLs or tokens');
  it.todo('429 carries retryAfterMs');
});
