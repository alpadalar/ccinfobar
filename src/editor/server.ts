import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { currentStatusLine, defaultCommand, install } from '../commands/install.js';
import { normalizeConfig, saveConfig } from '../core/config.js';
import { availablePresets, loadForUse } from '../core/load.js';
import { lastPayloadPath, tildify } from '../core/paths.js';
import { deleteUserPreset, listPresets, presetsDir, saveUserPreset } from '../core/presets.js';
import { renderPreview } from '../core/preview.js';
import { resolveAppearance } from '../core/renderer.js';
import {
  deleteUserTheme,
  listThemes,
  parseThemeInput,
  resolveThemeInput,
  STYLES,
  saveUserTheme,
  themesDir,
  themeToInput,
} from '../core/themes.js';
import type { Config, WidgetItem } from '../core/types.js';
import { gsdInstalled } from '../data/gsd.js';
import { ALL_WIDGETS, CATEGORIES } from '../widgets/index.js';
import type { TerminalColors } from './terminal-colors.js';

declare const __VERSION__: string;
declare const __EDITOR_HTML__: string;

const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';
const MAX_BODY = 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DEMO_TYPES = ['model', 'cwd', 'git-branch', 'context-bar', 'gsd-phase', 'gsd-plans', 'session-cost'];

export interface EditorOptions {
  configPath: string;
  port?: number | undefined;
  open?: boolean;
  host?: string;
  terminal?: TerminalColors | null;
}

