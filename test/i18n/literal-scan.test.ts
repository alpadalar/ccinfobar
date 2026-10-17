import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

// files whose user-facing prose goes through t(); sweep plans append theirs
const SWEPT: string[] = [
  'src/cli/help.ts',
  'src/cli/main.ts',
  'src/cli/render.ts',
  'src/cli/lang.ts',
  'src/importers/index.ts',
  'src/importers/ccstatusline.ts',
  'src/importers/claude-powerline.ts',
  'src/importers/ccometixline.ts',
  'src/importers/ccometixline-themes.ts',
  'src/importers/cship.ts',
  'src/importers/claude-hud.ts',
  'src/importers/toml.ts',
  'src/importers/colors.ts',
  'src/importers/confirm.ts',
  'src/importers/io.ts',
  'src/importers/args.ts',
  'src/importers/themes-map.ts',
  'src/importers/registry.ts',
  'src/importers/ccline-load.ts',
  'src/importers/ccline-family.ts',
  'src/importers/claudebar.ts',
  'src/importers/statusline-pro.ts',
  'src/importers/claude-code-statusline.ts',
  'src/importers/starship-claude.ts',
  'src/importers/shell-env.ts',
  'src/importers/pyccsl.ts',
  'src/importers/coralline.ts',
  'src/importers/claude-statusbar.ts',
  'src/importers/nycu-cc-statusline.ts',
  'src/commands/doctor.ts',
  'src/commands/manage.ts',
  'src/commands/import-help.ts',
  'src/commands/bench.ts',
  'src/commands/usage-error.ts',
  'src/commands/install-cli.ts',
  'src/commands/install.ts',
  'src/commands/settings-file.ts',
  'src/commands/hooks-install.ts',
  'src/commands/update.ts',
  'src/commands/catalog-admin.ts',
  'src/commands/catalog-market.ts',
  'src/commands/catalog.ts',
  'src/commands/open.ts',
  'src/core/http-spec.ts',
  'src/core/jsonpath.ts',
  'src/core/config-path.ts',
  'src/core/themes.ts',
  'src/core/http-report.ts',
  'src/core/preview.ts',
  'src/core/edit.ts',
  'src/core/entry-keys.ts',
  'src/catalog/model.ts',
  'src/catalog/snapshot.ts',
  'src/catalog/store.ts',
  'src/catalog/system.ts',
  'src/catalog/share.ts',
  'src/market/endpoint.ts',
  'src/core/brew.ts',
  'src/editor/server.ts',
  'src/editor/detach.ts',
  'src/editor/web/api.ts',
  'src/editor/web/inspector.ts',
  'src/editor/web/panel-inspector.ts',
  'src/editor/web/settings.ts',
  'src/editor/web/app.ts',
  'src/editor/web/install-dialog.ts',
  'src/editor/web/terminal-picker.ts',
  'src/editor/web/ui.ts',
  'src/editor/web/colors.ts',
  'src/editor/web/store.ts',
  'src/editor/web/dnd.ts',
  'src/editor/web/theme-builder.ts',
  'src/editor/web/themes.ts',
  'src/editor/web/presets.ts',
  'src/editor/web/catalog.ts',
  'src/editor/web/catalog-dialogs.ts',
  'src/editor/web/catalog-market.ts',
  'src/editor/web/catalog-signin.ts',
  'src/editor/web/styles.ts',
  'src/editor/web/terminals.ts',
  'src/editor/web/i18n-static.ts',
  'src/editor/web/update-info.ts',
  'src/tui/fields.ts',
  'src/tui/state.ts',
  'src/tui/index.ts',
  'src/tui/view.ts',
  'src/widgets/activity.ts',
  'src/widgets/agents.ts',
  'src/widgets/charts.ts',
  'src/widgets/context.ts',
  'src/widgets/cost.ts',
  'src/widgets/custom.ts',
  'src/widgets/fun.ts',
  'src/widgets/git.ts',
  'src/widgets/gsd.ts',
  'src/widgets/http.ts',
  'src/widgets/index.ts',
  'src/widgets/layout.ts',
  'src/widgets/limits.ts',
  'src/widgets/live.ts',
  'src/widgets/projection.ts',
  'src/widgets/session.ts',
  'src/widgets/shared.ts',
  'src/widgets/status.ts',
  'src/widgets/system.ts',
  'src/widgets/tokens.ts',
  'src/widgets/workspace.ts',
  'src/bin.ts',
  'src/cli.ts',
  'src/commands/command.ts',
  'src/commands/config-cmd.ts',
  'src/commands/explain.ts',
  'src/commands/hooks-doctor.ts',
  'src/commands/io.ts',
  'src/commands/manifest.ts',
  'src/commands/repos.ts',
  'src/commands/report.ts',
  'src/commands/worker.ts',
  'src/core/ansi.ts',
  'src/core/builtins.ts',
  'src/core/cache-rule.ts',
  'src/core/conditions.ts',
  'src/core/config.ts',
  'src/core/context.ts',
  'src/core/display-opts.ts',
  'src/core/glyphs.ts',
  'src/core/inspect.ts',
  'src/core/job-values.ts',
  'src/core/json-locate.ts',
  'src/core/load.ts',
  'src/core/metrics.ts',
  'src/core/panel.ts',
  'src/core/paths.ts',
  'src/core/payload.ts',
  'src/core/presets.ts',
  'src/core/prices.ts',
  'src/core/report-model.ts',
  'src/core/report-format.ts',
  'src/core/report-types.ts',
  'src/core/renderer.ts',
  'src/core/sanitize.ts',
  'src/core/themes/builtin.ts',
  'src/core/themes/style.ts',
  'src/core/time.ts',
  'src/core/trace.ts',
  'src/core/types.ts',
  'src/core/version.ts',
  'src/core/width.ts',
  'src/data/agents.ts',
  'src/data/cache.ts',
  'src/data/environment.ts',
  'src/data/git.ts',
  'src/data/gsd.ts',
  'src/data/history.ts',
  'src/data/hook-line.ts',
  'src/data/hooks.ts',
  'src/data/jobs/fetch.ts',
  'src/data/jobs/gh-exec.ts',
  'src/data/jobs/gh.ts',
  'src/data/jobs/http.ts',
  'src/data/jobs/index.ts',
  'src/data/jobs/keys.ts',
  'src/data/jobs/repos.ts',
  'src/data/jobs/runner.ts',
  'src/data/jobs/status.ts',
  'src/data/jobs/update.ts',
  'src/data/jobs/usage.ts',
  'src/data/ledger.ts',
  'src/data/limits.ts',
  'src/data/live.ts',
  'src/data/progress-clear.ts',
  'src/data/progress.ts',
  'src/data/provider.ts',
  'src/data/repos-dirty.ts',
  'src/data/repos.ts',
  'src/data/report-index.ts',
  'src/data/self-update.ts',
  'src/data/store.ts',
  'src/data/terminal.ts',
  'src/data/transcript.ts',
  'src/data/update-state.ts',
  'src/data/usage.ts',
  'src/editor/terminal-colors.ts',
  'src/editor/web/ansi-html.ts',
  'src/editor/web/dom.ts',
  'src/editor/web/search.ts',
  'src/tui/catalog.ts',
  'src/tui/hits.ts',
  'src/tui/keys.ts',
  'src/tui/themeio.ts',
];

