# Marketplace

This document describes the marketplace protocol that ccinfobar speaks, the client rules, the reference server, and the options for serving a real marketplace. The last part is a decision for the owner.

## Status

- **No marketplace is live.** Nothing is deployed, and no repository, site, Worker, account or domain has been created for one.
- **No endpoint is set by default.** Until you set one (`ccinfobar catalog endpoint <url>` or `CCINFOBAR_MARKETPLACE_URL`), nothing leaves your machine: shared catalog entries wait to publish, and the publish and remote browse commands exit without a network call.
- What exists today: protocol v1 (`src/market/protocol.ts`), the client (`src/market/client.ts`), publish and remote browse in the CLI and the web editor, and a reference server for tests and self-hosting.
- Installing an entry from a marketplace is not available yet; remote browsing is read-only.

For how users save and share entries, see [CATALOG.md](CATALOG.md).

## Protocol v1

Design rule: every **read** is a `GET` on a path that ends in `.json`. A static host (GitHub Pages, an R2 public bucket) can serve the read side unchanged, and search happens on the client over the index pages. **Writes** are optional; a server says in `meta.json` whether it takes them.

All paths are relative to the endpoint, which may have a base path (`https://example.com/catalog` reads `https://example.com/catalog/v1/index.json`).

### Routes

| Op | Method and path | Request body | Success | Errors |
| --- | --- | --- | --- | --- |
| Discover | `GET /v1/meta.json` | | `{ protocol: 1, name, capabilities: { write, overwrite, withdraw, submit }, auth, limits, submitUrl? }` | |
| List | `GET /v1/index.json`, then `GET /v1/index-<n>.json` while `next` is set | | `{ entries: Summary[], generatedAt, next? }` | `404` for a page that does not exist |
| Entry and history | `GET /v1/entries/<publisher>/<slug>.json` | | Summary plus `versions: [{ version, at, note, hash }]` | `400 invalid`, `404 not-found` |
| Version content | `GET /v1/entries/<publisher>/<slug>/<n>.json` | | `{ version, content, hash }` | `400`, `410 withdrawn`, `404` |
| Register | `POST /v1/publishers` | `{ handle, displayName }` | `201 { handle, token }` | `400 invalid`, `409 conflict`, `413 too-large` |
| Publish new | `POST /v1/entries` | `{ kind, slug, name, description, author, content, note }` | `201 { id, version: 1, hash }` | `401`, `400 invalid`, `409 conflict`, `413 too-large` |
| New version | `POST /v1/entries/<publisher>/<slug>/versions` with `If-Match: "<latest version>"` | `{ content, note, name?, description? }` | `201 { id, version, hash }` | `401`, `404`, `403 forbidden`, `410 withdrawn`, `412 stale`, `400 invalid`, `413 too-large` |
| Overwrite latest | `PUT /v1/entries/<publisher>/<slug>/versions/<n>` | `{ content, note, name?, description? }` | `200 { id, version, hash }` | `401`, `403 overwrite-disabled`, `404`, `403 forbidden`, `410`, `409 conflict` (n is not the latest), `400 invalid` |
| Withdraw | `DELETE /v1/entries/<publisher>/<slug>` | | `200 { id, withdrawn: true }` (also when repeated) | `401`, `404`, `403 forbidden` |

Every request can get `429 rate-limited`. Every write can also answer `415 unsupported-media` (the body must be `application/json`) and `413 too-large` (body over 1 MiB). Errors are listed in the order the reference server checks them.

- **Summary**: `{ id, kind, name, description, author, publisher, version, updatedAt, hash, withdrawn? }`. `publisher` must equal the first part of `id`, or the client drops the row.
- **Index pages**: `index.json` holds at most 500 summaries. When there are more, `next` names the next page relative to `v1/` (`index-2.json`, then `index-3.json`), up to `index-10.json` (5000 entries). A page may only link to the page right after it; any other `next` ends the list, and the client stops at 5000 entries. A static host serves the pages as plain files.
- **Withdraw** is soft. The entry file stays as a tombstone with `withdrawn: true` and the version hashes, version content answers `410`, and the id stays reserved: publishing the same slug again gives `409`.
- **Overwrite** is allowed only when `capabilities.overwrite` is true. When a server answers `403 overwrite-disabled`, ccinfobar sends a new version instead.

