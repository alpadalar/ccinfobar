import fs from 'node:fs';
import path from 'node:path';

export type CommandTarget =
  | { kind: 'bin'; bin: string; onPath: boolean }
  | { kind: 'script'; script: string; node?: string };

export type BuiltCommand =
  | { ok: true; command: string }
  | { ok: false; reason: 'unsafe-path'; path: string; chars: string };

export function shQuote(p: string): string {
  return /^[A-Za-z0-9_/.:@%+=,-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

// bash and powershell expand these inside double quotes
const WIN_UNSAFE = /["`$%\x00-\x1f\x7f]/g;

function show(c: string): string {
  return c < ' ' || c === '\x7f' ? JSON.stringify(c).slice(1, -1) : c;
}

export function winArg(p: string): BuiltCommand {
  const bad = [...new Set(p.match(WIN_UNSAFE) ?? [])];
  if (bad.length) return { ok: false, reason: 'unsafe-path', path: p, chars: bad.map(show).join('') };
  const fwd = p.replace(/\\/g, '/');
  return { ok: true, command: /^[A-Za-z0-9_/.:-]+$/.test(fwd) ? fwd : `"${fwd}"` };
}

export function jsForWinBin(bin: string): string {
  const w = path.win32;
  const dir = w.dirname(bin);
  const parent = w.dirname(dir);
  const pkg =
    w.basename(dir) === '.bin' && w.basename(parent).toLowerCase() === 'node_modules'
      ? parent
      : w.join(dir, 'node_modules');
  return w.join(pkg, 'ccinfobar', 'dist', 'ccinfobar.js');
}

function viaNode(js: string): BuiltCommand {
  const arg = winArg(js);
  return arg.ok ? { ok: true, command: `node ${arg.command}` } : arg;
}

// never a backslash, a .cmd first token or process.execPath on win32;
// node + js also runs where PowerShell blocks the .ps1 shim
export function buildCommand(
  target: CommandTarget,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
): BuiltCommand {
  if (platform === 'win32') {
    if (target.kind === 'script') return viaNode(target.script);
    const js = jsForWinBin(target.bin);
    if (target.onPath && !exists(js)) return { ok: true, command: 'ccinfobar' };
    return viaNode(js);
  }
  if (target.kind === 'bin') return { ok: true, command: shQuote(target.bin) };
  return { ok: true, command: `${shQuote(target.node ?? process.execPath)} ${shQuote(target.script)}` };
}