// left out on purpose, with the reason; SWEPT + NOT_SWEPT cover src/ outside src/core/i18n/
const NOT_SWEPT: Record<string, string> = {
  'src/cli/hook.ts': 'hook closure, must not import i18n (D-04)',
  'src/cli/hook-stream.ts': 'hook closure, reads stdin only',
  'src/cli/progress.ts': 'terminal sequences and debug reasons, no user-facing prose',
  'src/cli/progress-tty.ts': 'tty lookup, no user-facing prose',
  'src/cli/silence.ts': 'stream plumbing, no user-facing prose',
  'src/cli/args.ts': 'argv parsing, no user-facing prose',
  'src/core/sample.ts': 'simulated payload data for previews (D-36)',
  'src/core/profiles.ts': 'vendor and model names, price notes translated in the editor by vendor id (08-19)',
  'src/core/scenarios.ts': 'simulated payload data; labels and descriptions go through catalog-text (08-12)',
  'src/core/eaw-table.ts': 'generated Unicode width table',
  'src/catalog/publish.ts': 'publish orchestration, codes only',
  'src/market/client.ts': 'marketplace client, codes only, no user-facing prose',
  'src/market/protocol.ts': 'marketplace protocol, English JSON on the wire',
  'src/market/server.ts': 'reference marketplace server, English protocol JSON (D-15)',
  'src/market/rules.ts': 'marketplace server rules, fixed English protocol messages (D-03)',
  'src/market/serve.ts': 'self-hosting entry for the reference server (D-24)',
  'src/market/github.ts': 'GitHub device-flow client, codes only (D-06)',
  'src/catalog/signin.ts': 'sign-in orchestration, codes only',
  'src/catalog/install.ts': 'install orchestration, codes only',
  'src/catalog/login-flows.ts': 'editor sign-in flow state, codes only',
  'src/catalog/market-cache.ts': 'marketplace cache, codes only',
};