### Ids and versions

- Ids are `<publisher>/<slug>`. Both parts match `^[a-z0-9][a-z0-9-]{0,38}$`.
- The server assigns the publisher (the handle a token belongs to). `author` is a free display name, so the UI shows both against impersonation.
- Versions are integers from 1. A new version is `latest + 1`; overwrite keeps the number. An entry holds at most 5000 versions.

### Hashes

`hash` is the lowercase hex sha256 of the canonical JSON of `content`: object keys sorted by code unit, no whitespace, `undefined` values dropped. The server hashes the content after sanitizing its text (control characters, escape sequences and bidi marks removed; tabs and newlines become spaces), and ccinfobar sanitizes the same way before it shows, hashes and sends a payload, so the hash it keeps matches the server's. The client recomputes it on every download and refuses a mismatch (`bad-hash`). It also requires the version file's hash to equal the one listed for that version in the entry's history, which it fetches separately, and the entry's own `hash` for the latest version. That catches a swapped, stale or cached version file; a host that rewrites the entry and its version files together can only be caught by comparing with a copy you trust.

### Content and policy

`content` is `{ layout?, appearance?, theme? }`: `layout` holds the preset keys (`lines`, `align`, `lineAlign`, `overflow`, `autoWrap`, `widthOffset`, `tui`), `appearance` the theme keys (`theme`, `style`, `separator`, `separatorColor`, `padding`, `glyphs`) and `theme` an embedded theme file. A preset has only `layout`; a theme has `appearance` and/or `theme`; a bundle has `layout` and `appearance` and may have `theme`.

The marketplace is data-only. Both the client and the server (`contentProblems`) refuse content with:

- `command`, `http` or `env` widgets
- `link` widgets whose URL is not http or https
- personal keys (`budget`, `profiles`, `language`, `charset`, `update` and the rest of `PERSONAL_KEYS` in `src/core/edit.ts`), unknown keys, or theme fields that a theme file does not have
- lines that are not lists of widget objects
- content over 256 KiB of canonical JSON

### Auth

Writes send `Authorization: Bearer <token>`; reads never send a token. On the reference server, `POST /v1/publishers` registers a handle and returns a token once: 32 random bytes as 64 hex characters, stored on the server only as its sha256. Only the publisher of an entry may add versions, overwrite or withdraw it. `meta.json` lists the auth kinds in `auth`; the reference server says `["token"]`. GitHub device flow is planned as a future auth kind and is not implemented.

### Limits

| Limit | Value |
| --- | --- |
| Entry content | 256 KiB (`maxEntryBytes`) |
| Request body | 1 MiB (`maxBodyBytes`) |
| Name, author, display name | 64 characters |
| Description, note | 200 characters |
| Versions per entry | 5000, and the entry document (summary plus history) stays under 320 KiB |
| Index page | 500 summaries |

A server advertises its limits in `meta.json` `limits`.

### Errors

Error bodies are `{ "error": { "code": "<code>", "message": "<text>" } }`. Codes: `invalid`, `too-large`, `conflict`, `stale`, `forbidden`, `not-found`, `withdrawn`, `rate-limited`, `overwrite-disabled`, `unsupported-media`, `unauthorized` (`ERROR_CODES`). The reference server also answers `500 internal`. `429` carries `Retry-After` in seconds. Static hosts answer without a JSON body, so the client maps the status (`404` to `not-found`, `429` to `rate-limited`, and so on). The client keeps only the code; server messages are never shown.

## Client

`src/market/client.ts` is the only code that talks to a marketplace.

