import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const webDir = path.join(root, 'src/editor/web');

async function buildEditorHtml() {
  const entry = path.join(webDir, 'app.ts');
  if (!fs.existsSync(entry)) return '';
  const js = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    minify: !watch,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
  });
  const css = fs.existsSync(path.join(webDir, 'style.css'))
    ? fs.readFileSync(path.join(webDir, 'style.css'), 'utf8')
    : '';
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const script = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  return html
    .replace('<!--STYLE-->', () => `<style>${css}</style>`)
    .replace('<!--SCRIPT-->', () => `<script>${script}</script>`);
}

async function build() {
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  const editorHtml = await buildEditorHtml();
  await esbuild.build({
    entryPoints: [path.join(root, 'src/bin.ts')],
    outdir: path.join(root, 'dist'),
    entryNames: 'ccinfobar',
    chunkNames: 'chunks/[name]-[hash]',
    splitting: true,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    minify: false,
    legalComments: 'none',
    define: {
      __VERSION__: JSON.stringify(pkg.version),
      __EDITOR_HTML__: JSON.stringify(editorHtml),
    },
  });
  fs.chmodSync(path.join(root, 'dist/ccinfobar.js'), 0o755);
  console.log(`built dist/ccinfobar.js v${pkg.version}${editorHtml ? ' with editor' : ''}`);
}

async function docs(script = 'gen-docs') {
  const out = path.join(root, `node_modules/.cache/ccinfobar-${script}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(root, `scripts/${script}.ts`)],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
  });
  process.argv[2] = root;
  await import(`${out}?t=${Date.now()}`);
}

if (process.argv.includes('--docs')) await docs();
else if (process.argv.includes('--demo')) await docs('demo-gif');
else await build();

if (watch) {
  console.log('watching src/ ...');
  let timer;
  fs.watch(path.join(root, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e) => console.error(e.message)), 100);
  });
}
