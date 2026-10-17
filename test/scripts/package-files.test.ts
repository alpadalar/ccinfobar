import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// D-03: the Worker and the reference server never ship to users
describe('npm package contents', () => {
  it('publishes only dist/ and schema/', () => {
    expect(pkg.files).toEqual(['dist/', 'schema/']);
  });

  it('has no .npmignore that could widen the list', () => {
    expect(fs.existsSync(path.join(root, '.npmignore'))).toBe(false);
  });

  it('points bin into dist/', () => {
    expect(pkg.bin).toEqual({ ccinfobar: 'dist/ccinfobar.js' });
  });
});
