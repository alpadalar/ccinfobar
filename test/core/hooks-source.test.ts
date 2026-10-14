import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadInspectInput } from '../../src/commands/explain.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { createTrace } from '../../src/core/trace.js';

let dir: string;
let env: NodeJS.ProcessEnv;
const SID = 'sess-hooks';
const hooksDir = () => path.join(dir, 'cache', 'hooks');
const foldFile = () => path.join(hooksDir(), `${SID}.fold.json`);
const writeLog = () => {
  fs.mkdirSync(hooksDir(), { recursive: true });
  const line = { v: 1, t: Date.now() - 134_000, e: 'UserPromptSubmit', p: 'p1' };
  fs.writeFileSync(path.join(hooksDir(), `${SID}.jsonl`), `${JSON.stringify(line)}\n`);
};
const ctxFor = (session_id: string | undefined, preview = false) =>
  createContext({
    payload: session_id ? { session_id } : {},
    config: defaultConfig(),
    env,
    preview,
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-hsrc-'));
  env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'), CCINFOBAR_CONFIG_DIR: path.join(dir, 'config') };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ctx.data.hooks', () => {
  it('is null without a log, a session id or with an invalid id', () => {
    expect(ctxFor(SID).data.hooks?.()).toBeNull();
    expect(ctxFor(undefined).data.hooks?.()).toBeNull();
    writeLog();
    expect(ctxFor('../evil').data.hooks?.()).toBeNull();
  });

  it('reads the hook turn and caches the fold on a real render', () => {
    writeLog();
    expect(ctxFor(SID).data.hooks?.()?.turn?.promptId).toBe('p1');
    expect(fs.existsSync(foldFile())).toBe(true);
  });

  it('never writes the fold cache in preview', () => {
    writeLog();
    expect(ctxFor(SID, true).data.hooks?.()?.turn?.promptId).toBe('p1');
    expect(fs.existsSync(foldFile())).toBe(false);
  });

  it('is traced as hooks', () => {
    const trace = createTrace();
    const ctx = trace.wrap(
      createContext({ payload: {}, config: defaultConfig(), env, data: { hooks: () => null } }),
    );
    trace.begin();
    ctx.data.hooks?.();
    expect(trace.end()).toEqual([{ kind: 'hooks' }]);
  });

  it('explain reads hook state without writing the fold cache', () => {
    writeLog();
    const file = path.join(dir, 'payload.json');
    fs.writeFileSync(file, JSON.stringify({ session_id: SID }));
    const input = loadInspectInput({
      cfgFile: path.join(dir, 'config', 'config.json'),
      payloadFile: file,
      fallback: 'none',
      env,
    })!;
    expect(input.ctx.data.hooks?.()?.turn?.promptId).toBe('p1');
    input.cleanup();
    expect(fs.existsSync(foldFile())).toBe(false);
  });
});
