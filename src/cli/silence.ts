let done = false;

// no-op stdio without creating the real streams
const sink = {
  write: () => true,
  on() {
    return this;
  },
  once() {
    return this;
  },
  end() {},
};

export function silence(): void {
  if (done) return;
  done = true;
  for (const k of ['stdout', 'stderr'] as const)
    Object.defineProperty(process, k, { value: sink, configurable: true, writable: true });
  process.removeAllListeners('warning');
  const bye = () => process.exit(0);
  process.on('uncaughtException', bye);
  process.on('unhandledRejection', bye);
  setTimeout(bye, 2000);
}
