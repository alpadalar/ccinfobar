import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';

describe('parseArgs', () => {
  it('reads --yes, -y and --dry-run', () => {
    expect(parseArgs(['install', '--yes']).flags.yes).toBe(true);
    expect(parseArgs(['install', '-y']).flags.yes).toBe(true);
    expect(parseArgs(['install', '--dry-run']).flags['dry-run']).toBe(true);
  });

  it('treats every token after -- as a positional', () => {
    expect(parseArgs(['config', 'set', 'a.b', '--', '-1']).positional).toEqual(['set', 'a.b', '-1']);
    const a = parseArgs(['config', '--', '--yes', '-y', '-h']);
    expect(a.positional).toEqual(['--yes', '-y', '-h']);
    expect(a.flags).toEqual({});
  });

  it('keeps negative numbers as positionals', () => {
    const a = parseArgs(['config', 'set', 'padding', '-1']);
    expect(a.positional.at(-1)).toBe('-1');
    expect(a.flags).toEqual({});
  });

  it('keeps the existing flags', () => {
    const a = parseArgs(['--config', 'x', '--payload', 'f', '--width', '80', 'install', '--no-global']);
    expect(a.command).toBe('install');
    expect(a.flags).toEqual({ config: 'x', payload: 'f', width: '80', global: false });
    expect(parseArgs(['-h']).flags.help).toBe(true);
    expect(parseArgs(['-v']).flags.version).toBe(true);
    expect(parseArgs(['--width=90']).flags.width).toBe('90');
  });

  it('keeps --project a switch before another flag', () => {
    const a = parseArgs(['install', '--project', '--hooks']);
    expect(a.flags).toEqual({ project: true, hooks: true });
  });

  it('takes values for the report flags', () => {
    const a = parseArgs(['report', '--project', 'api', '--since', '7d', '--until', '2026-10-02']);
    expect(a.flags).toEqual({ project: 'api', since: '7d', until: '2026-10-02' });
    const b = parseArgs(['report', '--period', 'week', '--format', 'csv', '--all']);
    expect(b.flags).toEqual({ period: 'week', format: 'csv', all: true });
  });

  it('keeps every = after the first in an inline value', () => {
    expect(parseArgs(['--command=FOO=1 ccinfobar']).flags.command).toBe('FOO=1 ccinfobar');
    expect(parseArgs(['--payload=']).flags.payload).toBe('');
  });

  it('takes a value for --glyph-mode', () => {
    const a = parseArgs(['preview', '--glyph-mode', 'paste-safe']);
    expect(a.flags['glyph-mode']).toBe('paste-safe');
    expect(a.positional).toEqual([]);
    expect(parseArgs(['preview', '--glyph-mode']).flags['glyph-mode']).toBe(true);
  });

  it('takes values for --scenario and --runs', () => {
    expect(parseArgs(['preview', '--scenario', 'context-full']).flags.scenario).toBe('context-full');
    expect(parseArgs(['bench', '--runs', '20']).flags.runs).toBe('20');
    expect(parseArgs(['preview', '--scenario']).flags.scenario).toBe(true);
    const a = parseArgs(['preview', '--scenario', '--width', '80']);
    expect(a.flags.scenario).toBe(true);
    expect(a.flags.width).toBe('80');
  });
});
