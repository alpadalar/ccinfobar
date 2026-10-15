import fs from 'node:fs';

// preloaded through NODE_OPTIONS: no request leaves the machine
const i = process.argv.indexOf('worker');
if (i >= 0 && process.env.CCIB_STUB_LOG) {
  fs.appendFileSync(process.env.CCIB_STUB_LOG, `${process.argv.slice(i + 1).join(' ')}\n`);
}

globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\b/.test(url)) {
    return new Response(null, {
      status: 302,
      headers: { location: 'https://github.com/alpadalar/ccinfobar/releases/tag/v0.0.1' },
    });
  }
  throw new TypeError(`blocked: ${url}`);
};
