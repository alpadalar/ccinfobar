import type { Job } from './runner.js';
import { updateJob } from './update.js';
import { usageJob } from './usage.js';

// later plans register usage, status, http, gh and repos here
export const JOBS: Job<unknown>[] = [updateJob as Job<unknown>, usageJob as Job<unknown>];

export function jobFor(key: string, jobs: Job<unknown>[] = JOBS): Job<unknown> | undefined {
  return jobs.find((j) => j.keyRe.test(key));
}
