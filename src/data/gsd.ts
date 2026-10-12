import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDir } from '../core/paths.js';

export interface GsdPhase {
  number: string;
  name: string | null;
  dir: string | null;
  plans: number;
  summaries: number;
  complete: boolean;
}

export interface GsdUpdate {
  available: boolean;
  staleHooks: boolean;
  installed: string | null;
  latest: string | null;
}

export interface GsdInfo {
  planningDir: string;
  projectDir: string;
  workstream: string | null;
  milestone: string | null;
  milestoneName: string | null;
  status: string | null;
  statusText: string | null;
  activePhase: string | null;
  phase: GsdPhase | null;
  phaseIndex: number | null;
  phasesCompleted: number;
  phasesTotal: number;
  plansCompleted: number;
  plansTotal: number;
  percent: number | null;
  nextAction: string | null;
  nextPhases: string[];
  blockers: string[];
  pendingTodos: number;
  requirementsDone: number;
  requirementsTotal: number;
  lastActivity: string | null;
  stoppedAt: string | null;
  update: GsdUpdate | null;
}

type FrontValue = string | string[];

interface RoadmapPhase {
  number: string;
  name: string;
  done: boolean;
}

interface DiskPhase {
  number: string;
  slug: string;
  dir: string;
  plans: number;
  summaries: number;
}

const MAX_DEPTH = 10;
const WORKSTREAM_RE = /^[A-Za-z0-9._-]+$/;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0]!)) return t.slice(1, -1);
  return t.replace(/\s+#.*$/, '').trim();
}

function parseFlowList(v: string): string[] | null {
  const t = v.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  return t
    .slice(1, -1)
    .split(',')
    .map((x) => unquote(x))
    .filter((x) => x !== '');
}

function splitFrontmatter(text: string): { front: string | null; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { front: null, body: src };
  return { front: m[1]!, body: src.slice(m[0].length) };
}

function parseFrontmatter(front: string): Record<string, FrontValue> {
  const out: Record<string, FrontValue> = {};
  const lines = front.split('\n');
  let parent = '';
  let listKey: string | null = null;
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const cur = out[listKey];
      const arr = Array.isArray(cur) ? cur : [];
      arr.push(unquote(item[1]!));
      out[listKey] = arr;
      continue;
    }
    const m = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const nested = m[1]!.length > 0;
    const key = nested && parent ? `${parent}.${m[2]}` : m[2]!;
    const raw = m[3]!.trim();
    if (!nested) parent = '';
    if (raw === '' || raw.startsWith('#')) {
      if (!nested) parent = key;
      listKey = key;
      out[key] = '';
      continue;
    }
    listKey = null;
    out[key] = parseFlowList(raw) ?? unquote(raw);
  }
  return out;
}

