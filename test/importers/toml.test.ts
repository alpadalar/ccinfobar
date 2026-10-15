import { describe, expect, it } from 'vitest';
import { MAX_TOML_CHARS, MAX_TOML_DEPTH, parseToml, TomlError } from '../../src/importers/toml.js';
import { withLang } from '../helpers.js';

function fail(text: string): TomlError {
  try {
    parseToml(text);
  } catch (e) {
    if (e instanceof TomlError) return e;
    throw e;
  }
  throw new Error(`parsed: ${JSON.stringify(text)}`);
}

const VALID: [string, string, unknown][] = [
  ['empty document', '', {}],
  ['comments and blank lines', '# only a comment\n\n   # another\n\t\n', {}],
  ['comment after a value', 'a = "x" # c', { a: 'x' }],
  ['bare key', 'A-b_1 = 1', { 'A-b_1': 1 }],
  ['digit-only bare key', '1234 = "d"', { '1234': 'd' }],
  ['quoted key', '"a b" = 1', { 'a b': 1 }],
  ['literal key', "'l.k' = 1", { 'l.k': 1 }],
  ['escaped quoted key', '"\\u0041" = 1', { A: 1 }],
  ['empty quoted key', '"" = 1', { '': 1 }],
  ['dotted key', 'a.b.c = 1', { a: { b: { c: 1 } } }],
  ['dotted key with spaces', 'a . b = 2', { a: { b: 2 } }],
  ['dotted key with tabs', 'a\t.\tb\t=\t2', { a: { b: 2 } }],
  ['dotted float-looking key', '3.14159 = "pi"', { '3': { '14159': 'pi' } }],
  ['dotted quoted segment', 'site."google.com" = true', { site: { 'google.com': true } }],
  ['dotted keys share a table', 'a.b = 1\na.c = 2\nd = 3', { a: { b: 1, c: 2 }, d: 3 }],
  ['basic escapes', 's = "\\b\\t\\n\\f\\r\\"\\\\"', { s: '\b\t\n\f\r"\\' }],
  ['short unicode escape', 's = "\\u00e9"', { s: 'é' }],
  ['long unicode escape', 's = "\\U0001F600"', { s: '😀' }],
  ['tab in a basic string', 's = "a\tb"', { s: 'a\tb' }],
  ['literal string', "p = 'C:\\path'", { p: 'C:\\path' }],
  ['literal string with quotes', `p = '<\\i\\c*\\s*>"'`, { p: '<\\i\\c*\\s*>"' }],
  ['empty strings', `a = ""\nb = ''`, { a: '', b: '' }],
  ['multi-line basic trims the first newline', 's = """\nRoses\nViolets"""', { s: 'Roses\nViolets' }],
  [
    'line-ending backslash',
    's = """\\\n       The quick brown \\\n\n\n       fox jumps over \\\n       the lazy dog.\\\n       """',
    { s: 'The quick brown fox jumps over the lazy dog.' },
  ],
  ['line-ending backslash before spaces', 's = """a \\   \n   b"""', { s: 'a b' }],
  ['multi-line basic with escapes', 's = """\\ttab\\u00e9"""', { s: '\ttabé' }],
  [
    'two quotes inside',
    's = """Here are two quotation marks: "". Simple enough."""',
    { s: 'Here are two quotation marks: "". Simple enough.' },
  ],
  ['escaped third quote', 's = """three: ""\\"."""', { s: 'three: """.' }],
  [
    'quote after the opening and before the closing',
    's = """"This," she said, "is just a pointless statement.""""',
    { s: '"This," she said, "is just a pointless statement."' },
  ],
  ['two quotes before the closing', 's = """a"""""', { s: 'a""' }],
  ['empty multi-line basic', 's = """"""', { s: '' }],
  [
    'multi-line literal',
    "s = '''\nThe first newline is\ntrimmed in raw strings.\n   All other whitespace\n   is preserved.\n'''",
    { s: 'The first newline is\ntrimmed in raw strings.\n   All other whitespace\n   is preserved.\n' },
  ],
  [
    'multi-line literal keeps backslashes',
    "s = '''I [dw]on't need \\d{2} apples'''",
    { s: "I [dw]on't need \\d{2} apples" },
  ],
  [
    'apostrophes around a multi-line literal',
    "s = ''''That,' she said, 'is still pointless.''''",
    { s: "'That,' she said, 'is still pointless.'" },
  ],
  [
    'integers',
    'a = +99\nb = -17\nc = 0\nd = -0\ne = 1_000\nf = 0xDEAD_beef\ng = 0o755\nh = 0b1101\ni = +0\nj = 5_349_221',
    { a: 99, b: -17, c: 0, d: 0, e: 1000, f: 0xdeadbeef, g: 0o755, h: 13, i: 0, j: 5349221 },
  ],
  ['hex keeps leading zeros', 'a = 0x00ff\nb = 0o0\nc = 0b0001', { a: 255, b: 0, c: 1 }],
  [
    'largest safe integer',
    'a = 9007199254740991\nb = -9007199254740991',
    { a: 9007199254740991, b: -9007199254740991 },
  ],
  [
    'floats',
    'a = 3.14\nb = -0.01\nc = 5e+22\nd = 1e06\ne = -2E-2\nf = 6.626e-34\ng = 224_617.445_991\nh = +1.0\ni = 0.0\nj = 1e1_0',
    { a: 3.14, b: -0.01, c: 5e22, d: 1e6, e: -2e-2, f: 6.626e-34, g: 224617.445991, h: 1, i: 0, j: 1e10 },
  ],
  ['negative zero float', 'a = -0.0', { a: -0 }],
  ['infinities', 'a = inf\nb = +inf\nc = -inf', { a: Infinity, b: Infinity, c: -Infinity }],
  ['not a number', 'a = nan\nb = +nan\nc = -nan', { a: NaN, b: NaN, c: NaN }],
  ['booleans', 'a = true\nb = false', { a: true, b: false }],
  [
    'date-times kept as text',
    'a = 1979-05-27T07:32:00Z\nb = 1979-05-27 07:32:00-07:00\nc = 1979-05-27T00:32:00.999999\nd = 1979-05-27\ne = 07:32:00\nf = 00:32:00.999999\ng = 1979-05-27T00:32:00.999999-07:00\nh = 2024-02-29\ni = 1979-05-27t07:32:00z\nj = 1990-12-31T23:59:60Z',
    {
      a: '1979-05-27T07:32:00Z',
      b: '1979-05-27 07:32:00-07:00',
      c: '1979-05-27T00:32:00.999999',
      d: '1979-05-27',
      e: '07:32:00',
      f: '00:32:00.999999',
      g: '1979-05-27T00:32:00.999999-07:00',
      h: '2024-02-29',
      i: '1979-05-27t07:32:00z',
      j: '1990-12-31T23:59:60Z',
    },
  ],
  ['date followed by a comment', 'd = 1979-05-27 # day', { d: '1979-05-27' }],
  ['array', 'a = [1, 2, 3]', { a: [1, 2, 3] }],
  ['nested arrays', 'a = [[1, 2], ["a"]]', { a: [[1, 2], ['a']] }],
  ['mixed array', 'a = [1, "a", true, 1.5, 1979-05-27]', { a: [1, 'a', true, 1.5, '1979-05-27'] }],
  [
    'multi-line array with comments and a trailing comma',
    'a = [\n  1, # one\n  2,\n  # comment\n\n]',
    { a: [1, 2] },
  ],
  ['empty arrays', 'a = []\nb = [ ]\nc = [\n]', { a: [], b: [], c: [] }],
  ['array without spaces', 'a=[1,2]', { a: [1, 2] }],
  ['inline table', 'a = { a = 1, b.c = "x" }', { a: { a: 1, b: { c: 'x' } } }],
  ['inline table dotted keys share a table', 'a = { b.c = 1, b.d = 2 }', { a: { b: { c: 1, d: 2 } } }],
  ['empty inline table', 'a = {}\nb = { }', { a: {}, b: {} }],
  ['nested inline tables', 'a = { b = { c = [1] } }', { a: { b: { c: [1] } } }],
  ['inline tables in an array', 'a = [{ x = 1 }, { x = 2 }]', { a: [{ x: 1 }, { x: 2 }] }],
  [
    'multi-line value inside an inline table',
    'a = { b = [\n1,\n2], c = """\nx""" }',
    { a: { b: [1, 2], c: 'x' } },
  ],
  ['leading BOM', '\uFEFFa = 1', { a: 1 }],
  [
    'CRLF line endings',
    'a = 1\r\nb = """\r\nx\r\ny"""\r\nc = [\r\n  1,\r\n]\r\n# c\r\n',
    { a: 1, b: 'x\ny', c: [1] },
  ],
  ['literal astral glyph', 'icon = "\u{f024b}"', { icon: '\u{f024b}' }],
  ['astral glyph in a key', '"\u{f024b}" = 1', { '\u{f024b}': 1 }],
];

