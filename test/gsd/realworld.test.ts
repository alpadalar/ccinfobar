import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeStatus, readGsd } from '../../src/data/gsd.js';

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-gsd-rw-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, '.planning', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

const env = { HOME: os.tmpdir(), USERPROFILE: os.tmpdir() } as NodeJS.ProcessEnv;

describe('real world GSD layouts', () => {
  it('reads a bare Phase line and trusts a higher frontmatter phase count', () => {
    const roadmap = Array.from({ length: 4 }, (_, i) => `- [ ] **Phase ${i + 1}: P${i + 1}** - x`).join('\n');
    const dir = project({
      'STATE.md':
        '---\nstatus: verifying\nprogress:\n  total_phases: 4\n  completed_phases: 4\n---\nPhase: 4\nStatus: Phase complete\n',
      'ROADMAP.md': `## Phases\n${roadmap}\n`,
      'phases/04-p4/04-01-PLAN.md': '',
      'phases/04-p4/04-01-SUMMARY.md': '',
    });
    const info = readGsd(dir, env)!;
    expect(info.phase?.number).toBe('4');
    expect(info.phasesCompleted).toBe(4);
    expect(info.percent).toBe(100);
  });

  it('limits phases to the in-progress milestone range', () => {
    const phases = Array.from(
      { length: 12 },
      (_, i) => `- [${i < 8 ? 'x' : ' '}] **Phase ${i + 1}: P${i + 1}**`,
    ).join('\n');
    const dir = project({
      'STATE.md': 'Phase: 10 (P10)\nStatus: In progress\n',
      'ROADMAP.md': `## Milestones\n- ✅ **v1.0 One** -- Phases 1-8 (shipped 2026-01-01)\n- [ ] **v1.1 Two** -- Phases 9-12 (in progress)\n## Phases\n${phases}\n`,
    });
    const info = readGsd(dir, env)!;
    expect(info.phasesTotal).toBe(4);
    expect(info.phaseIndex).toBe(2);
    expect(info.phase?.number).toBe('10');
  });

  it('drops shipped ranges when no current range is marked', () => {
    const phases = Array.from(
      { length: 6 },
      (_, i) => `- [${i < 3 ? 'x' : ' '}] **Phase ${i + 1}: P${i + 1}**`,
    ).join('\n');
    const dir = project({
      'STATE.md': 'Status: Planning\n',
      'ROADMAP.md': `- ✅ **v1.0 One** -- Phases 1-3 (shipped)\n${phases}\n`,
    });
    expect(readGsd(dir, env)!.phasesTotal).toBe(3);
  });

  it('counts only open top-level blockers', () => {
    const dir = project({
      'STATE.md': [
        'Phase: 1 of 1 (A)',
        '### Blockers/Concerns',
        '- Real open concern',
        '- ~~Old one~~ — closed later',
        '- ✅ Fixed item',
        '- [x] Ticked item',
        '- Issue X RESOLVED in phase 3',
        '  - nested detail',
        '- Another open one',
        '### Next',
      ].join('\n'),
      'ROADMAP.md': '- [ ] **Phase 1: A**\n',
    });
    expect(readGsd(dir, env)!.blockers).toEqual(['Real open concern', 'Another open one']);
  });

  it('treats waiting for the next milestone as complete', () => {
    expect(normalizeStatus('Awaiting next milestone')).toBe('complete');
    expect(normalizeStatus('Ready to plan next milestone')).toBe('complete');
    expect(normalizeStatus('phases_complete_milestone_open')).toBe('complete');
    expect(normalizeStatus('Ready to plan')).toBe('ready-to-plan');
  });
});
