import { describe } from 'vitest';
import { describeConformance } from './conformance.js';
import { skipSqlite } from './d1-sqlite.js';
import { makeWorkerTarget } from './worker-target.js';

describe.skipIf(skipSqlite)('worker', () => {
  describeConformance('worker', makeWorkerTarget);
});
