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
];

// left out on purpose, with the reason; 08-25 makes SWEPT + NOT_SWEPT cover src/
const NOT_SWEPT: Record<string, string> = {
  'src/cli/hook.ts': 'hook closure, must not import i18n (D-04)',
  'src/cli/hook-stream.ts': 'hook closure, reads stdin only',
  'src/cli/progress.ts': 'terminal sequences and debug reasons, no user-facing prose',
  'src/cli/progress-tty.ts': 'tty lookup, no user-facing prose',
  'src/cli/silence.ts': 'stream plumbing, no user-facing prose',
  'src/cli/args.ts': 'argv parsing, no user-facing prose',
};

// exact literal texts allowed per file
const ALLOW: Record<string, string[]> = {
  'src/cli/help.ts': [
    // usage column stays literal (D-13)
    'ccinfobar theme new <id>',
    'ccinfobar config get <path>',
    'ccinfobar config set <path> <value>',
    'ccinfobar config unset <path>',
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

function hits(file: string, src: string): string[] {
  const allow = ALLOW[file] ?? [];
  return scan(src)
    .filter((l) => !skipped(src, l) && prose(l.text) && !allow.includes(l.text))
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

  it('lists files that exist, once', () => {
    const all = [...SWEPT, ...Object.keys(NOT_SWEPT)];
    expect(new Set(all).size).toBe(all.length);
    for (const f of all) expect(fs.existsSync(path.join(root, f)), f).toBe(true);
    for (const reason of Object.values(NOT_SWEPT)) expect(reason.length).toBeGreaterThan(0);
  });

  it('covers every file in src/cli and src/importers', () => {
    for (const dir of ['src/cli', 'src/importers']) {
      for (const name of fs.readdirSync(path.join(root, dir))) {
        const f = `${dir}/${name}`;
        expect(SWEPT.includes(f) || f in NOT_SWEPT, f).toBe(true);
      }
    }
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