// whole folders left out, with the reason
const NOT_SWEPT_DIRS: Record<string, string> = {
  'src/market/worker/': 'marketplace Worker, English protocol JSON and landing page (D-03)',
};

const notSwept = (f: string): boolean =>
  f in NOT_SWEPT || Object.keys(NOT_SWEPT_DIRS).some((d) => f.startsWith(d));

// exact literal texts allowed per file
const ALLOW: Record<string, string[]> = {
  'src/cli/help.ts': [
    // usage column stays literal (D-13)
    'ccinfobar theme new <id>',
    'ccinfobar config get <path>',
    'ccinfobar config set <path> <value>',
    'ccinfobar config unset <path>',
    'ccinfobar catalog list|show|history',
    'ccinfobar catalog install <publisher>/<slug>',
    'ccinfobar catalog apply|save <name>',
    'ccinfobar catalog publish',
    'ccinfobar catalog login|logout',
  ],
  // simulated payload data
  'src/commands/bench.ts': ['Step X: refactor the status line renderer', 'Done with step X.'],
  // persisted usage errors, matched and never shown as is
  'src/commands/usage-error.ts': ['rate limited by the usage API', 'usage API sent no limits'],
  // generated WidgetDef names and descriptions (metadata, D-36)
  'src/widgets/limits.ts': [
    'Weekly X usage',
    'Usage of the weekly X limit',
    'Five-hour usage',
    'Usage of the 5-hour rate limit',
    'Five-hour reset',
    'Weekly usage',
    'Usage of the weekly rate limit',
    'Weekly reset',
  ],
  // shell command passed to messages as {command} (10-01)
  'src/core/brew.ts': ['brew upgrade ccinfobar'],
  // compact duration units stay ASCII (D-17)
  'src/widgets/shared.ts': ['Xd Xh', 'Xh Xm'],
  // English catalog data, shown through styleGroupName (08-12)
  'src/core/edit.ts': ['Bold, dim, italic', 'Bar and graph options', 'Label switches'],
  'src/editor/web/inspector.ts': [
    // CSS classes
    'hint warn field-error',
    // rule syntax placeholder (D-13)
    'provider in bedrock,vertex',
    // product name as a choice label
    'Nerd Font',
  ],
  'src/editor/web/panel-inspector.ts': [
    // CSS classes
    'input mono areas',
    // grid areas example, widget types (D-13)
    'model cwd cwd\\n---\\ngit git .',
  ],
  // product name as the section title
  'src/editor/web/settings.ts': ['Claude Code'],
  // key names stay as typed (D-30)
  'src/tui/view.ts': ['← → ↑ ↓  h j k l'],
  'src/editor/web/app.ts': [
    // CSS classes
    'icon-btn danger sm',
    'input mono import-area',
  ],
  // CSS classes
  'src/editor/web/theme-builder.ts': ['input mono mini-color-text', 'icon-btn sm danger', 'btn ghost sm'],
  'src/editor/web/themes.ts': ['input mono import-area', 'icon-btn sm danger'],
  'src/editor/web/presets.ts': ['icon-btn sm danger'],
  // color scheme product names; display words go through terminalName
  'src/editor/web/terminals.ts': [
    'Windows Terminal',
    'Solarized Dark',
    'Solarized Light',
    'Tokyo Night',
    'Gruvbox Dark',
    'Catppuccin Mocha',
    'One Dark',
  ],
  // macOS managed settings dir
  'src/core/paths.ts': ['/Library/Application Support/ClaudeCode'],
  // STATE.md body keys the reader parses
  'src/data/gsd.ts': ['Last activity', 'Stopped at'],
  'src/data/usage.ts': [
    // keychain service name and auth header
    'Claude Code-credentials',
    'Bearer X',
    // persisted usage errors, translated at display by usageErrorText (08-09)
    'rate limited by the usage API',
    'usage API returned X',
    'usage API sent no limits',
  ],
  'src/editor/server.ts': [
    // developer-only (D-36)
    'Forbidden host',
    'Not found',
    'Forbidden origin',
    // developer-only page when the bundle is not built
    '<!doctype html><meta charset="utf-8"><title>ccinfobar editor</title>\n<body style="font:16px system-ui;background:#111;color:#eee;padding:3rem">\n<h1>Editor bundle not built</h1><p>Run <code>npm run build</code> and start the editor again.</p></body>',
    // placeholder command, matched by prefix and sent in the API JSON
    'Xinstalled on first Install)',
  ],
};

