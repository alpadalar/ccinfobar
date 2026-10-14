export interface RateWindow {
  used_percentage?: number | null;
  resets_at?: number | string | null;
}

export interface ModelWindow extends RateWindow {
  model: string;
}

export interface SpendLimit extends RateWindow {
  used_usd?: number | null;
  limit_usd?: number | null;
  period?: string | null;
}

export interface MissCause {
  causes: string[];
  tools_added?: number;
  tools_removed?: number;
  system_char_delta?: number;
}

export interface StatusPayload {
  hook_event_name?: string;
  session_id?: string;
  session_name?: string;
  prompt_id?: string;
  transcript_path?: string;
  version?: string;
  cwd?: string;
  output_style?: { name?: string };
  model?: { id?: string; display_name?: string };
  effort?: { level?: string };
  thinking?: { enabled?: boolean };
  fast_mode?: boolean;
  workspace?: {
    current_dir?: string;
    project_dir?: string;
    added_dirs?: string[];
    git_worktree?: string;
    repo?: { host?: string; owner?: string; name?: string };
  };
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: {
    context_window_size?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };
  exceeds_200k_tokens?: boolean;
  prompt_cache?: {
    warm?: boolean;
    caching_observed?: boolean;
    ttl?: string;
    expires_at?: number | string;
    requests?: number;
    misses?: number;
    expected_rebuilds?: number;
    hit_ratio?: number;
    cache_write_tokens?: number;
    miss_recache_tokens?: number;
    last_miss_at?: number | string;
    last_miss_cause?: MissCause | string | null;
    miss_causes?: Record<string, number>;
    recache_tokens_if_cold?: number;
  };
  rate_limits?: {
    five_hour?: RateWindow;
    seven_day?: RateWindow;
    seven_day_sonnet?: RateWindow;
    seven_day_opus?: RateWindow;
    seven_day_models?: ModelWindow[];
    spend_limit?: SpendLimit;
  };
  pr?: { number?: number; url?: string; review_state?: string; kind?: string };
  vim?: { mode?: string };
  agent?: { name?: string };
  worktree?: {
    name?: string;
    path?: string;
    branch?: string;
    original_cwd?: string;
    original_branch?: string;
  };
  terminal_width?: number;
  columns?: number;
}

export type OptionValue = string | number | boolean;

export interface WidgetItem {
  id: string;
  type: string;
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  label?: string;
  raw?: boolean;
  merge?: boolean;
  hideEmpty?: boolean;
  options?: Record<string, OptionValue>;
}

export type ColorLevel = 'auto' | 0 | 1 | 2 | 3;
export type IconMode = 'nerd' | 'emoji' | 'text' | 'none';

export type ThemeStyle = 'text' | 'blocks' | 'powerline' | 'capsule' | 'tui';
export type Charset = 'auto' | 'nerd' | 'unicode' | 'text';

export interface BoxChars {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  teeLeft: string;
  teeRight: string;
}

export interface TuiBreakpoint {
  minWidth: number;
  areas: string[];
  columns?: string[];
  align?: ('left' | 'center' | 'right')[];
}

export interface TuiTemplate {
  items: string[];
  gap?: number;
  justify?: 'start' | 'between';
}

export interface TuiConfig {
  box?: string | Partial<BoxChars>;
  fitContent?: boolean;
  minWidth?: number;
  maxWidth?: number;
  padding?: number;
  columnGap?: string;
  divider?: string;
  dividers?: boolean;
  title?: { left?: string; right?: string | false };
  borderColor?: string;
  footer?: { left?: string; right?: string };
  templates?: Record<string, TuiTemplate>;
  breakpoints?: TuiBreakpoint[];
}

export interface GlyphOverrides {
  separator?: string;
  thin?: string;
  startCap?: string;
  endCap?: string;
}

export type Align = 'left' | 'center' | 'right';

export interface Config {
  $schema?: string;
  version: 1;
  lines: WidgetItem[][];
  align?: Align;
  lineAlign?: (Align | null)[];
  theme: string;
  style?: ThemeStyle;
  separator?: string;
  separatorColor?: string;
  padding?: number;
  glyphs?: GlyphOverrides;
  charset: Charset;
  autoWrap: boolean;
  update: 'notify' | 'auto' | 'off';
  usageApi: boolean;
  gsdAutoLine?: boolean;
  gitHardening?: boolean;
  loadingText?: string;
  tui?: TuiConfig;
  colorLevel: ColorLevel;
  icons: IconMode;
  maxWidth: 'auto' | number;
  widthOffset: number;
  savePayload: boolean;
}

export type WidgetCategory =
  | 'session'
  | 'context'
  | 'tokens'
  | 'cost'
  | 'limits'
  | 'charts'
  | 'agents'
  | 'git'
  | 'workspace'
  | 'gsd'
  | 'system'
  | 'custom'
  | 'layout';

export interface OptionChoice {
  value: string;
  label: string;
}

export interface OptionSpec {
  key: string;
  label: string;
  kind: 'boolean' | 'select' | 'text' | 'number';
  default: OptionValue;
  choices?: OptionChoice[];
  help?: string;
}

export interface WidgetOutput {
  text: string;
  color?: string;
  background?: string;
}

export type WidgetResult = string | WidgetOutput | null | undefined;

export interface WidgetDef {
  type: string;
  name: string;
  category: WidgetCategory;
  description: string;
  label?: string;
  icon?: { nerd?: string; emoji?: string; text?: string };
  color: string;
  options?: OptionSpec[];
  sample?: string;
  hidden?: boolean;
  fill?: boolean;
  render(ctx: RenderContext, item: WidgetItem): WidgetResult;
}

export interface RenderContext {
  payload: StatusPayload;
  config: Config;
  cwd: string;
  env: NodeJS.ProcessEnv;
  now: Date;
  preview: boolean;
  terminalWidth: number | null;
  theme?: import('./themes.js').Theme;
  data: DataSources;
  extra?: number;
}

export interface DataSources {
  git(): import('../data/git.js').GitInfo | null;
  transcript(): import('../data/transcript.js').TranscriptInfo | null;
  gsd(): import('../data/gsd.js').GsdInfo | null;
  history?(): import('../data/history.js').HistorySample[];
  agents(): import('../data/agents.js').AgentInfo[];
}
