import { describe } from 'vitest';
import { describeConformance } from './conformance.js';
import { hasSqlite } from './d1-sqlite.js';
import { makeWorkerTarget } from './worker-target.js';

describe.skipIf(!hasSqlite)('worker', () => {
  describeConformance('worker', makeWorkerTarget);
});
