export type PathSegment = string | number;

export type PathErrorCode = 'badPath' | 'protoSegment' | 'outOfRange' | 'notContainer';

export class PathError extends Error {
  constructor(
    readonly code: PathErrorCode,
    message: string,
    readonly segment?: string,
  ) {
    super(message);
    this.name = 'PathError';
  }
}

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function guard(path: readonly PathSegment[]): void {
  for (const seg of path) {
    if (typeof seg === 'string' && BLOCKED.has(seg)) {
      throw new PathError('protoSegment', `segment "${seg}" is not allowed`, seg);
    }
  }
}

export function parsePath(text: string): PathSegment[] {
  const path = text.split('.').map((seg) => {
    if (!seg) throw new PathError('badPath', `invalid path "${text}"`);
    return /^\d+$/.test(seg) ? Number(seg) : seg;
  });
  guard(path);
  return path;
}

function child(node: unknown, seg: PathSegment): { found: boolean; value: unknown } {
  if (Array.isArray(node)) {
    if (typeof seg === 'number' && seg < node.length) return { found: true, value: node[seg] };
  } else if (isObj(node)) {
    const key = String(seg);
    if (Object.hasOwn(node, key)) return { found: true, value: node[key] };
  }
  return { found: false, value: undefined };
}

export function getPath(root: unknown, path: readonly PathSegment[]): { found: boolean; value: unknown } {
  guard(path);
  let node = root;
  for (const seg of path) {
    const next = child(node, seg);
    if (!next.found) return next;
    node = next.value;
  }
  return { found: true, value: node };
}

function setIn(node: unknown, path: readonly PathSegment[], i: number, value: unknown): unknown {
  if (i === path.length) return value;
  const seg = path[i]!;
  if (Array.isArray(node)) {
    if (typeof seg !== 'number') throw new PathError('notContainer', `"${seg}" is not an array index`);
    if (seg > node.length) throw new PathError('outOfRange', `index ${seg} is past the end`);
    const copy = node.slice();
    copy[seg] = setIn(node[seg], path, i + 1, value);
    return copy;
  }
  const base = node === undefined ? {} : node;
  if (!isObj(base)) throw new PathError('notContainer', `cannot set "${seg}" inside a non-object`);
  const key = String(seg);
  const copy: Obj = { ...base };
  copy[key] = setIn(Object.hasOwn(base, key) ? base[key] : undefined, path, i + 1, value);
  return copy;
}

export function setPath(root: unknown, path: readonly PathSegment[], value: unknown): unknown {
  guard(path);
  return setIn(root, path, 0, value);
}

function unsetIn(node: unknown, path: readonly PathSegment[], i: number): { found: boolean; value: unknown } {
  const seg = path[i]!;
  const here = child(node, seg);
  if (!here.found) return { found: false, value: node };
  if (i < path.length - 1) {
    const inner = unsetIn(here.value, path, i + 1);
    if (!inner.found) return { found: false, value: node };
    if (Array.isArray(node)) {
      const copy = node.slice();
      copy[seg as number] = inner.value;
      return { found: true, value: copy };
    }
    return { found: true, value: { ...(node as Obj), [String(seg)]: inner.value } };
  }
  if (Array.isArray(node)) {
    const copy = node.slice();
    copy.splice(seg as number, 1);
    return { found: true, value: copy };
  }
  const copy: Obj = { ...(node as Obj) };
  delete copy[String(seg)];
  return { found: true, value: copy };
}

export function unsetPath(root: unknown, path: readonly PathSegment[]): { found: boolean; value: unknown } {
  guard(path);
  if (!path.length) return { found: false, value: root };
  return unsetIn(root, path, 0);
}