export interface EditorHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const FALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>ccinfobar editor</title>
<body style="font:16px system-ui;background:#111;color:#eee;padding:3rem">
<h1>Editor bundle not built</h1><p>Run <code>npm run build</code> and start the editor again.</p></body>`;

function editorHtml(): string {
  return (typeof __EDITOR_HTML__ === 'string' && __EDITOR_HTML__) || FALLBACK_HTML;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function openBrowser(url: string): void {
  try {
    let child: ReturnType<typeof spawn>;
    if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '""', `"${url.replace(/&/g, '^&')}"`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
  } catch {}
}

function widgetCatalog() {
  return ALL_WIDGETS.map((w) => ({
    type: w.type,
    name: w.name,
    category: w.category,
    description: w.description,
    label: w.label,
    icon: w.icon,
    color: w.color,
    options: w.options ?? [],
    sample: w.sample,
    hidden: w.hidden ?? false,
  }));
}

function claudeInfo(command: string) {
  let statusLine: unknown = null;
  try {
    statusLine = currentStatusLine();
  } catch {}
  const cmd = (statusLine as { command?: unknown } | null)?.command;
  return {
    statusLine,
    installed: typeof cmd === 'string' && cmd.includes('ccinfobar'),
    defaultCommand: command,
  };
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

export async function startEditor(opts: EditorOptions): Promise<EditorHandle> {
  const host = opts.host ?? '127.0.0.1';
  const token = crypto.randomBytes(16).toString('hex');
  const command = defaultCommand();
  const gsd = gsdInstalled();
  const presetList = () =>
    availablePresets(gsd).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      source: p.source ?? 'builtin',
      config: p.build(),
    }));
  let port = 0;

  const hostOk = (h: string | undefined) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const originOk = (o: string) => o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hostOk(req.headers.host)) throw new HttpError(403, 'Forbidden host');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (url.pathname === '/' && method === 'GET') {
      const html = editorHtml();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(html);
      return;
    }

    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
    if (req.headers['x-ccinfobar-token'] !== token) throw new HttpError(401, 'Invalid token');
    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin !== undefined && !originOk(origin)) throw new HttpError(403, 'Forbidden origin');
    }

    if (method === 'DELETE' && url.pathname.startsWith('/api/presets/')) {
      let id = '';
      try {
        id = decodeURIComponent(url.pathname.slice('/api/presets/'.length));
      } catch {}
      if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid preset id');
      if (listPresets().find((p) => p.id === id)?.source !== 'user')
        throw new HttpError(404, 'Not a user preset');
      deleteUserPreset(id);
      send(res, 200, { ok: true, presets: presetList() });
      return;
    }

    if (method === 'DELETE' && url.pathname.startsWith('/api/themes/')) {
      let id = '';
      try {
        id = decodeURIComponent(url.pathname.slice('/api/themes/'.length));
      } catch {}
      if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid theme id');
      const theme = listThemes().find((t) => t.id === id);
      if (theme?.source !== 'user') throw new HttpError(404, 'Not a user theme');
      deleteUserTheme(id);
      send(res, 200, { ok: true, themes: listThemes() });
      return;
    }

    const route = `${method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/state': {
        const loaded = loadForUse(opts.configPath, () => gsd);
        send(res, 200, {
          version: VERSION,
          configPath: tildify(opts.configPath),
          configError: loaded.error ?? null,
          config: loaded.config,
          savedConfig: loaded.config,
          widgets: widgetCatalog(),
          categories: CATEGORIES,
          presets: presetList(),
          presetsDir: tildify(presetsDir()),
          gsdInstalled: gsd,
          themes: listThemes(),
          styles: STYLES,
          themesDir: tildify(themesDir()),
          claude: claudeInfo(command),
          hasLastPayload: fs.existsSync(lastPayloadPath()),
          terminal: opts.terminal ?? null,
        });
        return;
      }
      case 'POST /api/preview': {
        const body = asObject(await readBody(req));
        const config = normalizeConfig(body.config);
        if (config.colorLevel === 'auto') config.colorLevel = 3;
        const source = body.source === 'last' ? 'last' : 'sample';
        const width = Math.max(20, Math.min(400, Math.floor(Number(body.width)) || 130));
        const draft = body.theme === undefined ? undefined : parseThemeInput(body.theme);
        if (draft?.extends !== undefined && !ID_RE.test(draft.extends)) {
          throw new HttpError(400, 'Invalid extends id');
        }
        send(res, 200, {
          lines: renderPreview(config, source, width, draft ? resolveThemeInput(draft) : undefined),
        });
        return;
      }
      case 'POST /api/normalize': {
        const body = asObject(await readBody(req));
        send(res, 200, { config: normalizeConfig(body.config) });
        return;
      }
      case 'POST /api/theme-previews': {
        const body = asObject(await readBody(req));
        const config = normalizeConfig(body.config);
        if (config.colorLevel === 'auto') config.colorLevel = 3;
        const source = body.source === 'last' ? 'last' : 'sample';
        const width = Math.max(20, Math.min(400, Math.floor(Number(body.width)) || 100));
        const own = config.lines.find((l) => l.length > 0);
        const demo: WidgetItem[] = own ?? DEMO_TYPES.map((type, i) => ({ id: `${type}-${i + 1}`, type }));
        const previews: Record<string, string[]> = {};
        for (const t of listThemes()) {
          const cfg: Config = {
            ...config,
            theme: t.id,
            lines: [demo],
            style: undefined,
            separator: undefined,
            separatorColor: undefined,
            padding: undefined,
            glyphs: undefined,
            tui: undefined,
          };
          previews[t.id] = renderPreview(cfg, source, width);
        }
        send(res, 200, { previews });
        return;
      }
      case 'POST /api/themes': {
        const body = asObject(await readBody(req));
        let input = parseThemeInput(body.theme);
        if (body.fromConfig !== undefined && input.id && ID_RE.test(input.id)) {
          const a = resolveAppearance(normalizeConfig(body.fromConfig));
          const base = themeToInput(a.theme, input.id, a.theme.id === input.id ? undefined : a.theme.id);
          input = parseThemeInput({
            ...base,
            name: input.name ?? input.id,
            description: input.description ?? '',
            author: '',
            style: a.style,
            separator: a.separator,
            padding: a.padding,
            glyphs: a.glyphs,
            colors: { ...a.theme.colors, muted: a.separatorColor },
          });
          input.id = base.id;
          if (base.extends) input.extends = base.extends;
        }
        if (!input.id || !ID_RE.test(input.id)) {
          throw new HttpError(400, 'Theme id must be letters, numbers, dot, dash or underscore');
        }
        if (input.extends !== undefined && !ID_RE.test(input.extends)) {
          throw new HttpError(400, 'Invalid extends id');
        }
        saveUserTheme(input);
        send(res, 200, { ok: true, id: input.id, themes: listThemes() });
        return;
      }
      case 'POST /api/presets': {
        const body = asObject(await readBody(req));
        const meta = asObject(body.preset);
        const id = typeof meta.id === 'string' ? meta.id : '';
        if (!ID_RE.test(id))
          throw new HttpError(400, 'Preset id must be letters, numbers, dot, dash or underscore');
        saveUserPreset({
          id,
          name: typeof meta.name === 'string' ? meta.name.slice(0, 64) : id,
          description: typeof meta.description === 'string' ? meta.description.slice(0, 200) : '',
          config: body.config,
        });
        send(res, 200, { ok: true, presets: presetList() });
        return;
      }
      case 'PUT /api/config': {
        const body = asObject(await readBody(req));
        const config = normalizeConfig(body.config);
        saveConfig(config, opts.configPath);
        send(res, 200, { ok: true, config });
        return;
      }
      case 'POST /api/install': {
        const body = asObject(await readBody(req));
        const cmd = typeof body.command === 'string' && body.command.trim() ? body.command.trim() : command;
        const refresh = Number(body.refreshInterval);
        const backup = install(cmd, Number.isFinite(refresh) && refresh > 0 ? refresh : undefined);
        if (!fs.existsSync(opts.configPath))
          saveConfig(loadForUse(opts.configPath, () => gsd).config, opts.configPath);
        send(res, 200, { ok: true, backup, claude: claudeInfo(command) });
        return;
      }
      case 'POST /api/shutdown': {
        send(res, 200, { ok: true });
        setTimeout(() => void close(), 50);
        return;
      }
      default:
        throw new HttpError(404, 'Not found');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 413) res.setHeader('connection', 'close');
      send(res, status, { error: (err as Error).message });
    });
  });

  let closing: Promise<void> | null = null;
  function close(): Promise<void> {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  const url = `http://127.0.0.1:${port}/?t=${token}`;
  const onSigint = () => {
    console.log('\nStopping editor');
    void close();
  };
  process.once('SIGINT', onSigint);
  server.on('close', () => process.off('SIGINT', onSigint));

  console.log(`ccinfobar editor running at ${url}`);
  console.log('Press Ctrl+C to stop');
  if (opts.open) openBrowser(url);

  return { url, token, close };
}
