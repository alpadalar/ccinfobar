import { describe, it } from 'vitest';

describe('editor catalog routes', () => {
  it.todo('GET /api/catalog returns system, user, profile, endpoint');
  it.todo('POST /api/catalog/previews renders a batch');
  it.todo('POST /api/catalog/save answers 409 exists with id/version/name');
  it.todo('POST /api/catalog/save with mode update/overwrite');
  it.todo('a stale rev answers 409 changed');
  it.todo('restore, share, delete routes');
  it.todo('install-theme installs with a -2 suffix on collision (D-26)');
  it.todo('routes need the editor token and a good Host/Origin');
  it.todo('error JSON is English with errorId');
  it.todo('publish/plan shows the exact payload; publish without an endpoint sends nothing');
});
