import { describe, expect, it } from 'vitest';
import { JOIN } from '../../src/core/eaw-table.js';
import {
  charWidth,
  graphemeWidth,
  NORMAL_WIDTH,
  padVisible,
  setWidthMode,
  stripAnsi,
  textWidth,
  truncate,
  visibleWidth,
  visibleWidthIn,
  type WidthMode,
  widthMode,
  widthTier,
} from '../../src/core/width.js';

const JET: WidthMode = { emoji: 1, ambiguous: 1 };
const AMB2: WidthMode = { emoji: 2, ambiguous: 2 };

// [label, text, normal, jetbrains, ambiguous 2]
const GLYPHS: [string, string, number, number, number][] = [
  ['empty', '', 0, 0, 0],
  ['ascii a', 'a', 1, 1, 1],
  ['ascii abc', 'abc', 3, 3, 3],
  ['space', ' ', 1, 1, 1],
  ['tilde', '~', 1, 1, 1],
  ['tab', '\t', 0, 0, 0],
  ['bel', '\u{7}', 0, 0, 0],
  ['del', '\u{7F}', 0, 0, 0],
  ['c1 nel', '\u{85}', 0, 0, 0],
  ['nbsp', '\u{A0}', 1, 1, 1],
  ['soft hyphen', '\u{AD}', 0, 0, 0],
  ['inverted exclamation', '¡', 1, 1, 2],
  ['cent', '¢', 1, 1, 1],
  ['currency sign', '¤', 1, 1, 2],
  ['copyright', '©', 1, 1, 1],
  ['registered', '®', 1, 1, 2],
  ['degree', '°', 1, 1, 2],
  ['plus minus', '±', 1, 1, 2],
  ['middle dot', '·', 1, 1, 2],
  ['one half', '½', 1, 1, 2],
  ['times', '×', 1, 1, 2],
  ['e acute', 'é', 1, 1, 2],
  ['n tilde', 'ñ', 1, 1, 1],
  ['a macron', 'ā', 1, 1, 2],
  ['dotless i', 'ı', 1, 1, 2],
  ['g breve', 'ğ', 1, 1, 1],
  ['s cedilla', 'ş', 1, 1, 1],
  ['a caron', 'ǎ', 1, 1, 2],
  ['e combining acute', 'e\u{301}', 1, 1, 1],
  ['a combining diaeresis', 'a\u{308}', 1, 1, 1],
  ['two combining marks', 'o\u{302}\u{323}', 1, 1, 1],
  ['lone combining mark', '\u{301}', 0, 0, 0],
  ['greek alpha', 'α', 1, 1, 2],
  ['greek omega', 'Ω', 1, 1, 2],
  ['cyrillic zhe', 'ж', 1, 1, 2],
  ['hebrew with point', '\u{5E9}\u{5B8}', 1, 1, 1],
  ['arabic beh', '\u{628}', 1, 1, 1],
  ['devanagari ka', '\u{915}', 1, 1, 1],
  ['devanagari ka with sign i', '\u{915}\u{93F}', 1, 1, 1],
  ['thai ko kai', '\u{E01}', 1, 1, 1],
  ['thai with vowel mark', '\u{E01}\u{E34}', 1, 1, 1],
  ['cjk zhong', '中', 2, 2, 2],
  ['cjk nihon', '日本', 4, 4, 4],
  ['cjk mixed ascii', '中文abc', 7, 7, 7],
  ['cjk ext b', '\u{2000B}', 2, 2, 2],
  ['hiragana a', 'あ', 2, 2, 2],
  ['katakana a', 'ア', 2, 2, 2],
  ['kana with combining dakuten', 'か\u{3099}', 2, 2, 2],
  ['ideographic comma', '、', 2, 2, 2],
  ['ideographic space', '\u{3000}', 2, 2, 2],
  ['wave dash', '〜', 2, 2, 2],
  ['hangul syllable', '한', 2, 2, 2],
  ['hangul word', '한국어', 6, 6, 6],
  ['hangul jamo l', '\u{1100}', 2, 2, 2],
  ['hangul decomposed lv', '\u{1100}\u{1161}', 2, 2, 2],
  ['hangul decomposed lvt', '\u{1100}\u{1161}\u{11A8}', 2, 2, 2],
  ['fullwidth A', 'Ａ', 2, 2, 2],
  ['fullwidth one', '１', 2, 2, 2],
  ['fullwidth exclamation', '！', 2, 2, 2],
  ['fullwidth yen', '￥', 2, 2, 2],
  ['halfwidth katakana', 'ｱ', 1, 1, 1],
  ['grinning face', '\u{1F600}', 2, 1, 2],
  ['rocket', '\u{1F680}', 2, 1, 2],
  ['thumbs up', '\u{1F44D}', 2, 1, 2],
  ['party popper', '\u{1F389}', 2, 1, 2],
  ['fire', '\u{1F525}', 2, 1, 2],
  ['ringed planet', '\u{1FA90}', 2, 1, 2],
  ['orange circle', '\u{1F7E0}', 2, 1, 2],
  ['mahjong red dragon', '\u{1F004}', 2, 1, 2],
  ['high voltage', '⚡', 2, 1, 2],
  ['check mark button', '✅', 2, 1, 2],
  ['cross mark', '❌', 2, 1, 2],
  ['star', '⭐', 2, 1, 2],
  ['hourglass', '⌛', 2, 1, 2],
  ['hourglass flowing', '⏳', 2, 1, 2],
  ['zwj family', '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}', 2, 1, 2],
  ['zwj technologist', '\u{1F469}\u{200D}\u{1F4BB}', 2, 1, 2],
  ['zwj astronaut', '\u{1F9D1}\u{200D}\u{1F680}', 2, 1, 2],
  ['zwj rainbow flag', '\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}', 2, 1, 2],
  ['flag tr', '\u{1F1F9}\u{1F1F7}', 2, 1, 2],
  ['flag us', '\u{1F1FA}\u{1F1F8}', 2, 1, 2],
  ['flag jp', '\u{1F1EF}\u{1F1F5}', 2, 1, 2],
  ['flag england', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', 2, 1, 2],
  ['lone regional indicator', '\u{1F1F9}', 1, 1, 1],
  ['flag and a lone indicator', '\u{1F1F9}\u{1F1F7}\u{1F1FA}', 3, 2, 3],
  ['keycap one', '1\u{FE0F}\u{20E3}', 2, 1, 2],
  ['keycap hash', '#\u{FE0F}\u{20E3}', 2, 1, 2],
  ['keycap without vs16', '1\u{20E3}', 1, 1, 1],
  ['heart vs16', '❤\u{FE0F}', 2, 1, 2],
  ['heart vs15', '❤\u{FE0E}', 1, 1, 1],
  ['heart bare', '❤', 1, 1, 1],
  ['sun vs16', '☀\u{FE0F}', 2, 1, 2],
  ['sun bare', '☀', 1, 1, 1],
  ['heavy check vs16', '✔\u{FE0F}', 2, 1, 2],
  ['copyright vs16', '©\u{FE0F}', 2, 1, 2],
  ['registered vs16', '®\u{FE0F}', 2, 1, 2],
  ['information vs16', 'ℹ\u{FE0F}', 2, 1, 2],
  ['desktop computer bare', '\u{1F5A5}', 1, 1, 1],
  ['desktop computer vs16', '\u{1F5A5}\u{FE0F}', 2, 1, 2],
  ['thermometer bare', '\u{1F321}', 1, 1, 1],
  ['high voltage vs15', '⚡\u{FE0E}', 2, 2, 2],
  ['skin tone thumbs up', '\u{1F44D}\u{1F3FD}', 2, 1, 2],
  ['skin tone waving hand', '\u{1F44B}\u{1F3FB}', 2, 1, 2],
  ['text around vs16', 'a❤\u{FE0F}b', 4, 3, 4],
  ['nerd font powerline', '\u{E0B0}', 1, 1, 1],
  ['nerd font branch', '\u{E0A0}', 1, 1, 1],
  ['nerd font folder', '\u{F07B}', 1, 1, 1],
  ['nerd font md', '\u{F0001}', 1, 1, 1],
  ['plane 16 pua', '\u{100000}', 1, 1, 1],
  ['powerline between text', 'a\u{E0B0}b', 3, 3, 3],
  ['box vertical', '│', 1, 1, 2],
  ['box horizontal', '─', 1, 1, 2],
  ['box heavy horizontal', '━', 1, 1, 2],
  ['box corner', '┌', 1, 1, 2],
  ['box round corner', '╭', 1, 1, 2],
  ['full block', '█', 1, 1, 2],
  ['lower eighth block', '▁', 1, 1, 2],
  ['left half block', '▌', 1, 1, 2],
  ['light shade', '░', 1, 1, 1],
  ['black circle', '●', 1, 1, 2],
  ['white circle', '○', 1, 1, 2],
  ['black diamond', '◆', 1, 1, 2],
  ['black square', '■', 1, 1, 2],
  ['black triangle', '▲', 1, 1, 2],
  ['play triangle', '▶', 1, 1, 2],
  ['black star', '★', 1, 1, 2],
  ['ballot box', '☐', 1, 1, 1],
  ['check mark', '✓', 1, 1, 1],
  ['ballot x', '✗', 1, 1, 1],
  ['braille full', '⣿', 1, 1, 1],
  ['braille blank', '\u{2800}', 1, 1, 1],
  ['ellipsis', '…', 1, 1, 2],
  ['en dash', '–', 1, 1, 2],
  ['em dash', '—', 1, 1, 2],
  ['bullet', '•', 1, 1, 2],
  ['right arrow', '→', 1, 1, 2],
  ['upwards arrow', '⇡', 1, 1, 1],
  ['greater equal', '≥', 1, 1, 2],
  ['euro', '€', 1, 1, 2],
  ['trade mark', '™', 1, 1, 2],
  ['stopwatch bare', '⏱', 1, 1, 1],
  ['place of interest', '⌘', 1, 1, 1],
  ['alternative key', '⎇', 1, 1, 1],
  ['zero width space', '\u{200B}', 0, 0, 0],
  ['zero width joiner', '\u{200D}', 0, 0, 0],
  ['word joiner', '\u{2060}', 0, 0, 0],
  ['bom', '\u{FEFF}', 0, 0, 0],
  ['lrm', '\u{200E}', 0, 0, 0],
  ['lone vs16', '\u{FE0F}', 0, 0, 0],
  ['lone vs15', '\u{FE0E}', 0, 0, 0],
  ['lone keycap mark', '\u{20E3}', 0, 0, 0],
  ['lone tag', '\u{E0067}', 0, 0, 0],
  ['zwsp between text', 'a\u{200B}b', 2, 2, 2],
  ['status line text', 'abc │ █', 7, 7, 9],
  ['cjk ascii emoji', '中a\u{1F600}', 5, 4, 5],
];

describe('width fixtures', () => {
  it('has about 120 glyphs', () => {
    expect(GLYPHS.length).toBeGreaterThanOrEqual(120);
  });

  it.each(GLYPHS)('%s', (_label, text, normal, jet, amb2) => {
    expect([textWidth(text, NORMAL_WIDTH), textWidth(text, JET), textWidth(text, AMB2)]).toEqual([
      normal,
      jet,
      amb2,
    ]);
    expect(visibleWidthIn(`\x1b[31m${text}\x1b[0m`, NORMAL_WIDTH)).toBe(normal);
  });

  it('charWidth reads the first code point', () => {
    expect(charWidth('a')).toBe(1);
    expect(charWidth('中')).toBe(2);
    expect(charWidth('\u{301}')).toBe(0);
    expect(charWidth('é', AMB2)).toBe(2);
    expect(charWidth('\u{E0B0}', AMB2)).toBe(1);
  });

  it('strips csi and osc sequences', () => {
    expect(stripAnsi('\x1b[1;31mx\x1b[0m')).toBe('x');
    expect(stripAnsi('\u001b]8;;https://example.com\u001b\\y\u001b]8;;\u001b\\')).toBe('y');
  });
});

describe('width mode', () => {
  it('setWidthMode returns the previous mode', () => {
    expect(widthMode()).toEqual(NORMAL_WIDTH);
    const prev = setWidthMode(JET);
    try {
      expect(prev).toEqual(NORMAL_WIDTH);
      expect(widthMode()).toEqual(JET);
      expect(visibleWidth('\u{1F600}')).toBe(1);
      expect(visibleWidth('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}')).toBe(1);
      expect(visibleWidthIn('\u{1F600}', NORMAL_WIDTH)).toBe(2);
      expect(['\u{1F600}', 'ab'].map(visibleWidth)).toEqual([1, 2]);
    } finally {
      expect(setWidthMode(prev)).toEqual(JET);
    }
    expect(visibleWidth('\u{1F600}')).toBe(2);
  });

  it('follows ambiguous 2 from the module mode', () => {
    const prev = setWidthMode(AMB2);
    try {
      expect(visibleWidth('│ é \u{E0B0}')).toBe(7);
    } finally {
      setWidthMode(prev);
    }
    expect(visibleWidth('│ é \u{E0B0}')).toBe(5);
  });
});

describe('tiers', () => {
  it('picks the cheapest tier that applies', () => {
    expect(widthTier('abc')).toBe(1);
    expect(widthTier('')).toBe(1);
    expect(widthTier('é')).toBe(1);
    expect(widthTier('é', AMB2)).toBe(2);
    expect(widthTier('abc │ █')).toBe(2);
    expect(widthTier('\u{E0B0} main')).toBe(2);
    expect(widthTier('한국어')).toBe(2);
    expect(widthTier('\u{1F600}')).toBe(2);
    expect(widthTier('a\u{200D}b')).toBe(3);
    expect(widthTier('e\u{301}')).toBe(3);
    expect(widthTier('\u{1F1F9}\u{1F1F7}')).toBe(3);
    expect(widthTier('❤\u{FE0F}')).toBe(3);
  });

  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const RANGES: [number, number][] = [
    [0x20, 0x7e],
    [0xa0, 0xff],
    [0x100, 0x17f],
    [0x391, 0x3c9],
    [0x410, 0x44f],
    [0x2010, 0x2027],
    [0x2190, 0x21ff],
    [0x2500, 0x257f],
    [0x2580, 0x259f],
    [0x25a0, 0x25ff],
    [0x2600, 0x26ff],
    [0x2700, 0x27bf],
    [0x2800, 0x28ff],
    [0x3000, 0x303f],
    [0x3041, 0x3096],
    [0x4e00, 0x4fff],
    [0xac00, 0xd7a3],
    [0xe000, 0xe0ff],
    [0xf000, 0xf8ff],
    [0xff01, 0xffee],
    [0x1f300, 0x1f64f],
    [0x1f680, 0x1f6ff],
    [0x1f900, 0x1f9ff],
    [0xf0000, 0xf00ff],
  ];

  function inJoin(cp: number): boolean {
    for (let i = 0; i < JOIN.length; i += 2) if (cp >= JOIN[i]! && cp <= JOIN[i + 1]!) return true;
    return false;
  }

  const POOL = RANGES.flatMap(([lo, hi]) =>
    Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).filter((cp) => !inJoin(cp)),
  );

  it('gives tier 2 and the segmenter the same width on random strings', () => {
    const rand = mulberry32(0x5eed);
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const modes: WidthMode[] = [NORMAL_WIDTH, JET, AMB2, { emoji: 1, ambiguous: 2 }];
    let tier2 = 0;
    for (let n = 0; n < 2000; n++) {
      const len = 1 + Math.floor(rand() * 24);
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCodePoint(POOL[Math.floor(rand() * POOL.length)]!);
      for (const m of modes) {
        const tier = widthTier(s, m);
        expect(tier).not.toBe(3);
        if (tier === 2) tier2++;
        let w = 0;
        for (const { segment } of seg.segment(s)) w += graphemeWidth(segment, m);
        expect(textWidth(s, m), JSON.stringify(s)).toBe(w);
      }
    }
    expect(tier2).toBeGreaterThan(4000);
  });
});

