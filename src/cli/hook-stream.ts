// windows only: the stream handles every pipe kind
export function readStdinStream(
  stream: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  capBytes = 1_048_576,
  deadlineMs = 1000,
): Promise<{ text: string; overflow: boolean } | null> {
  if (stream.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ text: Buffer.concat(chunks).toString('utf8'), overflow });
    };
    const timer = setTimeout(finish, deadlineMs);
    stream.on('data', (chunk: Buffer | string) => {
      if (overflow) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (size + buf.length > capBytes) {
        overflow = true;
        chunks.push(buf.subarray(0, capBytes - size));
        size = capBytes;
        return;
      }
      chunks.push(buf);
      size += buf.length;
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}