type Lit = { text: string; at: number; end: number };

const REGEX_PREV = /[(,=:[!&|?{};+\-*%<>~^]$/;
const REGEX_WORD = /\b(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

// string and template literals with comments and regex literals skipped; ${…} becomes X
function scan(src: string): Lit[] {
  const out: Lit[] = [];
  let i = 0;
  const quoted = (q: string) => {
    const start = i;
    let j = i + 1;
    while (j < src.length && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    i = j + 1;
    out.push({ text: src.slice(start + 1, j), at: start, end: i });
  };
  const regex = () => {
    i++;
    let cls = false;
    while (i < src.length && src[i] !== '\n') {
      const c = src[i]!;
      if (c === '\\') i += 2;
      else if (cls) {
        if (c === ']') cls = false;
        i++;
      } else if (c === '[') {
        cls = true;
        i++;
      } else if (c === '/') {
        i++;
        break;
      } else i++;
    }
    while (i < src.length && /[a-z]/i.test(src[i]!)) i++;
  };
  const template = () => {
    const start = i++;
    let text = '';
    while (i < src.length) {
      const c = src[i]!;
      if (c === '\\') {
        text += src.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        i++;
        break;
      } else if (c === '$' && src[i + 1] === '{') {
        text += 'X';
        i += 2;
        code(true);
      } else {
        text += c;
        i++;
      }
    }
    out.push({ text, at: start, end: i });
  };
  const code = (inner: boolean) => {
    let depth = 0;
    let last = '';
    while (i < src.length) {
      const c = src[i]!;
      const d = src[i + 1];
      if (c === '/' && d === '/') {
        const e = src.indexOf('\n', i);
        i = e < 0 ? src.length : e;
      } else if (c === '/' && d === '*') {
        const e = src.indexOf('*/', i + 2);
        i = e < 0 ? src.length : e + 2;
      } else if (c === "'" || c === '"') {
        quoted(c);
        last = 'a';
      } else if (c === '`') {
        template();
        last = 'a';
      } else if (
        c === '/' &&
        (last.trim() === '' || REGEX_PREV.test(last.trimEnd()) || REGEX_WORD.test(last))
      ) {
        regex();
        last = 'a';
      } else {
        if (inner && c === '{') depth++;
        if (inner && c === '}' && depth-- === 0) {
          i++;
          return;
        }
        last = (last + c).slice(-12);
        i++;
      }
    }
  };
  code(false);
  return out;
}

// text that is an id, a module path or already a t() argument
function skipped(src: string, lit: Lit): boolean {
  const before = src.slice(Math.max(0, lit.at - 40), lit.at);
  if (/(?:\bfrom\s*|\bimport\(\s*|\bt\(\s*|:\s*MessageId\s*=\s*)$/.test(before)) return true;
  return /^\s*as\s+MessageId\b/.test(src.slice(lit.end, lit.end + 30));
}

// SENTENCE: a capitalized word, then a space and a letter ('No widgets match', 'Saved theme X')
// LOWER3: three words in a row, lowercase or acronyms, at least one lowercase ('a custom status line',
// 'invalid JSON on stdin'); 'btn primary', 'GSD API MCP' and ids pass
const SENTENCE = /^[A-Z][a-z]+[\s\S]*\s[A-Za-z]/;
const LOWER3 = /\b(?:[a-z]+|[A-Z]{2,})(?: (?:[a-z]+|[A-Z]{2,})){2,}\b/g;

function prose(raw: string): boolean {
  const s = raw.replace(/\\x1b\[[\d;]*m|\\u001b\[[\d;]*m|\\[nrt]/g, ' ').replace(/^[^A-Za-z]+/, '');
  return SENTENCE.test(s) || [...s.matchAll(LOWER3)].some((m) => /[a-z]/.test(m[0]));
}

// WidgetDef metadata stays English and is translated through widget-text (D-14)
const META_KEY = /\b(?:name|description|label|help|sample)\s*:\s*$/;
// theme, style and preset names and descriptions go through catalog-text (08-12)
const CATALOG_KEY = /\b(?:name|description)\s*:\s*$/;
const CATALOG = [
  'src/core/themes/builtin.ts',
  'src/core/themes/style.ts',
  'src/core/presets.ts',
  'src/catalog/system.ts',
];
function metadata(file: string, src: string, lit: Lit): boolean {
  const before = src.slice(Math.max(0, lit.at - 40), lit.at);
  if (CATALOG.includes(file)) return CATALOG_KEY.test(before);
  return file.startsWith('src/widgets/') && META_KEY.test(before);
}

function hits(file: string, src: string): string[] {
  const allow = ALLOW[file] ?? [];
  return scan(src)
    .filter((l) => !skipped(src, l) && !metadata(file, src, l) && prose(l.text) && !allow.includes(l.text))
    .map((l) => `${file}:${src.slice(0, l.at).split('\n').length} ${JSON.stringify(l.text)}`);
}

const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

describe('literal scan', () => {
  it('flags prose and passes ids, classes and keys', () => {
    for (const s of [
      'No widgets match',
      'Saved theme X',
      'a custom status line',
      'GSD status line',
      'ccinfobar: invalid JSON on stdin',
      '✓ Wrote X to X',
      '\\n  Run it',
    ])
      expect(prose(s), s).toBe(true);
    for (const s of [
      'btn primary',
      'context-percentage',
      'help.cmd.render',
      'utf8',
      'Opus 5.5',
      'X X',
      '--json',
      'GSD API MCP',
    ])
      expect(prose(s), s).toBe(false);
  });

  it('reads literals the way the source has them', () => {
    const src = [
      "import { t } from '../core/i18n/index.js';",
      "// 'No comment here'",
      "/* 'Not this either' */",
      "const a = 'No widgets match';",
      'const b = `Saved theme ${fmt(`Inner text here`)}`;',
      "const c = t('Not flagged here');",
      "const d = /--config[=\\s]+(\"[^\"]*\"|'[^']*')/.exec(x) ? 'btn primary' : 'Left alone ok';",
      'const e = n / 2 / 3;',
      "const f = 'help.x' as MessageId;",
    ].join('\n');
    expect(hits('x.ts', src)).toEqual([
      'x.ts:4 "No widgets match"',
      'x.ts:5 "Inner text here"',
      'x.ts:5 "Saved theme X"',
      'x.ts:7 "Left alone ok"',
    ]);
  });

  it('skips WidgetDef metadata in widget files only', () => {
    const src = [
      "const w = { name: 'Some widget name', description:",
      "  'Shows the widget text', sample: 'Two words here' };",
      "const v = { text: 'Some value word' };",
    ].join('\n');
    expect(hits('src/widgets/x.ts', src)).toEqual(['src/widgets/x.ts:3 "Some value word"']);
    expect(hits('src/core/x.ts', src)).toHaveLength(4);
    expect(hits('src/core/presets.ts', src)).toEqual([
      'src/core/presets.ts:2 "Two words here"',
      'src/core/presets.ts:3 "Some value word"',
    ]);
  });

  it('lists files that exist, once', () => {
    const all = [...SWEPT, ...Object.keys(NOT_SWEPT)];
    expect(new Set(all).size).toBe(all.length);
    for (const f of all) expect(fs.existsSync(path.join(root, f)), f).toBe(true);
    for (const reason of Object.values(NOT_SWEPT)) expect(reason.length).toBeGreaterThan(0);
    for (const [d, reason] of Object.entries(NOT_SWEPT_DIRS)) {
      expect(d.endsWith('/'), d).toBe(true);
      expect(fs.statSync(path.join(root, d)).isDirectory(), d).toBe(true);
      expect(reason.length).toBeGreaterThan(0);
      for (const f of [...SWEPT, ...Object.keys(NOT_SWEPT)]) expect(f.startsWith(d), f).toBe(false);
    }
  });

  it('covers every file in src/ outside src/core/i18n/', () => {
    const files = fs
      .readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .map((f) => `src/${f.replace(/\\/g, '/')}`)
      .filter((f) => f.endsWith('.ts') && !f.startsWith('src/core/i18n/'));
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) expect(SWEPT.includes(f) || notSwept(f), f).toBe(true);
    for (const f of [...SWEPT, ...Object.keys(NOT_SWEPT)])
      expect(f.startsWith('src/core/i18n/'), f).toBe(false);
  });

  it('keeps ALLOW entries current', () => {
    for (const [file, texts] of Object.entries(ALLOW)) {
      const lits = scan(read(file)).map((l) => l.text);
      for (const text of texts) expect(lits, `${file} ${text}`).toContain(text);
    }
  });

  it.each(SWEPT)('%s has no hard-coded prose', (file) => {
    expect(hits(file, read(file))).toEqual([]);
  });
});