describe('parseToml values', () => {
  it.each(VALID)('%s', (_name, text, expected) => {
    expect(parseToml(text)).toEqual(expected);
  });

  it('builds null-prototype tables', () => {
    const doc = parseToml('a.b = 1\nc = { d = 1 }\ne = [{ f = 1 }]') as any;
    expect(Object.getPrototypeOf(doc)).toBeNull();
    expect(Object.getPrototypeOf(doc.a)).toBeNull();
    expect(Object.getPrototypeOf(doc.c)).toBeNull();
    expect(Object.getPrototypeOf(doc.e[0])).toBeNull();
    expect('toString' in doc).toBe(false);
  });

  it('allows nesting up to the depth cap', () => {
    const n = MAX_TOML_DEPTH;
    const doc = parseToml(`a = ${'['.repeat(n)}${']'.repeat(n)}`) as any;
    let v = doc.a;
    for (let i = 1; i < n; i++) v = v[0];
    expect(v).toEqual([]);
  });
});

const INVALID: [string, string, string, number, number][] = [
  ['unterminated basic string', 'a = "x', 'unterminated', 1, 5],
  ['newline in a basic string', 'a = "x\nb = 1', 'unterminated', 1, 5],
  ['newline in a quoted key', '"a\nb" = 1', 'unterminated', 1, 1],
  ['unterminated multi-line basic', 'a = """x\n\n', 'unterminated', 1, 5],
  ['unterminated literal string', "a = 'x", 'unterminated', 1, 5],
  ['unterminated multi-line literal', "a = '''x\n", 'unterminated', 1, 5],
  ['unterminated on a later line', 'a = 1\n  b = "x', 'unterminated', 2, 7],
  ['bad escape', 'a = "\\q"', 'badEscape', 1, 6],
  ['escaped space', 'a = "x \\ y"', 'badEscape', 1, 8],
  ['short \\u escape', 'a = "\\u12"', 'badEscape', 1, 6],
  ['surrogate \\u escape', 'a = "\\uD800"', 'badEscape', 1, 6],
  ['out of range \\U escape', 'a = "\\U00110000"', 'badEscape', 1, 6],
  ['line-ending backslash in a basic string', 'a = "x\\\ny"', 'badEscape', 1, 7],
  ['bad escape in a multi-line string', 'a = """\nok \\a"""', 'badEscape', 2, 4],
  ['leading zero', 'a = 01', 'badNumber', 1, 5],
  ['signed leading zero', 'a = -01', 'badNumber', 1, 5],
  ['trailing underscore', 'a = 1_', 'badNumber', 1, 5],
  ['leading underscore', 'a = _1', 'badNumber', 1, 5],
  ['double underscore', 'a = 1__2', 'badNumber', 1, 5],
  ['empty hex', 'a = 0x', 'badNumber', 1, 5],
  ['signed hex', 'a = +0x1', 'badNumber', 1, 5],
  ['upper-case hex prefix', 'a = 0X1F', 'badNumber', 1, 5],
  ['bad octal digit', 'a = 0o8', 'badNumber', 1, 5],
  ['bad binary digit', 'a = 0b102', 'badNumber', 1, 5],
  ['no fraction digits', 'a = 1.', 'badNumber', 1, 5],
  ['no integer digits', 'a = .5', 'badNumber', 1, 5],
  ['empty exponent', 'a = 1e', 'badNumber', 1, 5],
  ['dot before exponent', 'a = 1.e5', 'badNumber', 1, 5],
  ['leading zero float', 'a = 00.1', 'badNumber', 1, 5],
  ['two dots', 'a = 1.2.3', 'badNumber', 1, 5],
  ['bad infinity', 'a = infinity', 'badNumber', 1, 5],
  ['number in an array', 'a = [1, 2x]', 'badNumber', 1, 9],
  ['integer above the safe range', 'a = 9007199254740993', 'unsafeInteger', 1, 5],
  ['integer below the safe range', 'a = -9007199254740992', 'unsafeInteger', 1, 5],
  ['hex above the safe range', 'a = 0x20000000000000', 'unsafeInteger', 1, 5],
  ['duplicate key', 'a = 1\na = 2', 'duplicateKey', 2, 1],
  ['quoted and bare duplicate', '"a" = 1\na = 2', 'duplicateKey', 2, 1],
  ['literal and bare duplicate', "a = 1\n'a' = 2", 'duplicateKey', 2, 1],
  ['dotted table then a value', 'a.b = 1\na = 2', 'duplicateKey', 2, 1],
  ['value then a dotted key', 'a = 1\na.b = 2', 'duplicateKey', 2, 1],
  ['duplicate dotted key', 'a.b = 1\na . b = 2', 'duplicateKey', 2, 5],
  ['duplicate in an inline table', 'a = { b = 1, b = 2 }', 'duplicateKey', 1, 14],
  ['extending an inline table', 'a = { b = 1 }\na.c = 2', 'inlineExtend', 2, 1],
  ['extending a nested inline table', 'a = { b = { c = 1 }, b.d = 2 }', 'inlineExtend', 1, 22],
  ['two values on a line', 'a = 1 b = 2', 'expected', 1, 7],
  ['text after a string', 'a = "x" "y"', 'expected', 1, 9],
  ['too many closing quotes', 'a = """x""""""', 'expected', 1, 14],
  ['missing equals', 'a b = 1', 'expected', 1, 3],
  ['missing key', '= 1', 'badKey', 1, 1],
  ['missing dotted segment', 'a. = 1', 'badKey', 1, 4],
  ['non-ASCII bare key', 'é = 1', 'badKey', 1, 1],
  ['missing value at the end', 'a =', 'expected', 1, 4],
  ['missing value before a newline', 'a = \nb = 1', 'expected', 1, 5],
  ['missing array separator', 'a = [1 2]', 'expected', 1, 8],
  ['unclosed array', 'a = [1, 2', 'expected', 1, 10],
  ['missing inline separator', 'a = { b = 1 c = 2 }', 'expected', 1, 13],
  ['empty array element', 'a = [1,,2]', 'unexpected', 1, 8],
  ['bad bare value', 'a = tru', 'unexpected', 1, 5],
  ['bad character for a value', 'a = @', 'unexpected', 1, 5],
  ['control character in a string', 'a = "x\u0001y"', 'control', 1, 7],
  ['control character in a literal', "a = '''x\u0001'''", 'control', 1, 9],
  ['control character in a comment', '# c\u0007', 'control', 1, 4],
  ['DEL in a comment', 'a = 1 # \u007f', 'control', 1, 9],
  ['bare CR', 'a = 1\rb = 2', 'unexpected', 1, 6],
  ['bare CR in a multi-line string', 'a = """x\ry"""', 'control', 1, 9],
  ['__proto__ key', '__proto__ = 1', 'reservedKey', 1, 1],
  ['constructor in a dotted key', 'a.constructor = 1', 'reservedKey', 1, 3],
  ['quoted prototype key', "'prototype' = 1", 'reservedKey', 1, 1],
  ['reserved key in an inline table', 'a = { __proto__ = 1 }', 'reservedKey', 1, 7],
  ['trailing comma in an inline table', 'a = {a = 1,}', 'toml11', 1, 11],
  ['newline inside an inline table', 'a = { b = 1,\n c = 2 }', 'toml11', 1, 13],
  ['newline after an inline table opens', 'a = {\n}', 'toml11', 1, 6],
  ['comment inside an inline table', 'a = { b = 1 # c\n}', 'toml11', 1, 13],
  ['\\e escape', 'a = "\\e"', 'toml11', 1, 6],
  ['\\x escape', 'a = "\\x41"', 'toml11', 1, 6],
  ['time without seconds', 't = 07:32', 'toml11', 1, 5],
  ['date-time without seconds', 't = 1979-05-27T07:32Z', 'toml11', 1, 5],
  ['February 30', 'd = 1979-02-30', 'badDate', 1, 5],
  ['February 29 in a common year', 'd = 1900-02-29', 'badDate', 1, 5],
  ['month 13', 'd = 1979-13-01', 'badDate', 1, 5],
  ['hour 24', 'd = 24:00:00', 'badDate', 1, 5],
  ['offset out of range', 'd = 1979-05-27T07:32:00+25:00', 'badDate', 1, 5],
  ['bad separator', 'd = 1979-05-27X07:32:00', 'badDate', 1, 5],
  ['empty fraction', 'd = 07:32:00.', 'badDate', 1, 5],
  ['column counts an astral glyph once', 'a = "\u{f024b}" b = 1', 'expected', 1, 9],
  [
    'too deep',
    `a = ${'['.repeat(MAX_TOML_DEPTH + 1)}${']'.repeat(MAX_TOML_DEPTH + 1)}`,
    'tooDeep',
    1,
    5 + MAX_TOML_DEPTH,
  ],
  [
    'too deep through inline tables',
    `a = ${'{ b = '.repeat(MAX_TOML_DEPTH + 1)}1${' }'.repeat(MAX_TOML_DEPTH + 1)}`,
    'tooDeep',
    1,
    5 + 6 * MAX_TOML_DEPTH,
  ],
];

