export type StatusIndicator = 'none' | 'minor' | 'major' | 'critical' | 'maintenance';

export interface StatusIncident {
  name: string;
  impact: StatusIndicator;
  components: string[];
  updatedAt: string | null;
}

export interface StatusValue {
  indicator: StatusIndicator;
  description: string;
  incidents: StatusIncident[];
}

export type HttpPathResult =
  | { ok: true; v: string | number | boolean | null }
  | { ok: false; code: 'path-miss' | 'not-scalar' | 'bad-path' };

export interface HttpValue {
  paths: Record<string, HttpPathResult>;
  // sample and scenario readers only
  any?: HttpPathResult;
}

export interface GhValue {
  pass: number;
  fail: number;
  pending: number;
  skipped: number;
  cancelled: number;
  total: number;
  names: string[];
}

export interface ReposDirtyValue {
  dirty: Record<string, boolean>;
}