- **Endpoint**: https only, except http on `localhost`, `127.0.0.1` and `[::1]` (for the reference server). No user name or password, query or fragment.
- **Bounds**: one 10 s timeout covers all hops and the body. Responses are capped per document (`RESPONSE_CAPS`, shared with the reference server): an index page at 1 MiB, an entry or version document at 320 KiB (the 256 KiB content limit plus 64 KiB), anything else at 256 KiB. So everything the reference server accepts can be read back.
- **Redirects**: GET follows at most 3, same origin only (or http to https on the same host). A write that gets a redirect stops with `redirect` and is never re-sent elsewhere.
- **Received content** is hash-checked against its own hash and the entry's version history, and treated like an import: sanitized, checked against the content policy, normalized, and its command and URL targets listed for the import consent step.
- **No endpoint, no request**: with no endpoint, publish and remote browse stop before any request is made.
- **Explicit only**: the client is used by `ccinfobar catalog publish`, `catalog list --remote`, `catalog show --remote` and the matching web editor routes. No background job and nothing on the status line render path loads it (`test/foundations/import-graph.test.ts` checks this).
- **Confirmation**: publish shows each payload and names the endpoint before anything is sent. It is not blocked by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, because the user asked for it, and the confirmation says so. The web editor sends a hash of the reviewed plan and refuses with "the entries changed" if it differs.
- **Identity**: on the first publish to an origin, ccinfobar registers a handle (the stored publisher, else the author as a slug) and keeps the token in `catalog/credentials.json` (0600). Tokens are never printed or logged.
- **Configuration**: `ccinfobar catalog endpoint <url>` stores the endpoint in `catalog/profile.json`; `CCINFOBAR_MARKETPLACE_URL` overrides it. `ccinfobar catalog endpoint --clear` removes it.
- The client does not cache `index.json` today.

## Reference server

`src/market/server.ts` is a zero-dependency server (Node built-ins, file-backed storage) that implements all of protocol v1 with version history on the server. The tests run it in-process on `127.0.0.1` with an ephemeral port. It is not part of the npm package (`files` is `dist/` and `schema/`), nothing in `dist/ccinfobar.js` reaches it, and it is not deployed anywhere.

### Self-hosting

```sh
node scripts/build.mjs --market      # writes market/ccinfobar-market.mjs (gitignored)
node market/ccinfobar-market.mjs --data ./market-data
node market/ccinfobar-market.mjs --data ./market-data --port 9000 --no-overwrite
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--data <dir>` | required | Data directory |
| `--port <n>` | `8787` | `0` picks a free port |
| `--host <h>` | `127.0.0.1` | Address to listen on |
| `--no-overwrite` | overwrite on | Sets `capabilities.overwrite` to false; `PUT` answers `403 overwrite-disabled` |

It prints `listening on <url>` and stops on Ctrl+C or SIGTERM. Then point ccinfobar at it: `ccinfobar catalog endpoint http://127.0.0.1:8787` on the same machine, or an https URL in front of it.

### Data directory

The layout under `v1/` is exactly the request paths, so `v1/` can be copied to a static host as it is:

```
<data>/
├── v1/meta.json                          rewritten at every start
├── v1/index.json                         rewritten on every write
├── v1/index-<n>.json                     more index pages, 500 entries each
├── v1/entries/<publisher>/<slug>.json    entry and version history
├── v1/entries/<publisher>/<slug>/<n>.json  version content
└── private/                              never served
    ├── publishers/<handle>.json          token sha256 (0600)
    └── owners/<publisher>/<slug>.json    who may change the entry (0600)
```

Withdrawing deletes the version content files and keeps the tombstone, so a copied `v1/` never leaks withdrawn content. Every file is written atomically, and the files under `v1/` are compact JSON so they stay within the client caps.

### Limits and hardening

| Control | Default |
| --- | --- |
| Writes | 30 per minute per IP and per token |
| Reads | 600 per minute per IP |
| Publisher registration | 5 per minute per IP |
| Rate limiter table | 50,000 keys, cleared every minute; a full table answers `429` (fails closed) |
| Publishers | 10,000 |
| Entries | 5000 in total, 200 per publisher (`413 too-large`, also after a restart) |
| Versions | 5000 per entry; a new version or overwrite that would make the entry document larger than 320 KiB answers `413 too-large` |
| Request body | 1 MiB; bodies up to 4 MiB are drained so the `413` reaches the client, a declared size over 4 MiB gets `413` at once, and a stream past 4 MiB is cut off |
| Connections | 256 at once; request timeout 30 s, header timeout 15 s, keep-alive 5 s |

- The index is built from disk once at start. A write updates only that entry's summary in memory and rewrites the index pages; it never reads other entries.
- Path parts are decoded and checked against the id regex before any file path is built.
- A malformed request gets a raw `400`; any other failure answers `500 internal` without details, and the server keeps serving.
- Error messages are fixed English text and never echo input.

