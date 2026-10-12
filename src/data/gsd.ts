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

export function readGsd(_cwd: string): GsdInfo | null {
  return null;
}
