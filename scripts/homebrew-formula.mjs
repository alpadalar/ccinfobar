// Run by the owner after `npm publish`: fills the Homebrew formula url and sha256 from the npm registry.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const URL_RE = /^( {2}url ")https:\/\/registry\.npmjs\.org\/ccinfobar\/-\/ccinfobar-[^"]+\.tgz(")$/m;
export const SHA_RE = /^( {2}sha256 ")[0-9a-f]{64}(")$/m;

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
// first release with the brew install kind; older ones update themselves with npm
export const MIN_BREW = '0.6.3';
const ZERO_SHA = '0'.repeat(64);
const VERSION_RE = new RegExp(`/ccinfobar-(${SEMVER})\\.tgz"$`, 'm');
const SHA_VALUE_RE = /^ {2}sha256 "([0-9a-f]{64})"$/m;
const REGISTRY = 'https://registry.npmjs.org/ccinfobar';
const MAX_BYTES = 50 * 1024 * 1024;

const REQUIRED = [
  'depends_on "node"',
  'system "npm", "install", *std_npm_args',
  'bin.install_symlink libexec.glob("bin/*")',
  'strategy :npm',
  'test do',
  'def caveats',
  'ccinfobar uninstall',
];
const FORBIDDEN = [
  ['post_install', /post_install/],
  ['ccinfobar install', /ccinfobar["']?,\s*["']install/],
];
const VALUED = ['--root', '--version', '--tarball'];

// release numbers only, so a prerelease after 0.6.2 passes
export function belowFloor(version) {
  const a = version.split(/[-+]/)[0].split('.').map(Number);
  const b = MIN_BREW.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

const floorProblem = (version) => `${version} has no Homebrew detection; the tap needs ${MIN_BREW} or later`;

export const isPlaceholder = (text) => text.match(SHA_VALUE_RE)?.[1] === ZERO_SHA;

const count = (text, re) => text.match(new RegExp(re.source, 'gm'))?.length ?? 0;
const tarballUrl = (version) => `${REGISTRY}/-/ccinfobar-${version}.tgz`;

export function checkFormula(text) {
  const problems = [];
  const urls = count(text, URL_RE);
  if (urls !== 1) problems.push(`expected one registry url line, found ${urls}`);
  const shas = count(text, SHA_RE);
  if (shas !== 1) problems.push(`expected one sha256 line, found ${shas}`);
  for (const s of REQUIRED) if (!text.includes(s)) problems.push(`missing ${s}`);
  for (const [name, re] of FORBIDDEN) if (re.test(text)) problems.push(`must not contain ${name}`);
  const version = text.match(VERSION_RE)?.[1];
  if (version && !isPlaceholder(text) && belowFloor(version)) problems.push(floorProblem(version));
  return problems;
}

export function renderFormula(text, { version, sha256 }) {
  const urls = count(text, URL_RE);
  const shas = count(text, SHA_RE);
  if (urls !== 1) throw new Error(`expected one registry url line, found ${urls}`);
  if (shas !== 1) throw new Error(`expected one sha256 line, found ${shas}`);
  return text
    .replace(URL_RE, (_, a, b) => `${a}${tarballUrl(version)}${b}`)
    .replace(SHA_RE, (_, a, b) => `${a}${sha256}${b}`);
}

export function sri512(buf) {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`;
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

class Fail extends Error {}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Fail(`${url} returned ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Fail(`${url} is over 50 MB`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Fail(`${url} is over 50 MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function registryTarball(version) {
  const meta = JSON.parse((await download(`${REGISTRY}/${version}`)).toString('utf8'));
  const dist = meta?.dist ?? {};
  if (dist.tarball !== tarballUrl(version)) throw new Fail(`unexpected tarball url: ${dist.tarball}`);
  if (typeof dist.integrity !== 'string') throw new Fail('registry metadata has no dist.integrity');
  const buf = await download(dist.tarball);
  if (sri512(buf) !== dist.integrity) throw new Fail('integrity mismatch');
  return buf;
}

function value(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Fail(`${flag} needs a value`);
  return v;
}

function checkArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUED.includes(a)) i++;
    else if (a === '--check') continue;
    else if (/^--[a-z]+=/.test(a)) throw new Fail(`use "${a.replace('=', ' ')}", not "${a}"`);
    else throw new Fail(`unknown argument: ${a}`);
  }
}

// package/package.json from an npm tarball
export function tarballPackage(buf) {
  let tar;
  try {
    tar = gunzipSync(buf);
  } catch {
    throw new Fail('tarball is not gzip');
  }
  for (let at = 0; at + 512 <= tar.length; ) {
    const head = tar.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    const field = (from, len) =>
      head
        .subarray(from, from + len)
        .toString('utf8')
        .replace(/\0[\s\S]*$/, '');
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    if (name === 'package/package.json') {
      try {
        return JSON.parse(tar.subarray(at + 512, at + 512 + size).toString('utf8'));
      } catch {
        throw new Fail('tarball package.json is not JSON');
      }
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Fail('tarball has no package/package.json');
}

function read(file, root) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new Fail(`missing ${path.relative(root, file) || file}`);
  }
}

export async function run(args) {
  checkArgs(args);
  const rootArg = value(args, '--root');
  const root = rootArg ? path.resolve(rootArg) : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const formulaFile = path.join(root, 'packaging', 'homebrew', 'ccinfobar.rb');
  const before = read(formulaFile, root);

  if (args.includes('--check')) {
    const problems = checkFormula(before);
    for (const p of problems) console.error(`homebrew-formula: ${p}`);
    if (problems.length) return 1;
    if (isPlaceholder(before))
      console.log(`homebrew-formula: placeholder sha256; fill in ${MIN_BREW} or later after publishing`);
    console.log('homebrew-formula: formula ok');
    return 0;
  }

  const version = value(args, '--version') ?? JSON.parse(read(path.join(root, 'package.json'), root)).version;
  if (typeof version !== 'string' || !new RegExp(`^${SEMVER}$`).test(version))
    throw new Fail(`bad version: ${version}`);
  if (belowFloor(version)) throw new Fail(floorProblem(version));

  const tarball = value(args, '--tarball');
  let buf;
  if (tarball) {
    try {
      buf = fs.readFileSync(path.resolve(tarball));
    } catch {
      throw new Fail(`cannot read ${tarball}`);
    }
    const pkg = tarballPackage(buf);
    if (pkg?.name !== 'ccinfobar' || pkg?.version !== version)
      throw new Fail(`tarball is ${pkg?.name}@${pkg?.version}, not ccinfobar@${version}`);
    console.error(
      "homebrew-formula: --tarball skips npm's integrity check; the tap needs the sha256 of the registry tarball",
    );
  } else {
    buf = await registryTarball(version);
  }

  const sha256 = sha256Hex(buf);
  let after;
  try {
    after = renderFormula(before, { version, sha256 });
  } catch (err) {
    throw new Fail(err.message);
  }
  const problems = checkFormula(after);
  if (problems.length) throw new Fail(problems.join('; '));
  if (after === before) {
    console.log(`homebrew-formula: already at ${version}`);
    return 0;
  }
  fs.writeFileSync(formulaFile, after);
  console.log(`homebrew-formula: ${version} ${sha256}`);
  return 0;
}

async function main() {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (err) {
    console.error(`homebrew-formula: ${err instanceof Fail ? err.message : String(err?.message ?? err)}`);
    process.exitCode = 1;
  }
}

// node resolves the entry through realpath, so a symlinked checkout still matches
function isMain() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(process.argv[1] ?? ''))).href;
  } catch {
    return false;
  }
}

if (process.argv[1] && isMain()) await main();