Before exposing it beyond your own machine:

- Put it behind a reverse proxy with TLS; ccinfobar only uses http for loopback addresses.
- Rate limits use the socket address, so behind a proxy every client shares the proxy's address and limits. Rate limit at the proxy as well.
- Back up the data directory, including `private/`. There is no route to reset a lost token.
- There is no review queue and no report endpoint: anything that passes the content policy is public at once.

## Serving options

Prices and limits as of 2026-10-16, from the official pages linked below. They change often: re-check before deciding.

| Option | Cost | Auth | Version history | Moderation and takedown | Ops burden |
| --- | --- | --- | --- | --- | --- |
| **A. Static index on GitHub Pages, submissions by PR or issue form, validated by GitHub Actions** | $0. Pages: 1 GB site, soft 100 GB/month bandwidth, soft 10 builds/hour (not for custom Actions workflows). Actions is free for public repos on standard runners | GitHub account through the PR (2FA, GitHub abuse reporting) | git history plus immutable `<n>.json` files | Maintainer review is the moderation; takedown is a PR that writes a tombstone; fast for a small catalog | Lowest: no server, no secrets |
| **B. Cloudflare Workers + D1 (metadata) + R2 (content)** | $0 within free limits. Workers Free: 100,000 requests/day, 10 ms CPU per call; Paid from $5/month. D1 Free: 5M rows read/day, 100k rows written/day, 5 GB. KV Free: 100k reads/day, 1k writes/day, 1 GB. R2 Free: 10 GB-month, 1M Class A, 10M Class B, free egress | GitHub OAuth device flow (no client secret, 15-minute code, poll at `interval`, `slow_down` adds 5 s) | Server rows per version | Needs a review queue and a report endpoint; the Rate Limiting binding is per location and eventually consistent (10 or 60 s periods) | Medium: a Worker, migrations, the OAuth app id |
| C. Supabase (Postgres + Auth + RLS) | Free: 500 MB database, 50,000 MAU, 5 GB egress, 1 GB storage, 2 projects; **free projects pause after 1 week of inactivity**; Pro from $25/month | Built in (GitHub OAuth) | SQL rows | Must be built | Low to medium, but the pause is fatal for a low-traffic catalog |
| D. Deno Deploy + KV | Free: 1M requests/month, 20 GiB egress, 10 h active CPU, KV 1 GiB; Pro $20/month | Must be built | KV | Must be built | Medium; the reference server is Node and would need porting |
| E. Vercel Hobby functions | 1M invocations, 100 GB fast data transfer; **non-commercial personal use only** | Must be built | Needs a database add-on | Must be built | Medium; terms risk if the project ever makes money |
| F. Small VPS or Fly.io running the reference server | Fly.io has no free allowance for new organizations (pay as you go); a typical VPS is about $4-6/month (estimate, not sourced) | Reference server tokens | File-backed | Must be built | Highest: patching, TLS, backups, abuse handling |
| G. npm packages as transport (one package per entry) | $0 | npm accounts | npm versions are immutable ("Once `package@version` has been used, you can never use it again") | Weak: unpublish only within 72 hours, or with under 300 weekly downloads, a single owner and no dependents | Registry abuse, slow, poor takedown |

Sources (fetched 2026-10-16):

- GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- GitHub Actions billing: https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions
- GitHub OAuth device flow: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- GitHub issue forms: https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms
- GitHub REST API rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- Cloudflare Workers pricing (page updated 2026-10-02): https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Supabase pricing: https://supabase.com/pricing
- Deno Deploy pricing: https://deno.com/deploy/pricing
- Vercel Hobby plan (page updated 2026-09-14): https://vercel.com/docs/plans/hobby
- npm unpublish policy: https://docs.npmjs.com/policies/unpublish
- Fly.io discontinued plans (lower confidence, via search): https://fly.io/docs/about/discontinued-plans/

Read limits matter for option A. Unauthenticated GitHub REST API calls are limited to 60 per hour, and raw.githubusercontent.com limits for unauthenticated use were tightened in May 2025 without published numbers (https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/). So the index should be served from GitHub Pages, not from the API or raw URLs.

