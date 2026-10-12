export interface EditorOptions {
  configPath: string;
  port?: number;
  open?: boolean;
}

export async function startEditor(_opts: EditorOptions): Promise<void> {
  throw new Error('Web editor is not implemented yet');
}
