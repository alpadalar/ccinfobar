export interface TerminalColors {
  bg: string;
  fg: string | null;
  palette: (string | null)[] | null;
}

const OSC_RE =
  /\x1b\](\d+)(?:;(\d+))?;rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\/[0-9a-f]+)?(?:\x07|\x1b\\)/gi;
const DA1_RE = /\x1b\[\?[0-9;]*c/;

function channel(hex: string): string {
  const max = 16 ** hex.length - 1;
  return Math.round((Number.parseInt(hex, 16) / max) * 255)
    .toString(16)
    .padStart(2, '0');
}

export function parseColorReplies(data: string): TerminalColors | null {
  let bg: string | null = null;
  let fg: string | null = null;
  const palette: (string | null)[] = Array(16).fill(null);
  let any = false;
  for (const m of data.matchAll(OSC_RE)) {
    const color = `#${channel(m[3]!)}${channel(m[4]!)}${channel(m[5]!)}`;
    if (m[1] === '11') bg = color;
    else if (m[1] === '10') fg = color;
    else if (m[1] === '4' && m[2] !== undefined) {
      const i = Number(m[2]);
      if (i >= 0 && i < 16) {
        palette[i] = color;
        any = true;
      }
    }
  }
  if (!bg) return null;
  return { bg, fg, palette: any ? palette : null };
}

export function queryTerminalColors(timeoutMs = 400): Promise<TerminalColors | null> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY || process.env.CCINFOBAR_NO_DETECT) return Promise.resolve(null);
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const wasRaw = stdin.isRaw;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {}
      stdin.pause();
      resolve(parseColorReplies(data));
    };
    const onData = (chunk: Buffer | string) => {
      data += chunk.toString();
      if (DA1_RE.test(data)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      stdin.setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
      let query = '\x1b]11;?\x07\x1b]10;?\x07';
      for (let i = 0; i < 16; i++) query += `\x1b]4;${i};?\x07`;
      stdout.write(`${query}\x1b[c`);
    } catch {
      finish();
    }
  });
}
