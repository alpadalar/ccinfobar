import type { Job } from './runner.js';

// later plans register update, usage, status, http, gh and repos here
export const JOBS: Job<unknown>[] = [];

export function jobFor(key: string, jobs: Job<unknown>[] = JOBS): Job<unknown> | undefined {
  return jobs.find((j) => j.keyRe.test(key));
}
