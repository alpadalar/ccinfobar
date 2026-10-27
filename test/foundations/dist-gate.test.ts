import { expect, it } from 'vitest';
import { hasDist } from '../dist.js';

it.skipIf(!process.env.CI)('dist/ccinfobar.js exists in CI', () => {
  expect(hasDist, 'dist/ccinfobar.js missing: run npm run build before the tests').toBe(true);
});
