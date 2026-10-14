import type { StdinText } from './hook.js';

// windows only: the stream handles every pipe kind
export function readStdinStream(
  stream: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  capBytes = 1_048_576,
  deadlineMs = 1000,
): Promise<StdinText | null> {
  if (stream.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let done = false;
    let tail: Buffer | null = null;
    const keepTail = (b: Buffer) => {
      const all = tail ? Buffer.concat([tail, b]) : b;
      tail = Buffer.from(all.subarray(Math.max(0, all.length - 65_536)));
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(tail ? { text, overflow, tail: tail.toString('utf8') } : { text, overflow });
    };
    const timer = setTimeout(finish, deadlineMs);
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (overflow) return keepTail(buf);
      if (size + buf.length > capBytes) {
        overflow = true;
        chunks.push(buf.subarray(0, capBytes - size));
        keepTail(buf.subarray(capBytes - size));
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
