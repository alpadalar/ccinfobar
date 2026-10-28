import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasReplies as doctorHasReplies } from '../../src/commands/doctor.js';
import { lastPayloadPath } from '../../src/core/paths.js';
import { hasReplies, ingestPayload } from '../../src/core/payload.js';
import { readLastPayload } from '../../src/core/preview.js';

const HOSTILE = {
  session_name: 'a‮b\nc',
  cwd: '/x\u001b]0;t\u0007y',
  workspace: { current_dir: '/w\u009b31m', added_dirs: ['/a\u001b[2J', '/b\r'] },
  model: { id: 'm', display_name: 'M\u001b[31m' },
  transcript_path: '/t/\u001b.jsonl',
  cost: { total_cost_usd: 1.5 },
  exceeds_200k_tokens: true,
};

describe('ingestPayload', () => {
  it('treats empty input as an empty payload', () => {
    expect(ingestPayload('')).toEqual({});
    expect(ingestPayload('   ')).toEqual({});
  });

  it('returns null for invalid JSON or a non-object root', () => {
    expect(ingestPayload('{bad')).toBeNull();
    expect(ingestPayload('5')).toBeNull();
    expect(ingestPayload('[1]')).toBeNull();
    expect(ingestPayload('null')).toBeNull();
    expect(ingestPayload('"s"')).toBeNull();
  });

  it('sanitizes every string except transcript_path', () => {
    const p = ingestPayload(JSON.stringify(HOSTILE));
    expect(p?.session_name).toBe('ab c');
    expect(p?.cwd).toBe('/xy');
    expect(p?.workspace?.current_dir).toBe('/w');
    expect(p?.model?.display_name).toBe('M');
    expect(p?.transcript_path).toBe('/t/\u001b.jsonl');
  });

  it('keeps numbers and booleans and sanitizes nested string arrays', () => {
    const p = ingestPayload(JSON.stringify(HOSTILE)) as unknown as typeof HOSTILE;
    expect(p.cost.total_cost_usd).toBe(1.5);
    expect(p.exceeds_200k_tokens).toBe(true);
    expect(p.workspace.added_dirs).toEqual(['/a', '/b ']);
  });
});

describe('hasReplies', () => {
  it('is the same function from core/payload and commands/doctor', () => {
    expect(doctorHasReplies).toBe(hasReplies);
    expect(hasReplies({ cost: { total_cost_usd: 0.1 } } as never)).toBe(true);
    expect(hasReplies({})).toBe(false);
  });
});

describe('readLastPayload', () => {
  it('returns the sanitized cached payload', () => {
    const file = lastPayloadPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(HOSTILE));
    try {
      const p = readLastPayload();
      expect(p?.session_name).toBe('ab c');
      expect(p?.cwd).toBe('/xy');
      expect(p?.transcript_path).toBe('/t/\u001b.jsonl');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('returns null for a tampered non-object cache', () => {
    const file = lastPayloadPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[1]');
    try {
      expect(readLastPayload()).toBeNull();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('ingestPayload depth', () => {
  it('returns null for a payload nested past 64 levels', () => {
    const deep = '['.repeat(65) + ']'.repeat(65);
    expect(ingestPayload(`{"model":{"display_name":"x"},"deep":${deep}}`)).toBeNull();
    expect(ingestPayload('{"model":{"display_name":"x"}}')).not.toBeNull();
  });
});
