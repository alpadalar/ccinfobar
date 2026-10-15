import fs from 'node:fs';
import path from 'node:path';
import { type FileKind, MAX_REPORT_FILES } from '../core/report-types.js';

export interface WalkedFile {
  rel: string;
  abs: string;
  kind: FileKind;
  sid: string;
  enc: string;
}

const SID = /^[A-Za-z0-9_-]{1,128}$/;
const MAIN = /^([A-Za-z0-9_-]{1,128})\.jsonl$/;
const ORPHANED = /^([A-Za-z0-9_-]{1,128})\.orphaned-.*\.jsonl$/;
const SUPERSEDED = /^([A-Za-z0-9_-]{1,128})\.jsonl\.superseded-.+$/;
const AGENT = /^agent-.+\.jsonl$/;
const AGENT_DEPTH = 4;

const byName = (a: fs.Dirent, b: fs.Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function list(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function walkTranscripts(
  claudeDir: string,
  maxFiles = MAX_REPORT_FILES,
): { files: WalkedFile[]; capped: boolean } {
  const files: WalkedFile[] = [];
  let capped = false;
  const add = (f: WalkedFile): boolean => {
    if (files.length >= maxFiles) {
      capped = true;
      return false;
    }
    files.push(f);
    return true;
  };
  const agents = (dir: string, rel: string, depth: number, sid: string, enc: string): boolean => {
    for (const d of list(dir)) {
      if (d.isSymbolicLink()) continue;
      const abs = path.join(dir, d.name);
      if (d.isFile() && AGENT.test(d.name)) {
        if (!add({ rel: `${rel}/${d.name}`, abs, kind: 'agent', sid, enc })) return false;
      } else if (d.isDirectory() && depth < AGENT_DEPTH) {
        if (!agents(abs, `${rel}/${d.name}`, depth + 1, sid, enc)) return false;
      }
    }
    return true;
  };
  const projects = path.join(claudeDir, 'projects');
  for (const p of list(projects)) {
    if (p.isSymbolicLink() || !p.isDirectory()) continue;
    const enc = p.name;
    const dir = path.join(projects, enc);
    const base = `projects/${enc}`;
    for (const d of list(dir)) {
      if (d.isSymbolicLink()) continue;
      const abs = path.join(dir, d.name);
      const rel = `${base}/${d.name}`;
      if (d.isFile()) {
        const main = MAIN.exec(d.name);
        const aside = main ? null : (ORPHANED.exec(d.name) ?? SUPERSEDED.exec(d.name));
        const sid = main?.[1] ?? aside?.[1];
        if (sid && !add({ rel, abs, kind: main ? 'main' : 'aside', sid, enc })) return { files, capped };
      } else if (d.isDirectory() && SID.test(d.name)) {
        const sub = path.join(abs, 'subagents');
        if (isDir(sub) && !agents(sub, `${rel}/subagents`, 1, d.name, enc)) return { files, capped };
      }
    }
  }
  return { files, capped };
}
