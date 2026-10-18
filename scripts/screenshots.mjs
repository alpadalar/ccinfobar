import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'dist', 'ccinfobar.js');
const marketJs = path.join(root, 'market', 'ccinfobar-market.mjs');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = path.resolve(flag('--out') ?? path.join(root, 'docs', 'images', 'screenshots'));
const only = flag('--only')?.split(',');
const format = flag('--format') ?? 'png';
const W = 1920;
const H = 1080;

if (typeof WebSocket !== 'function') {
  console.error('✗ needs Node 22 or newer (global WebSocket)');
  process.exit(1);
}
if (!fs.existsSync(cli)) {
  console.error('✗ dist/ccinfobar.js is missing; run npm run build first');
  process.exit(1);
}

function browser() {
  const names = [process.env.CHROME, 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
  for (const n of names) {
    if (!n) continue;
    if (path.isAbsolute(n) && fs.existsSync(n)) return n;
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [n], { stdio: 'ignore' });
      return n;
    } catch {}
  }
  throw new Error('No Chrome or Chromium found; set CHROME=/path/to/chrome');
}

const secrets = [os.homedir(), os.userInfo().username, root, os.tmpdir()].filter((x) => x && x.length > 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ccinfobar-shots-'));
const home = path.join(T, 'home');
const env = {
  PATH: process.env.PATH ?? '',
  SYSTEMROOT: process.env.SYSTEMROOT ?? '',
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  CCINFOBAR_CONFIG_DIR: path.join(home, '.config', 'ccinfobar'),
  CCINFOBAR_CACHE_DIR: path.join(home, '.cache', 'ccinfobar'),
  TMPDIR: path.join(T, 'tmp'),
  TEMP: path.join(T, 'tmp'),
  TMP: path.join(T, 'tmp'),
  CCINFOBAR_NO_UPDATE: '1',
  CCINFOBAR_NO_USAGE_API: '1',
  LANG: 'en_US.UTF-8',
};
for (const d of [env.CLAUDE_CONFIG_DIR, env.CCINFOBAR_CONFIG_DIR, env.CCINFOBAR_CACHE_DIR, env.TMPDIR]) {
  fs.mkdirSync(d, { recursive: true });
}
const config = path.join(env.CCINFOBAR_CONFIG_DIR, 'config.json');
const run = (...a) => execFileSync(process.execPath, [cli, ...a, '--config', config], { env, stdio: 'pipe' });

// a local marketplace, so the Marketplace tab shows without the network
function startMarket() {
  if (!fs.existsSync(marketJs))
    execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--market'], {
      stdio: 'ignore',
    });
  const child = spawn(
    process.execPath,
    [marketJs, '--data', path.join(T, 'market'), '--host', '127.0.0.1', '--port', '0'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`marketplace did not start: ${text}`)), 15000);
    child.stdout.on('data', (b) => {
      text += b;
      const m = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[0] });
      }
    });
    child.on('exit', () => reject(new Error(`marketplace exited: ${text}`)));
  });
}

// shots show the shipped default; requests still go to the local one
function shippedMarket() {
  const src = fs.readFileSync(path.join(root, 'src', 'catalog', 'store.ts'), 'utf8');
  return src.match(/DEFAULT_MARKETPLACE: string \| null = '(https:\/\/[^']+)'/)?.[1] ?? null;
}

// another publisher's entries
function publishOthers() {
  const dir = path.join(T, 'publisher');
  const penv = { ...env, CCINFOBAR_CONFIG_DIR: dir };
  const pconfig = path.join(dir, 'config.json');
  const prun = (...a) =>
    execFileSync(process.execPath, [cli, ...a, '--config', pconfig], { env: penv, stdio: 'pipe' });
  const save = (ref, name, kind, description) => {
    prun('catalog', 'apply', ref, '--yes');
    prun('catalog', 'save', name, '--kind', kind, '--author', 'Mia', '--description', description);
  };
  save('bundle/nord-minimal', 'Arctic focus', 'bundle', 'Nord colors, one quiet line');
  save('preset/cockpit', 'Pair session', 'preset', 'Cost, context and git for pairing');
  prun('catalog', 'apply', 'bundle/panel-dashboard', '--yes');
  // a link to show in the install review
  const cfg = JSON.parse(fs.readFileSync(pconfig, 'utf8'));
  cfg.lines[0].push({
    id: 'docs',
    type: 'link',
    options: { url: 'https://example.com/night-shift', text: 'docs' },
  });
  fs.writeFileSync(pconfig, JSON.stringify(cfg));
  prun(
    'catalog',
    'save',
    'Night shift',
    '--kind',
    'bundle',
    '--author',
    'Mia',
    '--description',
    'Boxed panel with limits and pace',
  );
  prun('catalog', 'publish', '--yes');
}

