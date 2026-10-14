import { type MessageId, t } from './i18n/index.js';

export interface JsonIssue {
  offset: number;
  line: number;
  column: number;
  message: string;
}

type KeyHook = (depth: number, start: number, end: number) => void;

// 1-based; \r\n is one break; column in UTF-16 units
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 && text.charCodeAt(i + 1) === 10 && i + 1 < end) i++;
    if (c === 10 || c === 13) {
      line++;
      start = i + 1;
    }
  }
  return { line, column: end - start + 1 };
}

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const ESCAPES = '"\\/bfnrt';

function scan(text: string, onKey?: KeyHook): JsonIssue | null {
  const n = text.length;
  const stack: number[] = [];
  let i = 0;
  const fail = (offset: number, id: MessageId, params?: Record<string, string>): JsonIssue => ({
    offset,
    ...lineColumn(text, offset),
    message: t(id, params),
  });
  const ws = () => {
    while (i < n && isWs(text.charCodeAt(i))) i++;
  };
  const unexpected = () =>
    i >= n
      ? fail(i, 'json.unexpectedEnd')
      : fail(i, 'json.unexpectedChar', { char: JSON.stringify(text[i]) });
  const string = (): JsonIssue | null => {
    const open = i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        i++;
        return null;
      }
      if (c < 32) return fail(i, 'json.controlChar');
      if (c === 92) {
        const e = text[i + 1];
        if (e === 'u') {
          for (let k = 2; k < 6; k++) if (!isHex(text.charCodeAt(i + k))) return fail(i, 'json.badEscape');
          i += 6;
        } else if (e !== undefined && ESCAPES.includes(e)) i += 2;
        else return e === undefined ? fail(open, 'json.unterminatedString') : fail(i, 'json.badEscape');
      } else i++;
    }
    return fail(open, 'json.unterminatedString');
  };
  const digits = () => {
    const s = i;
    while (i < n && isDigit(text.charCodeAt(i))) i++;
    return i > s;
  };
  const number = (): JsonIssue | null => {
    const s = i;
    if (text[i] === '-') i++;
    if (text[i] === '0') i++;
    else if (!digits()) return fail(s, 'json.badNumber');
    if (text[i] === '.') {
      i++;
      if (!digits()) return fail(s, 'json.badNumber');
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (!digits()) return fail(s, 'json.badNumber');
    }
    return null;
  };

  ws();
  if (i >= n) return fail(i, 'json.empty');
  let mode: 'value' | 'after' | 'key' = 'value';
  for (;;) {
    if (mode === 'key') {
      ws();
      if (text[i] !== '"') return i >= n ? unexpected() : fail(i, 'json.expectedKey');
      const start = i;
      const bad = string();
      if (bad) return bad;
      onKey?.(stack.length, start, i);
      ws();
      if (text[i] !== ':') return i >= n ? unexpected() : fail(i, 'json.expectedColon');
      i++;
      mode = 'value';
      continue;
    }
    if (mode === 'value') {
      ws();
      const c = text[i];
      if (c === '{' || c === '[') {
        stack.push(c === '{' ? 125 : 93);
        i++;
        ws();
        if (text.charCodeAt(i) === stack[stack.length - 1]) {
          stack.pop();
          i++;
          mode = 'after';
        } else mode = c === '{' ? 'key' : 'value';
        continue;
      }
      let bad: JsonIssue | null;
      if (c === '"') bad = string();
      else if (c === '-' || (c !== undefined && isDigit(c.charCodeAt(0)))) bad = number();
      else if (c === 't' || c === 'f' || c === 'n') {
        const word = c === 't' ? 'true' : c === 'f' ? 'false' : 'null';
        if (text.startsWith(word, i)) {
          i += word.length;
          bad = null;
        } else bad = fail(i, 'json.unexpectedChar', { char: JSON.stringify(c) });
      } else bad = unexpected();
      if (bad) return bad;
      mode = 'after';
      continue;
    }
    ws();
    const close = stack[stack.length - 1];
    if (close === undefined) return i < n ? fail(i, 'json.trailingData') : null;
    const c = text.charCodeAt(i);
    if (c === close) {
      stack.pop();
      i++;
      continue;
    }
    if (c !== 44) {
      return i >= n
        ? unexpected()
        : fail(i, 'json.expectedCommaOrClose', { close: String.fromCharCode(close) });
    }
    i++;
    ws();
    if (text.charCodeAt(i) === close) return fail(i, 'json.trailingComma');
    mode = close === 125 ? 'key' : 'value';
  }
}

export function locateJsonError(text: string): JsonIssue | null {
  return scan(text);
}

export function locateKey(
  text: string,
  key: string,
): { line: number; column: number; offset: number } | null {
  let found = -1;
  scan(text, (depth, start, end) => {
    if (depth !== 1) return;
    try {
      if (JSON.parse(text.slice(start, end)) === key) found = start;
    } catch {}
  });
  return found < 0 ? null : { ...lineColumn(text, found), offset: found };
}
