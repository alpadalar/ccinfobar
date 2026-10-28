// an in-place update can swap chunks mid-import
export function retryOnce<T>(
  load: () => Promise<T>,
  delayMs = 200,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  return load().catch(() => sleep(delayMs).then(load));
}
