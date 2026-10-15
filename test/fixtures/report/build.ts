import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished } from 'vitest';

type Ts = number | string;

const iso = (ts: Ts) => (typeof ts === 'number' ? new Date(ts).toISOString() : ts);
const claudeRoot = () => process.env.CLAUDE_CONFIG_DIR!;
const cacheRoot = () => process.env.CCINFOBAR_CACHE_DIR!;
let uuid = 0;

export interface AssistantOpts {
  id?: string;
  requestId?: string;
  model?: string;
  ts?: Ts;
  in?: number;
  out?: number;
  cr?: number;
  cw?: number;
  w5?: number;
  w1?: number;
  costUSD?: number;
  speed?: string;
  sidechain?: boolean;
  cwd?: string;
}

export function assistantLine(o: AssistantOpts = {}): string {
  const usage: Record<string, unknown> = {
    input_tokens: o.in ?? 0,
    cache_creation_input_tokens: o.cw ?? 0,
    cache_read_input_tokens: o.cr ?? 0,
    output_tokens: o.out ?? 0,
  };
  if (o.w5 !== undefined || o.w1 !== undefined) {
    usage.cache_creation = { ephemeral_5m_input_tokens: o.w5 ?? 0, ephemeral_1h_input_tokens: o.w1 ?? 0 };
  }
  if (o.speed !== undefined) usage.speed = o.speed;
  return JSON.stringify({
    parentUuid: null,
    isSidechain: o.sidechain ?? false,
    cwd: o.cwd,
    sessionId: 'fixture',
    type: 'assistant',
    message: {
      id: o.id,
      type: 'message',
      role: 'assistant',
      model: o.model ?? 'claude-opus-4-5',
      content: [{ type: 'text', text: `PROMPT_MARKER_reply_${++uuid}` }],
      usage,
    },
    requestId: o.requestId,
    uuid: `a-${uuid}`,
    timestamp: o.ts === undefined ? undefined : iso(o.ts),
    costUSD: o.costUSD,
  });
}

export interface UserOpts {
  ts?: Ts;
  text?: string;
  toolUseResultUsage?: Record<string, number>;
  cwd?: string;
  sidechain?: boolean;
}

export function userLine(o: UserOpts = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: o.sidechain ?? false,
    cwd: o.cwd,
    sessionId: 'fixture',
    type: 'user',
    message: { role: 'user', content: o.text ?? `PROMPT_MARKER_${++uuid}` },
    toolUseResult: o.toolUseResultUsage ? { usage: o.toolUseResultUsage } : undefined,
    uuid: `u-${++uuid}`,
    timestamp: o.ts === undefined ? undefined : iso(o.ts),
  });
}

export function metaLine(ts: Ts): string {
  return JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1, timestamp: iso(ts) });
}

const text = (lines: string[]) => lines.map((l) => `${l}\n`).join('');

export function writeTranscript(rel: string, lines: string[], root = claudeRoot()): string {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text(lines));
  return file;
}

export function appendTranscript(rel: string, lines: string[], root = claudeRoot()): string {
  const file = path.join(root, ...rel.split('/'));
  fs.appendFileSync(file, text(lines));
  return file;
}

export interface LedgerOpts {
  t: number;
  a: string;
  s: string;
  p: string;
  c: number;
}

export function ledgerLine(o: LedgerOpts): string {
  return JSON.stringify({ v: 1, t: o.t, a: o.a, s: o.s, p: o.p, tp: '', c: o.c });
}

export function writeLedger(month: string, lines: string[], root = cacheRoot()): string {
  const dir = path.join(root, 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${month}.jsonl`);
  fs.writeFileSync(file, text(lines));
  return file;
}

// fresh dir under the temp claude dir, removed after the test
export function scratch(name: string): string {
  const base = claudeRoot();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${name}-`));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