function fmString(fm: Record<string, FrontValue>, key: string): string | null {
  const v = fm[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' || t === 'null' || t === '~' ? null : t;
}

function fmNumber(fm: Record<string, FrontValue>, key: string): number | null {
  const s = fmString(fm, key);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmList(fm: Record<string, FrontValue>, key: string): string[] {
  const v = fm[key];
  if (Array.isArray(v)) return v.map((x) => normalizePhaseNumber(x)).filter((x) => x !== '');
  if (typeof v === 'string' && v.trim() !== '' && v.trim() !== 'null') {
    return v
      .split(',')
      .map((x) => normalizePhaseNumber(x))
      .filter((x) => x !== '');
  }
  return [];
}

export function normalizePhaseNumber(raw: string): string {
  const t = raw.trim().replace(/^phase\s+/i, '');
  const m = /^(\d+)((?:\.\d+)*)$/.exec(t);
  if (!m) return t;
  return `${Number.parseInt(m[1]!, 10)}${m[2]}`;
}

function comparePhaseNumbers(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function bodyField(body: string, key: string): string | null {
  const re = new RegExp(`^[\\s>*-]*\\*{0,2}${key}:\\*{0,2}[ \\t]*(.+)$`, 'im');
  const m = re.exec(body);
  return m ? m[1]!.replace(/\*\*/g, '').trim() : null;
}

function bodySection(body: string, heading: RegExp): string[] {
  const lines = body.split('\n');
  const out: string[] = [];
  let inside = false;
  let level = 0;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (inside && h[1]!.length <= level) break;
      if (!inside && heading.test(h[2]!)) {
        inside = true;
        level = h[1]!.length;
      }
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

function bullets(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (!m) continue;
    const t = m[1]!.trim();
    if (/^(none|n\/a|no\b)/i.test(t)) continue;
    out.push(t);
  }
  return out;
}

export function normalizeStatus(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (t === '') return null;
  if (/milestone complete|shipped|^complete(d)?\b/.test(t)) return 'complete';
  if (/phase complete/.test(t)) return 'phase-complete';
  if (/ready to plan/.test(t)) return 'ready-to-plan';
  if (/ready to execute/.test(t)) return 'ready-to-execute';
  if (/discuss/.test(t)) return 'discussing';
  if (/verif/.test(t)) return 'verifying';
  if (/\bplanning\b|\bplanned\b/.test(t)) return 'planning';
  if (/execut|in progress/.test(t)) return 'executing';
  if (/\bcomplete(d)?\b/.test(t)) return 'complete';
  return t.replace(/ /g, '-');
}

function parseRoadmap(text: string): {
  current: RoadmapPhase[];
  shipped: RoadmapPhase[];
  milestone: string | null;
  name: string | null;
} {
  const current: RoadmapPhase[] = [];
  const shipped: RoadmapPhase[] = [];
  let inDetails = false;
  let detailsShipped = false;
  let milestone: string | null = null;
  let name: string | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/<details/i.test(line)) {
      inDetails = true;
      detailsShipped = false;
    }
    if (inDetails && /<summary/i.test(line))
      detailsShipped = /✅|shipped|complete/i.test(line) && !/🚧/.test(line);
    if (/<\/details>/i.test(line)) inDetails = false;
    const ms = /🚧\s*\*{0,2}(v\d[\w.]*)\s*([^*\n—–]*)/.exec(line);
    if (ms && !milestone) {
      milestone = ms[1]!;
      name = ms[2]!.replace(/[\s:-]+$/, '').trim() || null;
    }
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(?:\*\*)?Phase\s+(\d+(?:\.\d+)*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let rest = m[3]!;
    const star = rest.indexOf('**');
    if (star >= 0) rest = rest.slice(0, star);
    rest = rest
      .split(/\s+[—–-]\s+/)[0]!
      .replace(/\s*\(\d+\/\d+ plans?\)/i, '')
      .trim();
    const phase: RoadmapPhase = {
      number: normalizePhaseNumber(m[2]!),
      name: rest,
      done: m[1] !== ' ',
    };
    const target = inDetails && detailsShipped ? shipped : current;
    if (!target.some((p) => p.number === phase.number)) target.push(phase);
  }
  return { current, shipped, milestone, name };
}

function isPlanFile(f: string): boolean {
  if (/-OUTLINE\.md$/i.test(f) || /\.pre-bounce\.md$/i.test(f)) return false;
  if (/-SUMMARY\.md$/i.test(f) || f === 'SUMMARY.md') return false;
  return f.endsWith('-PLAN.md') || f === 'PLAN.md' || (/\.md$/i.test(f) && /plan/i.test(f));
}

function isSummaryFile(f: string): boolean {
  return f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md';
}

function scanPhaseDir(dir: string): { plans: number; summaries: number } {
  let plans = 0;
  let summaries = 0;
  for (const f of listDir(dir)) {
    if (isPlanFile(f)) plans++;
    else if (isSummaryFile(f)) summaries++;
  }
  const nested = path.join(dir, 'plans');
  for (const f of listDir(nested)) {
    if (/^(?:.*-)?PLAN-\d+.*\.md$/i.test(f)) plans++;
    else if (/^SUMMARY-\d+.*\.md$/i.test(f)) summaries++;
  }
  return { plans, summaries };
}

function scanPhases(planningDir: string): DiskPhase[] {
  const root = path.join(planningDir, 'phases');
  const out: DiskPhase[] = [];
  for (const entry of listDir(root)) {
    const m = /^(\d+(?:\.\d+)*)(?:-(.*))?$/.exec(entry);
    if (!m) continue;
    const full = path.join(root, entry);
    if (!isDir(full)) continue;
    out.push({
      number: normalizePhaseNumber(m[1]!),
      slug: (m[2] ?? '').replace(/-/g, ' ').trim(),
      dir: entry,
      ...scanPhaseDir(full),
    });
  }
  return out;
}

function countRequirements(text: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  let skip = false;
  let parentSkip = false;
  const skipRe = /v2|future|out of scope|traceability|post-v|deferred/i;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const hit = skipRe.test(h[2]!);
      if (h[1]!.length <= 2) {
        parentSkip = hit;
        skip = hit;
      } else {
        skip = parentSkip || hit;
      }
      continue;
    }
    if (skip) continue;
    const m = /^\s*[-*]\s+\[([ xX])\]/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { done, total };
}

function findProject(cwd: string): string | null {
  const home = os.homedir();
  let dir = path.resolve(cwd);
  for (let i = 0; i < MAX_DEPTH; i++) {
    const planning = path.join(dir, '.planning');
    if (
      isFile(path.join(planning, 'STATE.md')) ||
      isFile(path.join(planning, 'ROADMAP.md')) ||
      isFile(path.join(planning, 'active-workstream'))
    ) {
      return dir;
    }
    if (dir === home) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function resolveWorkstream(
  rootPlanning: string,
  env: NodeJS.ProcessEnv,
): { dir: string; name: string | null } {
  const fromFile = readText(path.join(rootPlanning, 'active-workstream'))?.split('\n')[0]?.trim();
  const candidates = [env.GSD_WORKSTREAM?.trim(), fromFile];
  for (const name of candidates) {
    if (!name || !WORKSTREAM_RE.test(name) || name === '.' || name === '..') continue;
    const dir = path.join(rootPlanning, 'workstreams', name);
    if (isDir(dir)) return { dir, name };
  }
  return { dir: rootPlanning, name: null };
}

function readUpdate(env: NodeJS.ProcessEnv): GsdUpdate | null {
  const files = [
    path.join(os.homedir(), '.cache', 'gsd', 'gsd-update-check.json'),
    path.join(claudeDir(env), 'cache', 'gsd-update-check.json'),
  ];
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
      return {
        available: j.update_available === true,
        staleHooks: Array.isArray(j.stale_hooks) && j.stale_hooks.length > 0,
        installed: str(j.installed),
        latest: str(j.latest),
      };
    } catch {
      return null;
    }
  }
  return null;
}

function buildInfo(cwd: string, env: NodeJS.ProcessEnv): GsdInfo | null {
  const projectDir = findProject(cwd);
  if (!projectDir) return null;
  const rootPlanning = path.join(projectDir, '.planning');
  const ws = resolveWorkstream(rootPlanning, env);
  const planningDir = ws.dir;

  const stateText = readText(path.join(planningDir, 'STATE.md')) ?? '';
  const { front, body } = splitFrontmatter(stateText);
  const fm = front ? parseFrontmatter(front) : {};

  const roadmapText = readText(path.join(planningDir, 'ROADMAP.md')) ?? '';
  const roadmap = parseRoadmap(roadmapText);
  const roadmapPhases = roadmap.current.length > 0 ? roadmap.current : roadmap.shipped;
  const disk = scanPhases(planningDir);

  const numbers = new Set<string>();
  const phaseList: GsdPhase[] = [];
  const source = roadmapPhases.length > 0 ? roadmapPhases.map((p) => p.number) : disk.map((d) => d.number);
  for (const n of source) numbers.add(n);
  for (const n of [...numbers].sort(comparePhaseNumbers)) {
    const r = roadmapPhases.find((p) => p.number === n);
    const d = disk.find((x) => x.number === n);
    const plans = d?.plans ?? 0;
    const summaries = d?.summaries ?? 0;
    const name = r?.name || d?.slug || null;
    phaseList.push({
      number: n,
      name,
      dir: d?.dir ?? null,
      plans,
      summaries,
      complete: r?.done === true || (plans > 0 && summaries >= plans),
    });
  }

  const bodyPhase = /^\s*(\d+(?:\.\d+)*)\s+of\s+(\d+)(?:\s*\((.*)\))?/.exec(bodyField(body, 'Phase') ?? '');
  const activePhase = fmString(fm, 'active_phase')
    ? normalizePhaseNumber(fmString(fm, 'active_phase')!)
    : bodyPhase
      ? normalizePhaseNumber(bodyPhase[1]!)
      : ((phaseList.find((p) => !p.complete) ?? phaseList[phaseList.length - 1])?.number ?? null);

  let phase: GsdPhase | null = null;
  let phaseIndex: number | null = null;
  if (activePhase) {
    const idx = phaseList.findIndex((p) => p.number === activePhase);
    if (idx >= 0) {
      phase = { ...phaseList[idx]! };
      phaseIndex = idx + 1;
      if (!phase.name && bodyPhase?.[3]) phase.name = bodyPhase[3].trim();
    } else {
      phase = {
        number: activePhase,
        name: bodyPhase?.[3]?.trim() || null,
        dir: null,
        plans: 0,
        summaries: 0,
        complete: false,
      };
      phaseIndex = bodyPhase ? Number.parseInt(bodyPhase[1]!, 10) || null : null;
    }
  }

  const phasesTotal =
    phaseList.length > 0
      ? phaseList.length
      : (fmNumber(fm, 'progress.total_phases') ?? (bodyPhase ? Number(bodyPhase[2]) : 0));
  let phasesCompleted =
    phaseList.length > 0
      ? phaseList.filter((p) => p.complete).length
      : (fmNumber(fm, 'progress.completed_phases') ?? 0);
  let plansTotal = phaseList.reduce((n, p) => n + p.plans, 0);
  let plansCompleted = phaseList.reduce((n, p) => n + Math.min(p.summaries, p.plans), 0);
  if (plansTotal === 0) {
    plansTotal = fmNumber(fm, 'progress.total_plans') ?? 0;
    plansCompleted = Math.min(fmNumber(fm, 'progress.completed_plans') ?? 0, plansTotal);
  }
  phasesCompleted = Math.min(phasesCompleted, phasesTotal);

  let percent: number | null = null;
  const ratios: number[] = [];
  if (plansTotal > 0) ratios.push(plansCompleted / plansTotal);
  if (phasesTotal > 0) ratios.push(phasesCompleted / phasesTotal);
  if (ratios.length > 0) percent = Math.round(Math.min(...ratios) * 100);
  else percent = fmNumber(fm, 'progress.percent');
  if (percent !== null) percent = Math.max(0, Math.min(100, percent));

  const statusText = bodyField(body, 'Status');
  const status = normalizeStatus(fmString(fm, 'status')) ?? normalizeStatus(statusText);

  const bodyMilestone = /Milestone\s+(v?\d[\w.]*)/i.exec(body)?.[1] ?? null;
  const milestone = fmString(fm, 'milestone') ?? bodyMilestone ?? roadmap.milestone;
  const rawName = fmString(fm, 'milestone_name');
  const milestoneName =
    rawName && rawName.toLowerCase() !== 'milestone' ? rawName : rawName ? null : roadmap.name;

  const reqText =
    readText(path.join(planningDir, 'REQUIREMENTS.md')) ??
    (ws.name ? readText(path.join(rootPlanning, 'REQUIREMENTS.md')) : null);
  const req = reqText ? countRequirements(reqText) : { done: 0, total: 0 };

  const lastRaw = fmString(fm, 'last_activity') ?? bodyField(body, 'Last activity');
  const lastActivity = lastRaw ? (/\d{4}-\d{2}-\d{2}/.exec(lastRaw)?.[0] ?? lastRaw) : null;

  return {
    planningDir,
    projectDir,
    workstream: ws.name,
    milestone,
    milestoneName,
    status,
    statusText: statusText ?? fmString(fm, 'status'),
    activePhase,
    phase,
    phaseIndex,
    phasesCompleted,
    phasesTotal,
    plansCompleted,
    plansTotal,
    percent,
    nextAction: fmString(fm, 'next_action'),
    nextPhases: fmList(fm, 'next_phases'),
    blockers: bullets(bodySection(body, /^Blockers/i)),
    pendingTodos: bullets(bodySection(body, /^Pending Todos/i)).length,
    requirementsDone: req.done,
    requirementsTotal: req.total,
    lastActivity,
    stoppedAt: fmString(fm, 'stopped_at') ?? bodyField(body, 'Stopped at'),
    update: readUpdate(env),
  };
}

export function readGsd(cwd: string, env: NodeJS.ProcessEnv = process.env): GsdInfo | null {
  try {
    return buildInfo(cwd, env);
  } catch {
    return null;
  }
}
