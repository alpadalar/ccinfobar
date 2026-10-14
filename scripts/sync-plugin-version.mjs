// Runs from `npm version`: copies the package.json version into plugin.json and INSTALL.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const check = args.includes('--check');
const rootIdx = args.indexOf('--root');
const root =
  rootIdx >= 0 && args[rootIdx + 1]
    ? path.resolve(args[rootIdx + 1])
    : path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const pkgFile = path.join(root, 'package.json');
const pluginFile = path.join(root, 'plugin', '.claude-plugin', 'plugin.json');
const installFile = path.join(root, 'INSTALL.md');

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    console.error(`sync-plugin-version: missing ${path.relative(root, file) || file}`);
    process.exit(1);
  }
}

const version = JSON.parse(read(pkgFile)).version;
if (typeof version !== 'string' || !new RegExp(`^${SEMVER}$`).test(version)) {
  console.error(`sync-plugin-version: bad version in package.json: ${version}`);
  process.exit(1);
}

// keep Biome's formatting: replace the value in place
function syncPlugin(text) {
  const obj = JSON.parse(text);
  if (obj.version === version) return text;
  const re = /("version"\s*:\s*)"[^"]*"/;
  if (!re.test(text)) return `${JSON.stringify({ ...obj, version }, null, 2)}\n`;
  return text.replace(re, (_, k) => `${k}${JSON.stringify(version)}`);
}

function syncInstall(text) {
  return text
    .replace(new RegExp(`ccinfobar@${SEMVER}`, 'g'), `ccinfobar@${version}`)
    .replace(new RegExp(`/blob/v${SEMVER}/`, 'g'), `/blob/v${version}/`)
    .replace(new RegExp(`#v${SEMVER}`, 'g'), `#v${version}`);
}

const changed = [];
for (const [file, sync] of [
  [pluginFile, syncPlugin],
  [installFile, syncInstall],
]) {
  const before = read(file);
  const after = sync(before);
  if (after === before) continue;
  changed.push(path.relative(root, file).split(path.sep).join('/'));
  if (!check) fs.writeFileSync(file, after);
}

if (check) {
  if (changed.length) {
    console.error(`sync-plugin-version: not at ${version}: ${changed.join(', ')}`);
    process.exit(1);
  }
} else if (changed.length) {
  console.log(`sync-plugin-version: ${version} -> ${changed.join(', ')}`);
} else {
  console.log(`sync-plugin-version: already at ${version}`);
}
