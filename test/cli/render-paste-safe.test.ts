import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runRender } from '../../src/cli/render.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// WR-05: Claude Code trims plain spaces, so the live line keeps NBSP in every mode
describe('live line spacing', () => {
  it.each(['normal', 'paste-safe', 'single-width'])('%s keeps non-breaking spaces', async (glyphMode) => {
    const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'render-paste-'));
    const file = path.join(dir, 'p.json');
    fs.writeFileSync(file, JSON.stringify({ session_id: 'paste', model: { display_name: 'Opus 5' } }));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfg,
      JSON.stringify({ glyphMode, align: 'right', maxWidth: 40, lines: [[{ id: 'm', type: 'model' }]] }),
    );
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out += String(s);
      return true;
    });
    await runRender(parseArgs(['--payload', file]), cfg);
    vi.restoreAllMocks();
    expect(out).toContain(' ');
    expect(out.replace(/\u001b\[[0-9;]*m/g, '')).not.toContain(' ');
  });
});
