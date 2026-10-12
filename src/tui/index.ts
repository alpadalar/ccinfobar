export interface TuiOptions {
  configPath: string;
}

export async function runTui(_opts: TuiOptions): Promise<void> {
  throw new Error('TUI is not implemented yet');
}
