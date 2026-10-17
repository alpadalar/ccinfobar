import { text } from './http.js';

const REPO = 'https://github.com/alpadalar/ccinfobar';

const HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

// static: no entry data, no scripts
export function landingHtml(name: string): string {
  const n = esc(name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${n}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#222;background:#fff}a{color:#0b57d0}@media (prefers-color-scheme:dark){body{color:#ddd;background:#111}a{color:#8ab4f8}}</style>
</head>
<body>
<h1>${n}</h1>
<p>A free, open source and non-commercial marketplace for presets and themes of <a href="${REPO}">ccinfobar</a>, a status line for Claude Code. Browse, install and publish from <code>ccinfobar edit</code> or the <code>ccinfobar catalog</code> commands.</p>
<p>Everything published here is public: anyone can read, download and install it.</p>
<p>To ask for an entry to be removed, open an issue at <a href="${REPO}/issues">github.com/alpadalar/ccinfobar/issues</a>.</p>
<p>How it works: <a href="${REPO}/blob/main/docs/MARKETPLACE.md">docs/MARKETPLACE.md</a>. Server details: <a href="/v1/meta.json">/v1/meta.json</a>.</p>
</body>
</html>
`;
}

export function landingPage(name: string): Response {
  return text(200, landingHtml(name), 'text/html; charset=utf-8', HEADERS);
}