describe('parseToml errors', () => {
  it.each(INVALID)('%s', (_name, text, code, line, col) => {
    const e = fail(text);
    expect({ code: e.code, line: e.line, col: e.col }).toEqual({ code, line, col });
  });

  it('rejects input over the size cap at 1:1', () => {
    const e = fail(`a = "${'x'.repeat(MAX_TOML_CHARS)}"`);
    expect({ code: e.code, line: e.line, col: e.col }).toEqual({ code: 'tooLarge', line: 1, col: 1 });
  });

  it('is an Error with a translated message', () => {
    const e = fail('a = 1\na = 2');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('TomlError');
    expect(e.message).toBe('Duplicate key "a"');
    expect(withLang('tr', () => fail('a = 1\na = 2').message)).toBe('Yinelenen anahtar "a"');
  });

  it('names TOML 1.1 constructs', () => {
    expect(fail('a = {a = 1,}').message).toBe(
      'A trailing comma in an inline table is TOML 1.1, which is not supported; remove the comma',
    );
    expect(fail('a = "\\e"').message).toBe(
      'The escape \\e is TOML 1.1, which is not supported; write \\u001b instead',
    );
    expect(fail('a = {\n}').message).toMatch(/TOML 1\.1.*\[table\]/);
    expect(fail('t = 07:32').message).toMatch(/^A time without seconds is TOML 1\.1/);
    expect(withLang('tr', () => fail('a = "\\x41"').message)).toMatch(/TOML 1\.1/);
  });

  it('shows control characters as code points', () => {
    expect(fail('a = "x\u001b"').message).toBe('Control character U+001B is not allowed here');
    expect(fail('a = "\\\u001b"').message).not.toMatch(/\u001b/);
    expect(fail('"\\u001b" = 1\n"\\u001b" = 2').message).toBe('Duplicate key "U+001B"');
  });
});
