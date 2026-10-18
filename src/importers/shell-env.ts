// reads plain shell assignments; never executes, expands or follows anything

export interface ShellEnv {
  vars: Record<string, string>;
  includes: { line: number; name: string; path: string }[];
  skipped: number[];
}

interface Word {
  text: string;
  // index of the first unquoted '=' with nothing quoted before it, else -1
  eq: number;
}

const MAX_LINE = 10_000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE = new Set([';', '&', '|', '<', '>', '(', ')', '`']);

const C_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

// $'…' body starting after the quote; returns [text, index after the closing quote]
function ansiC(s: string, start: number): [string, number] | null {
  let out = '';
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'") return [out, i + 1];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) return null;
    if (Object.hasOwn(C_ESCAPES, n)) {
      out += C_ESCAPES[n]!;
      i++;
    } else if (n === 'x' && /^[0-9a-fA-F]/.test(s[i + 2] ?? '')) {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2, i + 4))![0];
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 1 + hex.length;
    } else if (/[0-7]/.test(n)) {
      const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))![0];
      out += String.fromCharCode(Number.parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else {
      out += `\\${n}`;
      i++;
    }
  }
  return null;
}

// one line into words; null when it is not a plain list of words
function words(line: string): Word[] | null {
  const out: Word[] = [];
  let cur: Word | null = null;
  let quoted = false;
  const start = () => {
    cur ??= { text: '', eq: -1 };
    return cur;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === ' ' || c === '\t') {
      if (cur) out.push(cur);
      cur = null;
      quoted = false;
      continue;
    }
    if (c === '#' && !cur) break;
    if (UNSAFE.has(c)) return null;
    const w = start();
    if (c === '\\') {
      const n = line[i + 1];
      if (n === undefined) return null;
      w.text += n;
      quoted = true;
      i++;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      w.text += line.slice(i + 1, end);
      quoted = true;
      i = end;
    } else if (c === '$' && line[i + 1] === "'") {
      const r = ansiC(line, i + 2);
      if (!r) return null;
      w.text += r[0];
      quoted = true;
      i = r[1] - 1;
    } else if (c === '$' && line[i + 1] === '(') {
      return null;
    } else if (c === '"' || (c === '$' && line[i + 1] === '"')) {
      let j = c === '"' ? i + 1 : i + 2;
      for (; j < line.length; j++) {
        const d = line[j]!;
        if (d === '"') break;
        if (d === '`' || (d === '$' && line[j + 1] === '(')) return null;
        if (d === '\\' && '\\"$`'.includes(line[j + 1] ?? '')) {
          w.text += line[j + 1];
          j++;
        } else {
          w.text += d;
        }
      }
      if (j >= line.length) return null;
      quoted = true;
      i = j;
    } else {
      if (c === '=' && w.eq < 0 && !quoted) w.eq = w.text.length;
      w.text += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const assignment = (w: Word): [string, string] | null => {
  if (w.eq < 0) return null;
  const name = w.text.slice(0, w.eq);
  return NAME.test(name) ? [name, w.text.slice(w.eq + 1)] : null;
};

const includeName = (target: string): string => {
  const base = target.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(?:conf|env|sh)$/i, '');
};

export function parseShellEnv(text: string): ShellEnv {
  const vars = Object.create(null) as Record<string, string>;
  const includes: ShellEnv['includes'] = [];
  const skipped: number[] = [];
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const n = i + 1;
    const head = line.trimStart();
    if (!head || head.startsWith('#')) continue;
    if (line.length > MAX_LINE) {
      skipped.push(n);
      continue;
    }
    const ws = words(line);
    if (!ws || ws.length === 0) {
      if (ws === null) skipped.push(n);
      continue;
    }
    const first = ws[0]!;
    if ((first.text === '.' || first.text === 'source') && first.eq < 0 && ws.length === 2) {
      const name = includeName(ws[1]!.text);
      if (name) {
        includes.push({ line: n, name, path: ws[1]!.text });
        continue;
      }
    }
    const rest = first.text === 'export' && first.eq < 0 ? ws.slice(1) : ws;
    const pairs = rest.map(assignment);
    if (pairs.length === 0 || pairs.some((p) => p === null)) {
      skipped.push(n);
      continue;
    }
    for (const p of pairs) vars[p![0]] = p![1];
  }
  return { vars, includes, skipped };
}