describe('truncate by grapheme', () => {
  it('never ends in a partial zwj cluster', () => {
    const out = truncate('ab\u{1F468}\u{200D}\u{1F469}cd', 3);
    expect(out).toBe('ab…');
    expect(truncate('ab\u{1F468}\u{200D}\u{1F469}cd', 5)).toBe('ab\u{1F468}\u{200D}\u{1F469}…');
  });

  it('never splits a flag pair', () => {
    expect(truncate('\u{1F1F9}\u{1F1F7}\u{1F1FA}\u{1F1F8}x', 3)).toBe('\u{1F1F9}\u{1F1F7}…');
    expect(truncate('a\u{1F1F9}\u{1F1F7}bc', 2)).toBe('a…');
  });

  it('keeps combining marks with their base', () => {
    expect(truncate('e\u{301}e\u{301}e\u{301}', 2)).toBe('e\u{301}…');
    expect(truncate('ab\u{1F44D}\u{1F3FD}cd', 5)).toBe('ab\u{1F44D}\u{1F3FD}…');
  });

  it('walks ansi inside a cluster', () => {
    const out = truncate('xe\x1b[31m\u{301}yz', 3);
    expect(out).toBe('xe\x1b[31m\u{301}…\x1b[0m');
  });

  it('closes an osc 8 link cut inside emoji text', () => {
    const link = '\u001b]8;;https://example.com\u001b\\\u{1F468}\u{200D}\u{1F469} team\u001b]8;;\u001b\\';
    const out = truncate(`${link} tail`, 4);
    expect(out).toBe(
      '\u001b]8;;https://example.com\u001b\\\u{1F468}\u{200D}\u{1F469} …\u001b]8;;\u001b\\\u001b[0m',
    );
  });

  it('resets sgr after a cut', () => {
    const out = truncate('\x1b[31m❤\u{FE0F}❤\u{FE0F}❤\u{FE0F}\x1b[0m', 5);
    expect(stripAnsi(out)).toBe('❤\u{FE0F}❤\u{FE0F}…');
    expect(out.endsWith('\x1b[0m')).toBe(true);
  });

  it('uses the given mode', () => {
    expect(truncate('\u{1F600}\u{1F600}\u{1F600}', 3, '…', JET)).toBe('\u{1F600}\u{1F600}\u{1F600}');
    expect(truncate('\u{1F600}\u{1F600}\u{1F600}', 3)).toBe('\u{1F600}…');
  });
});

describe('padVisible', () => {
  it('pads by visible width', () => {
    expect(padVisible('ab', 4)).toBe('ab  ');
    expect(padVisible('ab', 4, 'right')).toBe('  ab');
    expect(padVisible('ab', 4, 'center')).toBe(' ab ');
    expect(padVisible('ab', 5, 'center')).toBe(' ab  ');
    expect(padVisible('\uFF21', 3)).toBe('\uFF21 ');
    expect(padVisible('\x1b[31mab\x1b[0m', 3)).toBe('\x1b[31mab\x1b[0m ');
  });

  it('truncates to exactly the width', () => {
    const out = padVisible('abcdefgh', 5);
    expect(out).toBe('abcd…');
    expect(visibleWidth(out)).toBe(5);
    expect(visibleWidth(padVisible('\uFF21\uFF21\uFF21', 5, 'right'))).toBe(5);
  });

  it('counts Turkish letters as one column each', () => {
    expect(visibleWidth('çğış')).toBe(4);
    expect(padVisible('çğış', 6)).toBe('çğış  ');
  });
});
