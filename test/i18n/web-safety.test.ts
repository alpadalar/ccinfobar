import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const dir = path.join(root, 'src/editor/web');

// html sinks that may only take escaped preview html or fixed markup
const SINK = /\b(?:innerHTML|outerHTML)\s*(?:=(?!=)|:)|\binsertAdjacentHTML\s*\(/g;
const TRANSLATED =
  /\b(?:t|widgetText|optionLabel|optionHelp|choiceLabel|categoryText|themeDescription|styleText|presetText|scenarioText|styleGroupName|idText|apiErrorText)\s*\(/;

// same prose heuristics as literal-scan.test.ts
const SENTENCE = /^[A-Z][a-z]+[\s\S]*\s[A-Za-z]/;
const LOWER3 = /\b(?:[a-z]+|[A-Z]{2,})(?: (?:[a-z]+|[A-Z]{2,})){2,}\b/g;

// file and a fragment of the sink expression, with the plan that removes it
const ALLOW: [string, string, string][] = [
  ['app.ts', 'Cannot reach the editor', 'boot error before /api/state, rebuilt with text nodes in 08-21'],
];

type Sink = { line: number; expr: string };

// the expression after a sink, up to , ; or a closing bracket at depth 0
function sinks(src: string): Sink[] {
  const out: Sink[] = [];
  for (const m of src.matchAll(SINK)) {
    const start = m.index! + m[0].length;
    const stack: string[] = m[0].endsWith('(') ? [')'] : [];
    let i = start;
    const close: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    while (i < src.length) {
      const c = src[i]!;
      const top = stack[stack.length - 1];
      if (top === '`') {
        if (c === '\\') i++;
        else if (c === '`') stack.pop();
        else if (c === '$' && src[i + 1] === '{') {
          stack.push('}');
          i++;
        }
      } else if (c === "'" || c === '"') {
        i++;
        while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      } else if (c === '`') stack.push('`');
      else if (c in close) stack.push(close[c]!);
      else if (c === ')' || c === ']' || c === '}') {
        if (!stack.length) break;
        stack.pop();
        if (!stack.length && m[0].endsWith('(')) break;
      } else if ((c === ',' || c === ';') && !stack.length) break;
      i++;
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, expr: src.slice(start, i) });
  }
  return out;
}

// literal text of an expression with tags and entities removed
function words(expr: string): string[] {
  const parts: string[] = [];
  for (const m of expr.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|\$\{[^}]*\}|[^`\\])*)`/g)) {
    parts.push((m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' '));
  }
  return parts
    .map((p) =>
      p
        .replace(/<[^>]*>/g, ' ')
        .replace(/&\w+;/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

function problems(file: string, src: string): string[] {
  const out: string[] = [];
  for (const s of sinks(src)) {
    const allowed = ALLOW.some(([f, frag]) => f === file && s.expr.includes(frag));
    if (TRANSLATED.test(s.expr)) out.push(`${file}:${s.line} translated text in an html sink`);
    else if (!allowed && words(s.expr).some((w) => SENTENCE.test(w) || LOWER3.test(w)))
      out.push(`${file}:${s.line} prose in an html sink`);
    LOWER3.lastIndex = 0;
  }
  return out;
}

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.ts'))
  .sort();

describe('web html sinks', () => {
  it('reads sink expressions', () => {
    const src = [
      'el.innerHTML = `<div>${escapeHtml(x)}</div>`;',
      "h('div', { class: 'a', innerHTML: term(lines) }),",
      "box.innerHTML = ok ? rows.map((r) => `<p>${r}</p>`).join('') : '<p>&nbsp;</p>';",
      "x.insertAdjacentHTML('beforeend', html), y;",
      'if (a.innerHTML === b) z();',
    ].join('\n');
    expect(sinks(src).map((s) => s.expr.trim())).toEqual([
      '`<div>${escapeHtml(x)}</div>`',
      'term(lines)',
      "ok ? rows.map((r) => `<p>${r}</p>`).join('') : '<p>&nbsp;</p>'",
      "'beforeend', html",
    ]);
  });

  it('flags translated text and prose', () => {
    const bad = [
      "el.innerHTML = `<p>${t('insp.label')}</p>`;",
      "h('div', { innerHTML: themeDescription(th) });",
      "x.insertAdjacentHTML('afterbegin', presetText(p, 'name'));",
      "el.innerHTML = '<h2>Cannot open the file</h2>';",
    ];
    for (const src of bad) expect(problems('x.ts', src), src).toHaveLength(1);
    for (const src of [
      'el.innerHTML = `<div class="term-line">${ansiToHtml(l) || \'&nbsp;\'}</div>`;',
      "h('div', { innerHTML: term(lines) });",
      'span.innerHTML = `<svg viewBox="0 0 24 24">${PATHS[name] ?? \'\'}</svg>`;',
    ])
      expect(problems('x.ts', src), src).toEqual([]);
  });

  it('finds the sinks in the editor', () => {
    const all = files.flatMap((f) => sinks(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(all.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps ALLOW entries current', () => {
    for (const [file, frag, reason] of ALLOW) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(
        sinks(src).some((s) => s.expr.includes(frag)),
        `${file} ${frag}`,
      ).toBe(true);
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it.each(files)('%s puts no translated text or prose into html', (file) => {
    expect(problems(file, fs.readFileSync(path.join(dir, file), 'utf8'))).toEqual([]);
  });
});
