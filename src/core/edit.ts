import type { Config, WidgetItem } from './types.js';

export interface Position {
  line: number;
  index: number;
}

function clone(config: Config): Config {
  return { ...config, lines: config.lines.map((l) => l.map((i) => ({ ...i }))) };
}

export function uniqueId(config: Config, type: string): string {
  const ids = new Set(config.lines.flat().map((i) => i.id));
  let n = 1;
  while (ids.has(`${type}-${n}`)) n++;
  return `${type}-${n}`;
}

export function findItem(config: Config, id: string): (Position & { item: WidgetItem }) | null {
  for (let line = 0; line < config.lines.length; line++) {
    const index = config.lines[line]!.findIndex((i) => i.id === id);
    if (index >= 0) return { line, index, item: config.lines[line]![index]! };
  }
  return null;
}

export function insertItem(
  config: Config,
  item: Omit<WidgetItem, 'id'> & { id?: string },
  at: Position,
): Config {
  const next = clone(config);
  while (next.lines.length <= at.line) next.lines.push([]);
  const line = next.lines[at.line]!;
  const index = Math.max(0, Math.min(at.index, line.length));
  line.splice(index, 0, { ...item, id: item.id ?? uniqueId(next, item.type) });
  return next;
}

export function removeItem(config: Config, id: string): Config {
  const next = clone(config);
  next.lines = next.lines.map((l) => l.filter((i) => i.id !== id));
  return next;
}

export function moveItem(config: Config, id: string, to: Position): Config {
  const found = findItem(config, id);
  if (!found) return config;
  const next = clone(config);
  const [item] = next.lines[found.line]!.splice(found.index, 1);
  while (next.lines.length <= to.line) next.lines.push([]);
  let index = to.index;
  if (found.line === to.line && found.index < to.index) index--;
  const line = next.lines[to.line]!;
  line.splice(Math.max(0, Math.min(index, line.length)), 0, item!);
  return next;
}

export function updateItem(config: Config, id: string, patch: Partial<WidgetItem>): Config {
  const next = clone(config);
  next.lines = next.lines.map((l) =>
    l.map((i) => {
      if (i.id !== id) return i;
      const merged: WidgetItem = { ...i, ...patch, id: i.id };
      for (const k of Object.keys(merged) as (keyof WidgetItem)[]) {
        if (merged[k] === undefined) delete merged[k];
      }
      return merged;
    }),
  );
  return next;
}

export function setOption(
  config: Config,
  id: string,
  key: string,
  value: string | number | boolean | undefined,
): Config {
  const found = findItem(config, id);
  if (!found) return config;
  const options = { ...found.item.options };
  if (value === undefined) delete options[key];
  else options[key] = value;
  return updateItem(config, id, { options });
}

export function addLine(config: Config, at = config.lines.length): Config {
  const next = clone(config);
  next.lines.splice(at, 0, []);
  return next;
}

export function removeLine(config: Config, line: number): Config {
  const next = clone(config);
  next.lines.splice(line, 1);
  return next;
}

export function moveLine(config: Config, from: number, to: number): Config {
  if (from === to || from < 0 || from >= config.lines.length) return config;
  const next = clone(config);
  const [l] = next.lines.splice(from, 1);
  next.lines.splice(Math.max(0, Math.min(to, next.lines.length)), 0, l!);
  return next;
}
