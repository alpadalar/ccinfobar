import path from 'node:path';

// shell-like split; a backslash is never an escape (Windows paths)
export function commandArgs(command: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '"' || c === "'") {
      const end = command.indexOf(c, i + 1);
      const stop = end < 0 ? command.length : end;
      cur = (cur ?? '') + command.slice(i + 1, stop);
      i = stop;
    } else if (/\s/.test(c)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else {
      cur = (cur ?? '') + c;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

export function flagValue(args: readonly string[], names: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const name of names) {
      if (a === name) return args[i + 1] ?? null;
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
    }
  }
  return null;
}

export function boolFlag(args: readonly string[], names: readonly string[]): boolean | null {
  for (const a of args) {
    for (const name of names) {
      if (a === name) return true;
      if (!a.startsWith(`${name}=`)) continue;
      const v = a.slice(name.length + 1).toLowerCase();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
    }
  }
  return null;
}

export function firstPathToken(command: string, home: string): string | null {
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const raw = m[1] ?? m[2] ?? m[3]!;
    const token = raw.startsWith('~') ? path.join(home, raw.slice(1)) : raw;
    if (/[\\/]/.test(token)) return path.isAbsolute(token) ? token : null;
  }
  return null;
}
