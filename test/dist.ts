import fs from 'node:fs';
import path from 'node:path';

export const bin = path.resolve(__dirname, '../dist/ccinfobar.js');
export const hasDist = fs.existsSync(bin);
export const skipDist = !hasDist && !process.env.CI;
