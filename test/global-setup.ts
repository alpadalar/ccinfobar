import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// one parent dir per run, removed at teardown
export default function setup(): () => void {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-run-')));
  process.env.CCIB_TEST_PARENT = dir;
  return () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
