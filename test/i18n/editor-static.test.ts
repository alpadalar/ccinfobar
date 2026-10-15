import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { en } from '../../src/core/i18n/en/index.js';
import { tr } from '../../src/core/i18n/tr/index.js';
import { applyStatic } from '../../src/editor/web/i18n-static.js';
import { withLang } from '../helpers.js';
import { FakeEl, texts } from './fake-dom.js';

const html = fs.readFileSync(path.resolve(__dirname, '../../src/editor/web/index.html'), 'utf8');
const ATTRS = ['title', 'placeholder', 'aria-label'];
const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr']);
const ENTITIES: Record<string, string> = { hellip: '…', gt: '>', lt: '<', amp: '&', nbsp: ' ', quot: '"' };

const decode = (s: string) => s.replace(/&(\w+);/g, (m, k: string) => ENTITIES[k] ?? m);
const message = (key: string): string | undefined => {
  const m = Object.hasOwn(en, key) ? (en as Record<string, unknown>)[key] : undefined;
  return typeof m === 'string' ? m : undefined;
};

type Node = { el: FakeEl; tag: string; attrs: Map<string, string>; elements: number };
type Text = { text: string; stack: Node[] };

function parse(src: string): { root: FakeEl; nodes: Node[]; textNodes: Text[] } {
  const root = new FakeEl('ROOT');
  const stack: Node[] = [];
  const nodes: Node[] = [];
  const textNodes: Text[] = [];
  const top = () => stack[stack.length - 1]?.el ?? root;
  for (const m of src.matchAll(/<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) {
      const text = decode(m[4]);
      top().append(text);
      if (text.trim()) textNodes.push({ text: text.trim(), stack: [...stack] });
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      while (stack.length && stack.pop()!.tag !== tag) {}
      continue;
    }
    const attrs = new Map<string, string>();
    for (const a of m[3]!.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs.set(a[1]!, decode(a[2] ?? ''));
    const el = new FakeEl(tag.toUpperCase());
    for (const [k, v] of attrs) el.setAttribute(k, v);
    const parent = stack[stack.length - 1];
    if (parent) parent.elements++;
    top().append(el);
    const node: Node = { el, tag, attrs, elements: 0 };
    nodes.push(node);
    if (!VOID.has(tag)) stack.push(node);
  }
  return { root, nodes, textNodes };
}

const page = parse(html);

describe('index.html keys', () => {
  it('finds the static text', () => {
    expect(page.textNodes.length).toBeGreaterThan(30);
    expect(page.nodes.filter((n) => n.attrs.has('data-i18n')).length).toBeGreaterThan(25);
  });

  it('every data-i18n key exists and has no params', () => {
    const keys = page.nodes.flatMap((n) =>
      ['data-i18n', ...ATTRS.map((a) => `data-i18n-${a}`)].flatMap((k) => n.attrs.get(k) ?? []),
    );
    expect(keys.length).toBeGreaterThan(40);
    for (const key of keys) {
      expect(message(key), key).toBeTypeOf('string');
      expect(message(key), key).not.toMatch(/\{\w+\}/);
    }
  });

  it('every visible text node has a key or translate="no"', () => {
    const bare = page.textNodes.filter(
      ({ stack }) =>
        !stack.some((n) => n.tag === 'script' || n.tag === 'style') &&
        !stack.some((n) => n.attrs.has('data-i18n') || n.attrs.get('translate') === 'no'),
    );
    expect(bare.map((x) => x.text)).toEqual([]);
  });

  it('every title, placeholder and aria-label has a key', () => {
    for (const n of page.nodes) {
      for (const a of ATTRS) {
        if (!n.attrs.has(a)) continue;
        const key = n.attrs.get(`data-i18n-${a}`);
        expect(key, `${n.tag} ${a}="${n.attrs.get(a)}"`).toBeDefined();
        expect(n.attrs.get(a), key).toBe(message(key!));
      }
    }
  });

  it('keys sit on leaves and the initial text is the English message', () => {
    for (const n of page.nodes) {
      const key = n.attrs.get('data-i18n');
      if (!key) continue;
      expect(n.elements, key).toBe(0);
      expect(n.el.textContent, key).toBe(message(key));
    }
  });

  it('starts as English', () => {
    expect(html).toMatch(/<html lang="en">/);
  });
});

describe('applyStatic', () => {
  const g = globalThis as any;
  let saved: unknown;
  let doc: { documentElement: FakeEl & { lang?: string } };

  beforeEach(() => {
    saved = g.document;
    doc = { documentElement: new FakeEl('HTML') };
    g.document = doc;
  });

  afterEach(() => {
    g.document = saved;
  });

  const english = new Set(
    Object.entries(en)
      .filter(([id, v]) => typeof v === 'string' && (tr as Record<string, unknown>)[id] !== v)
      .map(([, v]) => v as string),
  );

  it('puts Turkish text and attributes in place', () => {
    const { root } = parse(html);
    withLang('tr', () => applyStatic(root as unknown as ParentNode));
    expect(doc.documentElement.lang).toBe('tr');
    const shown = texts(root);
    expect(shown.filter((s) => english.has(s))).toEqual([]);
    for (const s of ['Hazır ayarlar', 'Geri al (Ctrl+Z)', 'Bileşen ara', 'Genel', 'Satır ekle', 'Bitir'])
      expect(shown).toContain(s);
    expect(shown).toContain('ccinfobar');
    expect(shown).toContain('130 cols');
  });

  it('switches back to English', () => {
    const { root } = parse(html);
    withLang('tr', () => applyStatic(root as unknown as ParentNode));
    withLang('en', () => applyStatic(root as unknown as ParentNode));
    expect(doc.documentElement.lang).toBe('en');
    expect(texts(root).sort()).toEqual(texts(parse(html).root).sort());
  });

  it('ignores unknown and prototype keys', () => {
    const root = new FakeEl('ROOT');
    for (const key of ['__proto__', 'constructor', 'no.such.key']) {
      const el = new FakeEl('SPAN');
      el.setAttribute('data-i18n', key);
      el.setAttribute('data-i18n-title', key);
      el.setAttribute('title', 'keep');
      el.append('keep');
      root.append(el);
    }
    withLang('tr', () => applyStatic(root as unknown as ParentNode));
    expect(texts(root).every((s) => s === 'keep')).toBe(true);
  });
});