function seed() {
  run('catalog', 'apply', 'bundle/tokyo-night-limits', '--yes');
  run(
    'catalog',
    'save',
    'Late night',
    '--kind',
    'bundle',
    '--author',
    'dev',
    '--description',
    'Limits first, calm colors',
  );
  run('catalog', 'apply', 'preset/session', '--yes');
  run(
    'catalog',
    'save',
    'Focus mode',
    '--kind',
    'preset',
    '--author',
    'dev',
    '--description',
    'Session stats only',
  );
  run('catalog', 'apply', 'bundle/catppuccin-cockpit', '--yes');
  run('config', 'set', 'language', 'en');
}

function startEditor() {
  const child = spawn(process.execPath, [cli, 'edit', '--no-open', '--no-detect', '--config', config], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`editor did not start: ${text}`)), 15000);
    const read = (b) => {
      text += b;
      const m = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[0] });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', () => reject(new Error(`editor exited: ${text}`)));
  });
}

async function startChrome() {
  const dir = path.join(T, 'chrome');
  const child = spawn(
    browser(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--lang=en-US',
      `--window-size=${W},${H}`,
      'about:blank',
    ],
    { env: { ...env, LANG: 'en_US.UTF-8' }, stdio: 'ignore' },
  );
  const file = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await sleep(100);
  const port = fs.readFileSync(file, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageTarget = targets.find((t) => t.type === 'page');
  return { child, ws: pageTarget.webSocketDebuggerUrl };
}

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const w of waiters.splice(0)) {
        if (w.method === msg.method) w.resolve();
        else waiters.push(w);
      }
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const once = (method) => new Promise((resolve) => waiters.push({ method, resolve }));
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return { ready, send, once, close: () => ws.close() };
}

const SCREENS = [
  {
    stem: 'editor',
    open: 'true',
    press: `[...document.querySelectorAll('.chip[data-id]')].find((c) => c.textContent.includes('Context bar'))`,
    wait: `document.querySelector('.chip.selected')`,
  },
  {
    stem: 'presets',
    open: `document.getElementById('preset-btn').click()`,
    wait: `document.querySelector('.modal')`,
  },
  {
    stem: 'catalog',
    open: `document.getElementById('catalog-btn').click()`,
    wait: `document.querySelectorAll('.catalog-remote-row').length >= 3`,
  },
  {
    stem: 'catalog-details',
    open: `document.getElementById('catalog-btn').click()`,
    wait: `document.querySelector('.catalog-card')`,
    next: `(async () => {
      document.querySelector('[data-tab="system"]')?.click();
      await new Promise((r) => setTimeout(r, 400));
      [...document.querySelectorAll('.catalog-section[data-section="system"] .catalog-card')][0]?.click();
    })()`,
    nextWait: `document.querySelector('.catalog-detail-preview')`,
  },
  {
    stem: 'catalog-install',
    open: `document.getElementById('catalog-btn').click()`,
    wait: `document.querySelectorAll('.catalog-remote-row').length >= 3`,
    next: `(async () => {
      [...document.querySelectorAll('.catalog-remote-row')].find((r) => r.textContent.includes('Night shift'))?.click();
      for (let i = 0; i < 40 && !document.querySelector('.modal footer .btn.primary'); i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 300));
      [...document.querySelectorAll('.modal footer button')].find((b) => b.textContent.trim() === 'Install')?.click();
    })()`,
    nextWait: `document.querySelector('.catalog-install')`,
  },
  {
    stem: 'catalog-save',
    open: `document.getElementById('catalog-btn').click()`,
    wait: `document.querySelector('.catalog-card')`,
    next: `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save current as…')?.click()`,
    nextWait: `document.querySelector('.modal .input')`,
    fill: ['Mocha desk', 'Cockpit layout with the Catppuccin Mocha theme'],
  },
  {
    stem: 'themes',
    open: `document.getElementById('theme-btn').click()`,
    wait: `document.querySelector('.theme-card')`,
  },
  {
    stem: 'theme-builder',
    open: `document.getElementById('theme-btn').click()`,
    wait: `document.querySelector('.theme-card')`,
    next: `[...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'New theme')?.click()`,
    nextWait: `document.querySelectorAll('.modal').length > 1`,
    fill: ['Dusk', 'Soft pastels on a dark terminal'],
  },
  {
    stem: 'import',
    open: `document.getElementById('import').click()`,
    wait: `document.querySelector('.modal')`,
  },
  {
    stem: 'install',
    open: `(document.getElementById('install').hidden ? null : document.getElementById('install').click())`,
    wait: `document.querySelector('.modal')`,
    set: ['.modal input.input', 'ccinfobar'],
  },
  {
    stem: 'settings',
    open: `document.getElementById('settings-btn').click()`,
    wait: `document.querySelector('.modal')`,
  },
];

