export function noCwdLookup(env: NodeJS.ProcessEnv, platform: string): void {
  if (platform === 'win32') env.NoDefaultCurrentDirectoryInExePath ??= '1';
}