## Lessons from other ecosystems

- **oh-my-posh** keeps its themes in the main repo and ships them with releases (https://ohmyposh.dev/docs/themes).
- **Starship** presets are community pull requests to `docs/presets` (https://starship.rs/presets/).
- **Raycast**: `npm run publish` opens a PR to `raycast/extensions`, the Raycast team reviews it, and the merge publishes it (https://developers.raycast.com/basics/publish-an-extension).
- **Claude Code plugin marketplaces** are git repos with a `.claude-plugin/marketplace.json` index (https://code.claude.com/docs/en/plugin-marketplaces); this repo already is one.
- **Open VSX** has seen namespace squatting, impersonation and updates pushed with stolen tokens, and moved to pre-publish checks in 2026 (https://thehackernews.com/2026/02/eclipse-foundation-mandates-pre-publish.html, medium confidence). What ccinfobar takes from it: content is data-only, the publisher handle is shown next to the author, every version is hashed, and withdrawn ids stay reserved.

## Privacy

This is not legal advice; check with someone qualified before going live.

- Author names are personal data under the GDPR.
- Published entries are public. With option A, an author name can be removed from the current files on request, but git history and forks keep it. Rewriting history is disruptive and does not reach forks (see https://confluence.atlassian.com/gdpr/bitbucket-right-to-erasure-949770560.html and https://gitlab.com/gitlab-org/gitlab/-/issues/20960).
- The author field is optional free text: prefilled from the last save, editable, and it can be blank.
- The publisher handle is separate from the author. With GitHub-based auth it would be the GitHub login, which is already public.
- ccinfobar sends only the payload it shows: the name, description, author, note and content. No machine ids, paths, personal settings or telemetry.
- Go-live needs a public note that published content is public, and a way to request removal.

## Recommendation

1. **Now, when the owner wants to switch it on: option A.**
   - A public repo (for example `alpadalar/ccinfobar-catalog`) holds `v1/meta.json` with `capabilities.write: false`, `submit: "pull-request"` and a `submitUrl`, plus `v1/index.json` and the `v1/entries/` tree, published to Pages by an Actions workflow.
   - The workflow validates every PR with the same rules as `src/market/protocol.ts` (ids, hashes, `contentProblems`), using a pinned ccinfobar release or a small script copied from it.
   - Cost $0, moderation through review, takedown by PR.
2. **If submissions outgrow manual review: option B.** Workers + D1 + R2 with GitHub device-flow auth, implementing the same v1 protocol with `capabilities.write: true`. Expected cost $0 within the free limits, then $5/month for Workers Paid. Add a pending-review state for first-time publishers and a report endpoint.
3. **Not recommended**: Supabase (inactivity pause), Vercel Hobby (non-commercial clause), npm as transport (takedown), a self-run VPS (ops burden) unless the owner already runs one.

Both A and B speak protocol v1, so the client needs no change to read either one, and moving from A to B keeps the ids and history.

## What go-live adds

- **Option A**: the catalog repo, its Pages workflow and the PR validation. In ccinfobar, a pull-request submission mode for `submit: "pull-request"`: `catalog publish` would write the submission JSON and open a prefilled GitHub new-file or issue-form URL after showing the payload. Today a read-only marketplace only gets the message "This marketplace is read-only. Submit your entries at {url} instead."
- **Option B**: the Worker, D1 schema and R2 bucket, the GitHub OAuth app for device flow, and device-flow login in the client.
- **Either**: install from the marketplace, with the same consent step as `ccinfobar import` for any link targets; an `index.json` cache with ETag in the cache dir; the public privacy and removal notice; a default endpoint only if the owner decides to ship one.

## Owner decision

```
Owner decision (nothing is deployed until this is filled in)

Serving:
  [ ] A  Static index on GitHub Pages, PR or issue-form submissions
  [ ] B  Cloudflare Workers + D1 + R2 with GitHub device flow
  [ ] Self-host the reference server
  [ ] Not now

Repo or domain name: ______________________________
Moderation owner:    ______________________________
Removal requests to: ______________________________
Ship as default endpoint in ccinfobar:  [ ] yes  [ ] no
Decided on (date):   ______________________________
```