async function main() {
  const shots = [];
  let editor;
  let chrome;
  let page;
  let market;
  try {
    market = await startMarket();
    env.CCINFOBAR_MARKETPLACE_URL = market.url;
    publishOthers();
    seed();
    editor = await startEditor();
    chrome = await startChrome();
    page = cdp(chrome.ws);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const evaluate = async (expression) =>
      (await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
        ?.value;
    const waitFor = async (expr, ms = 8000) => {
      for (let i = 0; i < ms / 100; i++) {
        if (await evaluate(`!!(${expr})`)) return true;
        await sleep(100);
      }
      return false;
    };
    const hideTemp = JSON.stringify(home);
    const label = shippedMarket();
    const scrub = `(() => {
      const home = ${hideTemp};
      const market = ${JSON.stringify(label ? market.url : home)};
      const label = ${JSON.stringify(label ?? '~')};
      const fix = (s) => s.split(home).join('~').split(market).join(label);
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const has = (s) => s.includes(home) || s.includes(market);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (has(n.nodeValue)) n.nodeValue = fix(n.nodeValue);
      for (const el of document.querySelectorAll('input, textarea')) if (has(el.value)) el.value = fix(el.value);
      for (const el of document.querySelectorAll('[title]')) if (has(el.title)) el.title = fix(el.title);
      return document.body.innerText.includes(${JSON.stringify(T)});
    })()`;
    fs.mkdirSync(out, { recursive: true });
    for (const scheme of ['dark', 'light']) {
      await page.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      for (const s of SCREENS) {
        if (only && !only.includes(s.stem)) continue;
        const loaded = page.once('Page.loadEventFired');
        await page.send('Page.navigate', { url: editor.url });
        await loaded;
        await waitFor(`!document.getElementById('boot')`);
        await waitFor(`document.querySelector('.chip[data-id]')`);
        await evaluate('document.fonts.ready.then(() => true)');
        await sleep(400);
        await evaluate(s.open);
        if (s.press) {
          const box = await evaluate(`(() => {
            const r = (${s.press})?.getBoundingClientRect();
            return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          })()`);
          if (box) {
            for (const type of ['mousePressed', 'mouseReleased'])
              await page.send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 });
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: W - 4, y: H - 4 });
          }
        }
        if (s.wait) await waitFor(s.wait);
        await sleep(600);
        if (s.next) {
          await evaluate(s.next);
          if (s.nextWait) await waitFor(s.nextWait);
          await sleep(600);
        }
        if (s.fill) {
          await evaluate(`(() => {
            const vals = ${JSON.stringify(s.fill)};
            const inputs = [...document.querySelectorAll('.modal input.input, .modal textarea')].filter((x) => !x.value);
            inputs.forEach((el, i) => {
              if (vals[i] === undefined) return;
              el.value = vals[i];
              el.dispatchEvent(new Event('input', { bubbles: true }));
            });
          })()`);
          await sleep(300);
        }
        if (s.set) {
          await evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(s.set[0])});
            if (!el) return;
            el.value = ${JSON.stringify(s.set[1])};
            el.dispatchEvent(new Event('input', { bubbles: true }));
          })()`);
          await sleep(500);
        }
        await evaluate(`document.activeElement?.blur?.()`);
        await sleep(200);
        if (await evaluate(scrub)) throw new Error(`${s.stem}: temp path still visible`);
        const leak = await evaluate(`(() => {
          const text = [document.body.innerText, ...[...document.querySelectorAll('input, textarea')].map((e) => e.value)].join(' ');
          const x = ${JSON.stringify(secrets)}.find((x) => text.includes(x)); return x ? text.slice(Math.max(0, text.indexOf(x) - 80), text.indexOf(x) + 60) : null;
        })()`);
        if (leak) throw new Error(`${s.stem}: private text visible: ${leak}`);
        const shot = await page.send('Page.captureScreenshot', {
          format,
          ...(format === 'png' ? {} : { quality: 90 }),
          captureBeyondViewport: false,
        });
        const file = path.join(out, `${s.stem}-${scheme}.${format}`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        shots.push(file);
        console.log(`✓ ${path.relative(root, file)}`);
      }
    }
  } finally {
    page?.close();
    if (chrome) chrome.child.kill();
    if (editor) editor.child.kill();
    if (market) market.child.kill();
    await sleep(500);
    fs.rmSync(T, { recursive: true, force: true, maxRetries: 5 });
  }
  const bytes = shots.reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(`${shots.length} screenshots, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
});
