# Marketplace

This document describes the ccinfobar marketplace: the protocol that ccinfobar speaks, the client rules, the public server on Cloudflare, sign-in, moderation, privacy, the requests budget and the runbook for operating it. It also covers the reference server for tests and self-hosting, and the serving decision.

## Status

- **The public marketplace runs on Cloudflare Workers Free and D1** at https://ccinfobar-market.alp-adalar.workers.dev, with GitHub sign-in for publishers. It went live on 2026-10-18. The live smoke test passed: GitHub sign-in, publish, review and approve, install on a second computer, report and resolve, a 229 KB entry, withdraw and sign-out.
- **Default endpoint**: ccinfobar uses https://ccinfobar-market.alp-adalar.workers.dev as the default. `ccinfobar catalog endpoint --off` or `CCINFOBAR_MARKETPLACE_URL=off` switches the marketplace off, and a URL you set with `ccinfobar catalog endpoint <url>` or `CCINFOBAR_MARKETPLACE_URL` wins. Nothing is ever sent without an explicit action (see [Requests budget](#requests-budget)).
- What exists: protocol v1 (`src/market/protocol.ts`) with additive routes for sign-in, accounts, reports and moderation; the client (`src/market/client.ts`); browse, install, publish, sign-in and report in the CLI and the web editor; the Worker (`src/market/worker/`); and a reference server for tests and self-hosting.
- The marketplace is free, open source and non-commercial: no paid plans, no ads, no revenue.

For how users save, install and share entries, see [CATALOG.md](CATALOG.md).

## Protocol v1

Design rule: every **read** is a `GET` on a path that ends in `.json`. A static host (GitHub Pages, an R2 public bucket) can serve the read side unchanged, and search happens on the client over the index pages. **Writes** are optional; a server says in `meta.json` whether it takes them. The routes for sign-in, accounts, reports and moderation are additive: a server without them keeps working with every client.

All paths are relative to the endpoint, which may have a base path (`https://example.com/catalog` reads `https://example.com/catalog/v1/index.json`).

### Routes

| Op | Method and path | Request body | Success | Errors |
| --- | --- | --- | --- | --- |
| Discover | `GET /v1/meta.json` | | `{ protocol: 1, name, capabilities: { write, overwrite, withdraw, submit, review?, report?, cols? }, auth, limits, submitUrl?, github?, quota? }` | |
| List | `GET /v1/index.json`, then `GET /v1/index-<n>.json` while `next` is set | | `{ entries: Summary[], generatedAt, next? }` | `404` for a page that does not exist |
| Entry and history | `GET /v1/entries/<publisher>/<slug>.json` | | Summary plus `versions: [{ version, at, note, hash }]` | `400 invalid`, `404 not-found` |
| Version content | `GET /v1/entries/<publisher>/<slug>/<n>.json` | | `{ version, content, hash }` | `400`, `410 withdrawn`, `404` |
| Register | `POST /v1/publishers` | `{ handle, displayName }` | `201 { handle, token }` | `400 invalid`, `409 conflict`, `413 over-quota`; `403 forbidden` on a server with GitHub sign-in |
| Publish new | `POST /v1/entries` | `{ kind, slug, name, description, author, content, note, cols? }` | `201 { id, version: 1, hash, pending? }` | `401`, `403 banned`, `400 invalid`, `409 conflict`, `413 over-quota` |
| New version | `POST /v1/entries/<publisher>/<slug>/versions` with `If-Match: "<latest version>"` | `{ content, note, name?, description?, cols? }` | `201 { id, version, hash }`, or `202 { id, version, hash, pending: true, reason: 'new-link', links }` when the version is held (see [Moderation](#moderation)) | `401`, `404`, `403 forbidden`, `410 withdrawn`, `412 stale`, `409 conflict` (a version is waiting for review), `400 invalid`, `413 over-quota` |
| Overwrite latest | `PUT /v1/entries/<publisher>/<slug>/versions/<n>` | `{ content, note, name?, description?, cols? }` | `200 { id, version, hash }` | `401`, `403 overwrite-disabled`, `404`, `403 forbidden`, `410`, `409 conflict` (n is not the latest), `403 forbidden` (a new link needs review), `400 invalid` |
| Withdraw | `DELETE /v1/entries/<publisher>/<slug>` | | `200 { id, withdrawn: true }` (also when repeated) | `401`, `404`, `403 forbidden` |
| Sign in | `POST /v1/auth/github` | `{ token }` (a GitHub user token from the device flow) | `200 { handle, token, displayName, admin }` | `400 invalid`, `401 unauthorized`, `403 banned`, `409 conflict` (no free handle), `502 upstream`, `503 unavailable` |
| Sign out | `POST /v1/auth/logout` | | `204` | `401` |
| Account | `GET /v1/me` | | `{ handle, displayName, login, admin, trusted, entries: [{ id, state, version, held?, cols? }] }` | `401`, `403 banned` |
| Report | `POST /v1/entries/<publisher>/<slug>/reports` | `{ reason }` (1 to 200 characters) | `201 { id }` | `401`, `403 banned`, `400 invalid`, `404` (not a live entry), `409 conflict` (already reported) |
| Pending entries | `GET /v1/admin/pending` | | `{ entries: [Summary plus createdAt and held? { version, reason, links }] }` | `401`, `403 not-admin` |
| Review one | `GET /v1/admin/entries/<publisher>/<slug>` | | `{ entry (with state), content, hash, held? }` and an `ETag` review tag | `404`, `410` |
| Approve | `POST /v1/admin/entries/<publisher>/<slug>/approve` with `If-Match: <review tag>` | `{ note? }` | `200 { id, approved: true }` | `409 conflict` (not pending), `412 stale` (changed since the review, or no tag) |
| Reject | `POST /v1/admin/entries/<publisher>/<slug>/reject` | `{ note? }` | `200 { id, rejected: true }` | `409 conflict` (not pending) |
| Remove | `POST /v1/admin/entries/<publisher>/<slug>/remove` | `{ note? }` | `200 { id, removed: true }` | `409 conflict` (already gone) |
| Ban or unban | `POST /v1/admin/publishers/<handle>/ban` or `/unban` | `{ note? }` | `200 { handle, banned }` | `404`, `409 conflict` (admins cannot be banned) |
| Open reports | `GET /v1/admin/reports` | | `{ reports: [{ id, entry, reporter, reason, createdAt }] }`, newest first | |
| Resolve | `POST /v1/admin/reports/<id>/resolve` | `{ note? }` | `200 { id, resolved: true }` | `404` |

Every request can get `429 rate-limited`. Every write can also answer `415 unsupported-media` (the body must be `application/json`) and `413 too-large` (body over 1 MiB). Every admin route answers `401` without a token and `403 not-admin` for a signed-in user who is not an admin; the admin check comes before ids and bodies. Lists (account entries, pending entries, reports) hold at most 200 rows. Errors are listed in the order the reference server checks them. The Worker answers `403 forbidden` to a new version, overwrite or withdraw of another publisher's id before it looks the entry up, so a pending entry hidden from reads cannot be probed through the write routes.

- **Summary**: `{ id, kind, name, description, author, publisher, version, updatedAt, hash, withdrawn?, cols? }`. `publisher` must equal the first part of `id`, or the client drops the row.
- **Cols** is the terminal width the author designed the entry at, a whole number from 40 to 400. It is entry metadata like the name and description, outside the hashed `content`, so the same content has the same hash with or without it. The server keeps one width per entry, not per version: installing an older version (`id@N`) gets the entry's current width. Changing only the width (or only the name or description) does not create a new version; ccinfobar sends it with the next content change. Index summaries, entry documents and `/v1/me` entries carry it when it is set. A new version or overwrite without `cols` keeps the entry's cols; one with `cols` replaces it. An invalid value in a body or a document is dropped, never a reason to reject the request or the row. Withdraw and remove clear it, like the name, description and author: tombstones carry no cols, and the Worker sets `entries.cols` to NULL. Servers accept `cols` on any kind; ccinfobar never sends it for a theme and drops it when installing one. ccinfobar sends `cols` only to a server whose meta has `capabilities.cols: true`, so older self-hosted servers keep working; it previews a preset or bundle at its cols and sets the editor width to it on apply.
- **Index pages**: `index.json` holds at most 500 summaries. When there are more, `next` names the next page relative to `v1/` (`index-2.json`, then `index-3.json`), up to `index-10.json` (5000 entries). A page may only link to the page right after it; any other `next` ends the list, and the client stops at 5000 entries. A static host serves the pages as plain files. Each page may carry `gen`, a number that every page of one index build shares (both servers send it). When a later page has another `gen` than page 1, the index changed during the walk: the client starts over from page 1 once, and if the pages still differ it shows what it got with a note that entries may be missing and does not cache it, so the next load asks again. Pages without `gen` (static hosts, older servers) are not compared.
- **Withdraw** is soft. The entry file stays as a tombstone with `withdrawn: true` that keeps only the id, kind, publisher, version numbers, times and hashes; the name, description, author and version notes are blanked in the tombstone and the index, because they are personal data. Version content answers `410`, and the id stays reserved: publishing the same slug again gives `409`. The servers leave tombstones out of the index, so withdrawing never grows it; a static host that lists them must mark them `withdrawn: true`, and only such a summary may have an empty name.
- **Overwrite** is allowed only when `capabilities.overwrite` is true. ccinfobar reads it before the publish review, so the review shows "New version" where overwrite is off. A reviewed overwrite that the server then refuses with `403 overwrite-disabled` is reported and never turned into a new version. The public server has overwrite off, so a published version never changes.
- **Pending**: on a server with `capabilities.review`, a publish can answer `pending: true`. The entry is then held for review: reads answer `404` for it, it is not in the index, and `GET /v1/me` lists it with `state: "pending"`. ccinfobar shows "Waiting for review" until an admin approves it. If an admin rejects it, the entry is deleted on the server and its id is free again: `catalog publisher --check` (an id that is neither live nor waiting in `/v1/me`, when the list is not full) or the next new version or withdraw (answered `404`) notices it, says so, and puts the entry back to not shared, so sharing it again submits it as a new entry. A version answered `410` (removed by an admin, or withdrawn elsewhere) marks the entry withdrawn, and its id stays reserved like any withdrawn id.

### Meta fields

| Field | Meaning |
| --- | --- |
| `capabilities.write`, `overwrite`, `withdraw` | Which writes the server takes |
| `capabilities.submit` | `api` (writes through this protocol) or `pull-request` (read-only, submit at `submitUrl`) |
| `capabilities.review` | New entries of a new publisher wait for an admin (`pending`) |
| `capabilities.report` | The server takes reports (`POST .../reports`) |
| `capabilities.cols` | The server stores `cols` and returns it; without it clients leave `cols` out of write bodies |
| `auth` | `["token"]` (the reference server: register a handle) or `["github-device"]` (GitHub sign-in) |
| `github.clientId` | The public client id of the OAuth app that the device flow uses. It is not a secret |
| `limiters.reads`, `writes`, `signIn`, `strict` | Whether the Worker has its `READS`, `WRITES` and `SIGNIN` rate limit bindings and the `LIMITER` Durable Object (public, no sensitive data; a Worker with `writes: false` refuses writes, see Rate limits) |
| `limits` | The size limits below; a server may advertise a smaller `maxEntryBytes` |
| `quota.publisherBytes` | How much live content one publisher may store |
| `quota.pendingEntries`, `quota.pendingBytes` | How many entries, and how much content, one publisher may have waiting for review |
| `quota.pendingTotal` | How many entries may wait for review in total |

The public server answers `capabilities: { write: true, overwrite: false, withdraw: true, submit: "api", review: true, report: true, cols: true }`, `auth: ["github-device"]`, `github: { clientId: "Ov23liVCN9Nf6VlLv3St" }` and `quota: { publisherBytes: 20971520, pendingEntries: 3, pendingBytes: 1048576, pendingTotal: 50 }`.

### ETag and 304

Read routes on the public server send an `ETag` and answer `304 Not Modified` to a matching `If-None-Match`, with `cache-control: no-cache`; there is no edge cache. One generation tag covers every index page, so an unchanged index costs one row read and no body. Entry documents have their own tag, and a version document's tag is its content hash. The reference server sends no `ETag`; the client then reads the full document.

### Ids and versions

- Ids are `<publisher>/<slug>`. Both parts match `^[a-z0-9][a-z0-9-]{0,38}$`.
- The server assigns the publisher (the handle a token belongs to). `author` is a free display name, so the UI shows both against impersonation.
- Versions are integers from 1. A new version is `latest + 1`; overwrite keeps the number. An entry holds at most 5000 versions.

### Hashes

`hash` is the lowercase hex sha256 of the canonical JSON of `content`: object keys sorted by code unit, no whitespace, `undefined` values dropped. The server hashes the content after sanitizing its text (control characters, escape sequences and bidi marks removed; tabs and newlines become spaces), and ccinfobar sanitizes the same way before it shows, hashes and sends a payload, so the hash it keeps matches the server's. The client recomputes it on every download and refuses a mismatch (`bad-hash`). It also requires the version file's hash to equal the one listed for that version in the entry's history, which it fetches separately, and the entry's own `hash` for the latest version. That catches a swapped, stale or cached version file; a host that rewrites the entry and its version files together can only be caught by comparing with a copy you trust.

### Content and policy

`content` is `{ layout?, appearance?, theme? }`: `layout` holds the preset keys (`lines`, `align`, `lineAlign`, `overflow`, `autoWrap`, `widthOffset`, `tui`), `appearance` the theme keys (`theme`, `style`, `separator`, `separatorColor`, `padding`, `glyphs`) and `theme` an embedded theme file. A preset has only `layout`; a theme has `appearance` and/or `theme`; a bundle has `layout` and `appearance` and may have `theme`.

The marketplace is data-only. The client and both servers (`contentProblems`) refuse content with:

- `command`, `http` or `env` widgets
- `link` widgets whose URL is not http or https
- personal keys (`budget`, `profiles`, `language`, `charset`, `update` and the rest of `PERSONAL_KEYS` in `src/core/entry-keys.ts`), unknown keys, or theme fields that a theme file does not have
- lines that are not lists of widget objects
- content over 256 KiB of canonical JSON

### Auth

Writes send `Authorization: Bearer <token>`; public reads never send a token. A marketplace token is 32 random bytes as 64 hex characters, returned once and stored on the server only as its sha256.

- **`token`** (reference server): `POST /v1/publishers` registers a handle and returns a token.
- **`github-device`** (public server): `POST /v1/auth/github` exchanges a GitHub user token for a marketplace token (see [Sign-in](#sign-in)). `POST /v1/publishers` answers `403 forbidden` "sign in with GitHub to publish".

Only the publisher of an entry may add versions, overwrite or withdraw it.

### Limits

| Limit | Value |
| --- | --- |
| Entry content | 256 KiB (`maxEntryBytes`) |
| Request body | 1 MiB (`maxBodyBytes`) |
| Name, author, display name | 64 characters |
| Description, note, report reason | 200 characters |
| Versions per entry | 5000, and the entry document (summary plus history) stays under 320 KiB |
| Index page | 500 summaries |

A server advertises its limits in `meta.json` `limits`.

### Errors

Error bodies are `{ "error": { "code": "<code>", "message": "<text>" } }`. Codes (`ERROR_CODES`):

| Code | Meaning |
| --- | --- |
| `invalid` | Malformed request or content |
| `too-large` | A body or content over its size limit |
| `over-quota` | A count or storage limit: entries, entries waiting for review, withdrawn entries, versions, publishers, publisher storage or the database |
| `conflict` | Already exists, already reported, not pending, or no free handle |
| `stale` | Not the latest version, or changed since an admin's review |
| `forbidden` | Not your entry, register refused, or new content held for review |
| `not-found`, `withdrawn` | No such entry or page; withdrawn or removed |
| `version-dropped` | `410` for an older version of a live entry whose content is gone: an approval keeps only the reviewed version. Older clients see `withdrawn` |
| `rate-limited` | Too many requests; `429` carries `Retry-After` in seconds |
| `overwrite-disabled` | The server does not overwrite |
| `unsupported-media` | The body is not `application/json` |
| `unauthorized` | Missing or unknown token, or a GitHub token that is not ours |
| `banned` | The publisher is banned |
| `not-admin` | An admin route for a user who is not an admin |
| `upstream` | GitHub could not be reached or answered something unusable (`502`) |
| `unavailable` | Sign-in is not configured on this server (`503`) |

The servers also answer `500 internal`. Static hosts answer without a JSON body, so the client maps the status (`404` to `not-found`, `429` to `rate-limited`, and so on); any other status is reported as "The marketplace answered with HTTP N" (code `http`, with `status`). The client keeps only the code; server messages are never shown.

## Client

`src/market/client.ts` is the only code that talks to a marketplace, and `src/market/github.ts` the only code that talks to GitHub.

- **Endpoint**: https only, except http on `localhost`, `127.0.0.1` and `[::1]` (for the reference server). No user name or password, query or fragment.
- **Bounds**: one 10 s timeout covers all hops and the body. Responses are capped per document (`RESPONSE_CAPS`, shared with the servers): an index page at 1 MiB, an entry or version document at 320 KiB (the 256 KiB content limit plus 64 KiB), anything else at 256 KiB. So everything the servers accept can be read back.
- **Redirects**: GET follows at most 3, same origin only (or http to https on the same host). A write that gets a redirect stops with `redirect` and is never re-sent elsewhere. A `304` is an answer, not a redirect.
- **Received content** is hash-checked against its own hash and the entry's version history, and treated like an import: sanitized, checked against the content policy, normalized, and its command and URL targets listed for the consent step.
- **Install**: `ccinfobar catalog install <publisher/slug>[@version]` and **Install** in the editor download one version, check its hash, list every command and URL it keeps and install only what you reviewed. The entry goes into your catalog with its origin (endpoint, id, version, hash, time) and is not applied; installed entries cannot be shared as your own.
- **No endpoint, no request**: with no endpoint (or the marketplace off), publish, install, sign-in and remote browse stop before any request is made.
- **Explicit only**: no background job and nothing on the status line render path loads the client (`test/foundations/import-graph.test.ts` checks this). See [Requests budget](#requests-budget).
- **Confirmation**: publish shows each payload and names the endpoint before anything is sent. It is not blocked by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, because the user asked for it, and the confirmation says so. The review reads `meta.json` first, so it shows the action the server will really do and, on a token server, the registration a first publish makes. The CLI and the web editor compute the same hash over the endpoint, the plan and the registration; the CLI plans again after you confirm, and the editor sends the reviewed hash. If it differs, nothing is sent and the new plan is shown. Each entry is then sent only while its rev and payload still equal the reviewed ones (otherwise it is reported as changed after the review). On a server with GitHub sign-in, publish asks you to run `ccinfobar catalog login` first.
- **Identity**: tokens and handles are kept per endpoint (origin plus base path), so `https://host.example/team-a` and `https://host.example/team-b` never share a token or a handle. A request that carries the token (writes, `/v1/me`, admin routes) never follows a redirect, so a redirect cannot carry the token to another path on the same host. On a token server, the first publish registers a handle: the one set with `ccinfobar catalog publisher <handle>` (or the field in the editor's publish review) for that endpoint, else the author as a slug. On a GitHub server the handle comes from your GitHub login and cannot be set. The marketplace token goes to `catalog/credentials.json` (0600) and is never printed or logged. A refused token points to `catalog login` (GitHub) or `catalog publisher --forget` (token servers).
- **Configuration**: `ccinfobar catalog endpoint <url>` stores the endpoint in `catalog/profile.json`; `CCINFOBAR_MARKETPLACE_URL` overrides it (`off` switches it off). `ccinfobar catalog endpoint --off` stores `"endpoint": false`, which switches the marketplace off (older builds read it as no endpoint); `ccinfobar catalog endpoint --clear` removes the stored value so the default applies again. The bare command shows the endpoint and its source. Order: environment, stored URL, stored off switch, shipped default (https://ccinfobar-market.alp-adalar.workers.dev).
- **Cache**: see [Requests budget](#requests-budget). The cache lives in the cache directory under `market/<16 hex>/`, one folder per endpoint. Entry and version files are named by a hash of the entry id, never the id itself, so ids such as `con/nul` or `com1/x` never become Windows device paths. Cache files carry a schema number; a file of another schema is ignored and fetched again without a tag. Schema 2 keeps `cols`, so caches from 0.8.x are fetched again once.

### Reports and moderation from the CLI

Signed-in users report an entry with `ccinfobar catalog report <publisher/slug> --reason "<text>"` (once per entry, 1 to 200 characters). Admins moderate with `ccinfobar catalog admin`, which is not in the main help and prints its own usage. Every subcommand takes `--json` (English); the server checks admin rights, the CLI only forwards.

| Command | Does |
| --- | --- |
| `catalog admin pending` | Entries waiting for review: id, kind, name, publisher, version, created, and, for a trusted publisher's held version, the version number and the new link hosts |
| `catalog admin show <publisher/slug>` | The entry, its versions and its content as sanitized JSON text (never applied or rendered), plus its review tag |
| `catalog admin approve <publisher/slug> [--tag <review tag> \| --yes] [--note <text>]` | Approve the reviewed revision (sent with `If-Match`). With `--tag` from `admin show`, a change since then is refused. Without `--tag` it prints what goes live (name, id, version, content hash prefix) and asks in a terminal; elsewhere it needs `--yes`. Either way it pins the revision it showed |
| `catalog admin reject\|remove <publisher/slug> [--note <text>] [--yes]` | Reject a pending entry, or remove an entry (tombstone; its publisher is reviewed again) |
| `catalog admin ban <handle> [--note <text>] [--yes]` | Ban a publisher: their entries leave the index, and they cannot sign in, write or report |
| `catalog admin unban <handle> [--note <text>]` | Lift a ban |
| `catalog admin reports` / `catalog admin resolve <number>` | Open reports, newest first; close one |

`reject`, `remove` and `ban` ask in a terminal and need `--yes` otherwise.

## Requests budget

The Worker gets 100,000 requests a day on Workers Free, shared by every ccinfobar user. ccinfobar is built so that an idle install costs nothing.

- ccinfobar contacts the marketplace or GitHub only on explicit actions: opening the editor's Marketplace page (it opens on the marketplace Bundles tab), showing a marketplace tab, **Refresh**, install, publish, sign-in, report and the `catalog` commands that need it (`list --remote`, `show --remote`, `install`, `publish`, `login`, `logout`, `report`, `publisher --check`, `admin`). Never during a status line refresh, never from a background job, and never from an editor that is left open (tests advance fake timers by 24 hours and assert zero requests from both the editor page and the editor server).
- The index is cached for 24 hours. Opening the editor's Marketplace page or running `catalog list --remote` within that time sends nothing. The tab and the CLI show when the marketplace was last checked.
- **Refresh** (and `--refresh`) sends one conditional request, `GET /v1/index.json` with `If-None-Match`. An unchanged index answers `304` and nothing more is fetched; only a `200` fetches the other index pages. A `304` still counts as one Worker request toward the 100,000 a day. Refreshes within 30 s of the last check use the cache.
- Version documents are cached for good, because published versions are immutable on the public server; the hash is checked again on every read. Entry documents (the history) are checked with their `ETag` only when you open an entry's details or install it.
- Card previews download each shown entry's latest version once, checked against the hash in the index and validated like an install. They are cached for good on an immutable server and kept in memory while the page is open. They are asked only when a marketplace tab is shown or after **Refresh**, never while idle, at most 24 entries per request and 4 downloads at a time. A preview is not an install: install still checks the entry's version history.
- If the marketplace cannot be reached, the saved list is shown.
- Sign-in polls GitHub at the interval GitHub gives (5 to 60 s, longer after `slow_down`), with at most 3 retries on errors and a growing wait between them, and stops when the code expires (GitHub gives 15 minutes) or the dialog is closed.

## Cloudflare server

`src/market/worker/` is the public server: a Cloudflare Worker with one D1 database. It speaks the same protocol v1 as the reference server, and the shared conformance suite runs against both. It is not part of the npm package.

| Part | Value |
| --- | --- |
| Worker | `ccinfobar-market` on workers.dev; config `worker/wrangler.jsonc` (pinned account id, `no_bundle: true`, `preview_urls: false`, invocation logs off) |
| Database | D1 `ccinfobar-market`, binding `DB`, schema in `worker/migrations/` |
| Read limiter | Rate Limiting binding `READS` (60 a minute per key) |
| Vars | `MARKET_NAME`, `GITHUB_CLIENT_ID`, `ADMIN_GITHUB_IDS`, `ALLOW_OVERWRITE` (`false`) |
| Secret | `GITHUB_CLIENT_SECRET` (required for sign-in) |
| Cron | `17 */6 * * *` (every six hours): deletes salts older than two days and rate rows older than two hours in batches of 500 (at most 10,000 a run), then rebuilds an index left stale |
| Optional vars | `MAX_ENTRY_BYTES`, `MAX_DB_BYTES`, `PUBLISHER_BYTES`, `PENDING_ENTRIES`, `PENDING_PER_PUBLISHER`, `PENDING_BYTES`, `INDEX_REBUILD_ROWS`, `WRITE_LIMIT`, `SIGNIN_LIMIT`, `REPORT_LIMIT`, `ALLOW_UNVERIFIED_GITHUB_TOKENS` |

`GET /` answers a small static page (no scripts, no entry data) that says what the marketplace is, that everything published is public, and that removal requests go to a GitHub issue on alpadalar/ccinfobar.

### Materialized documents

Reads never build JSON. Each entry row keeps its summary and its entry document as stored text, each version row keeps its version document, and the index pages are kept in `index_pages` with a generation number. A write that changes the public index marks it stale inside its own transaction and then rebuilds the pages. If the rebuild fails (a D1 error, or the CPU limit), the write still answers success and the index stays marked stale: the next write, the next read of `index.json` or the cron job rebuilds it. A read is one row lookup that sends the stored text as it is, with its `ETag`. Writes compute the canonical JSON once for the policy check and the hash, to stay inside the 10 ms CPU limit.

### Schema

`worker/migrations/0001_init.sql`, then the later files in order; later migrations are additive only. `0002_counts.sql` adds the entry counts that triggers keep up to date and the indexes the index rebuild reads; `0003_pending.sql` has triggers keep the stored bytes too, with the bytes waiting for review apart, and counts the publishers; `0004_rate_index.sql` indexes the rate windows, so old rate rows are deleted in batches of 500 without reading the rest; `0005_index_dirty.sql` adds the stale-index marker and the rebuild budget; `0006_takedown.sql` adds the takedown counter, the generation of the last withdraw, remove or ban, which the index shows past any budget; `0007_rebuild_lease.sql` adds the rebuilding lease counter, so only one index rebuild runs at a time; `0008_moderation_actor.sql` adds the `moderation.actor` column (`admin` or `publisher`); `0009_entry_cols.sql` adds the nullable `entries.cols` column with no default, check or backfill, so it needs no table rebuild; `0010_held_version.sql` adds the nullable `entries.held` column (JSON of the one version waiting for link review) with no default or backfill, and a partial index for the held list. The deploy applies migrations before the new Worker, and the old Worker's inserts and updates name their columns, so it keeps working against the new column until it is replaced.

| Table | Holds |
| --- | --- |
| `publishers` | handle, GitHub id (unique), GitHub login, display name, trusted, banned time, created time, stored bytes (and the part of them waiting for review), and the counts of their live, pending and withdrawn entries |
| `tokens` | sha256 of each marketplace token, handle, created time (the newest 10 per publisher are kept) |
| `entries` | publisher, slug, kind, state (`pending`, `live`, `withdrawn`, `removed`), version, hash, times, summary and entry document, generation, and the author's preview width `cols` (NULL when unset, `0009_entry_cols.sql`) so `/v1/me` lists it without parsing the document, and `held`, the version waiting for link review (NULL when none, `0010_held_version.sql`) |
| `versions` | publisher, slug, version and the version document (NULL once withdrawn or removed); a held version's body is stored like any other and counts toward the publisher's stored bytes |
| `index_pages` | the materialized index pages with their generation |
| `reports` | entry, reporter handle, reason, created and resolved times; one per reporter and entry |
| `moderation` | every admin action: time, admin handle, action, target, note; a publisher withdrawing their own pending entry is logged with `actor = 'publisher'` (`0008_moderation_actor.sql`), apart from admin actions |
| `rate`, `salts` | rate limit counters keyed by salted hashes, and one random salt per day |
| `counters` | the index generation, the generation the index must show (`dirty`), the rows rebuilds read today, the database size, and the counts of live, pending and withdrawn entries and of publishers |

### Rate limits

| Bucket | Default | Key |
| --- | --- | --- |
| Reads | 60 a minute (the `READS` binding; without the binding, or when it fails, reads are not limited). A client reads about a dozen documents at once (meta, up to 10 index pages, an entry and a version), plus one version per entry the first time its card preview is shown; the index is cached for a day and versions for good | sha256 of the day and the address, in memory only |
| Writes (publish, new version, overwrite, withdraw) | 30 a minute per address through the `WRITES` binding (per Cloudflare location, approximate; nothing is written for a refused or unauthenticated request) and 30 a minute per publisher in D1 (`WRITE_LIMIT`) | sha256 of the day and the address, in memory only; handle |
| Sign-in | 20 a minute per address through the `SIGNIN` binding (a flood ceiling), then, in D1, failed attempts per address (`SIGNIN_LIMIT`, default 5 a minute: a bad body, an unknown or foreign token, a GitHub refusal or a ban; a sign-in is refused once more than that many failures are in the window, so five mistakes still let a valid attempt through) and successful sign-ins per handle (`SIGNIN_LIMIT` a minute). GitHub outages (`502`) and `503` do not count. | sha256 of the day and the address, in memory only; salted address hash |
| Reports | 5 an hour per reporter (`REPORT_LIMIT`) | handle |

Three layers count each address, from the cheapest to the strictest:

1. A per-isolate memory window on every check (reads 60, writes 30, sign-in 20 a minute). It clears its map when it reaches 5,000 keys, so a spray of addresses only resets that isolate's counts.
2. The `READS`, `WRITES` and `SIGNIN` bindings. Their outcomes are logged as `ratelimit <prefix> refused`, `threw` or `unexpected` (no address, key or hash).
3. The `RateCounter` Durable Object (`LIMITER` binding) for writes and sign-in only: one counter per address and minute, global across locations, memory only (no storage rows, so Workers Free allows it). IPv6 addresses count by their /64, and the counters are spread over 16 Durable Object instances by a hash of the key. An instance holds 10,000 addresses in a window (about 160,000 across the 16 instances). Once an instance is full, addresses it does not track yet share one overflow count at 20 times the usual limit and the Worker logs `ratelimit <prefix> overflow` once per window and instance; addresses it already tracks keep their own counts, and the memory layer and the bindings still apply to every request. The trade-off: under a spray larger than that capacity, new addresses on the filled instance share that generous bucket, so a huge spray can refuse new addresses there for the rest of the minute. There is no secret salt, by design: the instance comes from a hash of the address key, so aiming at one instance only affects the overflow traffic of that instance. If it throws, answers badly or is unreachable, the Worker logs `ratelimit <prefix> do-failed` and the other layers decide; it never turns into a `503`. Reads never use it. `limiters.strict` in `/v1/meta.json` tells whether the binding exists.

The windows only move forward: a request that started just before a minute boundary and arrives after it is let through uncounted and never clears the new minute's counts.

The layers answer before the body is read or the token is looked up, so a junk request writes no D1 row at all; without the `WRITES` or `SIGNIN` binding, publish, new version, overwrite, withdraw and sign-in answer `503 unavailable` ("rate limiter is not configured") instead of running unlimited; set `ALLOW_OPEN_LIMITERS=true` (self-hosted dev and tests only) to let them go on to the D1 buckets. A binding that is present but throws still lets the request through to the D1 buckets. `/v1/meta.json` shows which bindings exist in `limiters`. The per-publisher counters live in D1 fixed windows.

**The Durable Object is a class lifecycle change.** The deploy that created `RateCounter` (migration tag `v1`, `new_sqlite_classes`) cannot be undone with `wrangler rollback`. Fix forward: to switch it off, remove the Durable Object call from the code but keep the class, the binding and the `v1` migration. Deleting the class needs a separate `deleted_classes` migration.

**Optional WAF rule (owner).** A Cloudflare rate limiting rule on the zone stops floods before the Worker runs. It needs a custom domain; a `workers.dev` hostname cannot carry one.

**Burst check (owner, production).** Start when `date -u +%S` is below 5 so the minute window does not roll over mid-run. Anonymous writes, 35 requests at 2 a second, expect 30 times `401` and 5 times `429`:

```
curl -s -o /dev/null -w '%{http_code}\n' --rate 2/s -X POST -H 'Content-Type: application/json' --data '{}' "$MARKET_URL/v1/entries?n=[1-35]" | sort | uniq -c
```

Reads are best effort (the `READS` binding is approximate and per location), 70 requests at 5 a second, expect at least one `429`:

```
curl -s -o /dev/null -w '%{http_code}\n' --rate 5/s "$MARKET_URL/v1/meta.json?n=[1-70]" | sort | uniq -c
```

If a write burst shows no `429`, check `limiters` in `/v1/meta.json` (`strict` should be `true`).

### Storage guards

A Free D1 database holds at most 500 MB. The Worker refuses a write with `413 over-quota` "marketplace storage is full" once the database reaches `MAX_DB_BYTES` (400 MiB), measured from the size D1 reports after each write, and "publisher storage limit reached" once a publisher's live content would pass `PUBLISHER_BYTES` (20 MiB). Withdraw always works and refreshes the size, so a full database can recover. The publisher limits and the database size guard are checked again inside the write transaction, so racing writes cannot pass them. The size is the one D1 reported after the last finished write, so writes in flight at the same moment can pass `MAX_DB_BYTES` by at most their own size, far inside the 100 MB left to the 500 MB limit. The entry, tombstone, version and publisher caps are the same as on the reference server (5000 live entries, 200 per publisher, 50,000 withdrawn, 1000 per publisher, 5000 versions per entry, 10,000 publishers; a new publisher past the cap gets `413` "too many publishers" at sign-in; approve checks the same caps).

Entries waiting for review do not count toward the live caps or `PUBLISHER_BYTES`, so unreviewed uploads cannot lock out trusted publishers. They have small caps of their own: 50 in total (`PENDING_ENTRIES`), 3 per publisher (`PENDING_PER_PUBLISHER`) and 1 MiB of content per publisher, versions included (`PENDING_BYTES`), answered with `413 over-quota` "too many entries waiting for review", "… for this publisher" or "publisher review storage limit reached". Pending content therefore holds at most about 50 MiB of the database. Banning a publisher deletes their pending entries, which were never public, in the same transaction.

### Overwrite off

`ALLOW_OVERWRITE` is `false`, so `capabilities.overwrite` is false and `PUT` answers `403 overwrite-disabled`. Published versions never change, which is why clients cache version documents for good. Only the exact string `true` turns overwrite on.

## Sign-in

Publishers sign in with GitHub. There is no password and no registration.

1. The device flow runs on the user's machine: ccinfobar asks GitHub for a device code with the public client id from `meta.json` (`github.clientId`) and shows the code and https://github.com/login/device. `catalog login` can open that page (`--open`, `--no-open`); the editor shows a dialog that can be cancelled. No client secret is involved on the user's side.
2. After the user approves the app, ccinfobar gets a GitHub user token and sends it once to `POST /v1/auth/github`. The GitHub token is never stored or logged, on the machine or on the server, and no refresh token is kept. Once the exchange is done (signed in or refused as banned), the Worker revokes the token at GitHub (`DELETE /applications/<client_id>/token`, best effort with a 3 s timeout), so it is no longer valid there either.
3. The Worker verifies the token with GitHub's check-token API (`POST https://api.github.com/applications/<client id>/token`, Basic auth with the client id and `GITHUB_CLIENT_SECRET`). The answer must name our client id as the token's app; a token from another app, or from no app, gets `401 unauthorized`. Only `User` accounts can sign in.
4. The handle is the GitHub login in lowercase; if it is taken, `-2` up to `-20`. A returning user (same GitHub id) keeps the handle.
5. The Worker answers a new marketplace token, the handle, the display name and whether the user is an admin. ccinfobar keeps only that token, in `catalog/credentials.json`.

`catalog logout` (or Sign out in the editor) revokes the marketplace token on the server when it can and forgets it on this computer.

**Sign-in limits.** After the `SIGNIN` binding, the Worker checks the per-address failure bucket (`a:`) before reading the body and bumps it only when the attempt fails with `400`, `401` or `403`; once the token is verified and the account is not banned, the per-handle success bucket (`s:`) is checked before the marketplace token is issued, so a shared network address is not blocked by its neighbours' successes.

**Fail closed.** Without `GITHUB_CLIENT_SECRET`, `POST /v1/auth/github` answers `503 unavailable` "sign-in is not configured" before any GitHub call or row write. A self-hoster can set the var `ALLOW_UNVERIFIED_GITHUB_TOKENS` to exactly `true` to skip check-token and only ask GitHub's `/user`. That is weaker: any GitHub token of the user, from any app, signs them in. The public server never sets it.

**Admins** are pinned by numeric GitHub id in `ADMIN_GITHUB_IDS` (comma separated), not by login, because logins can be renamed. The public server's admin is `65018489` (alpadalar). Admins cannot be banned.

## Moderation

- **Trust on first approval.** A publisher starts untrusted. Their entries wait as `pending`: invisible to everyone else, out of the index, and listed by `catalog admin pending`. The publisher may still add versions to a pending entry or withdraw it (a pending entry that is withdrawn is deleted, since it was never public). When an admin approves an entry, only the reviewed revision goes public, older unreviewed version bodies are dropped, and the publisher becomes trusted: their later entries and versions go live at once, without review.
- **New links are held.** A trusted publisher's new version of a live entry that adds a link to a host and path the live version did not have is held (`202 ... pending: true, reason: 'new-link'`): the entry stays live at its approved version, the held version is not public, `/v1/me` shows `held`, `catalog admin pending` lists it with the new hosts, `admin show` shows its content, approve makes it the live version and reject deletes it. A version that keeps or drops links goes live at once, and an overwrite that adds a link is refused (`403 forbidden`). A new entry by a trusted publisher is not held; only versions are, because the first approval covered the publisher and the conformance protocol lists trusted publishes as live.
- **What the data-only rule still prevents.** Content never carries `command`, `http` or `env` widgets (refused with `400 invalid`), links are `http(s)` only, names and notes are plain text without invisible characters, and sizes are capped; a trusted publisher can therefore change text, layout and theme freely, and can publish a new entry with any `http(s)` link: reports and takedown cover that case.
- **Report and takedown.** Any signed-in user reports a live entry once (`catalog report <id> --reason`); `catalog admin reports` lists open reports; `admin remove` tombstones the entry and makes the publisher untrusted again, `admin ban` hides every entry of the publisher; both take effect in the index at once (takedown rebuild).
- **Approve is pinned.** `admin show` returns a review tag (content hash and generation), and approve sends it as `If-Match`. If the entry changed since the review, approve answers `412 stale` and nothing goes public. `catalog admin approve` with `--tag` pins what `admin show` printed; without it, the command first prints the revision it will approve and asks (or needs `--yes`), and pins that revision, so a version added after `admin show` is never approved unseen. Approve also checks the live caps (5000 entries, 200 per publisher) inside the same statement and answers `413 over-quota` when they are full, so moderation cannot push the marketplace past the limits that publishing honours.
- **Live entries of untrusted publishers.** A live entry takes new content only from a trusted publisher. When an admin removes an entry, its publisher becomes untrusted again: their live entries cannot get new versions (`403 forbidden` "new content waits until an admin approves your next entry") and new entries wait for review, until an admin approves one of them. Public ids never go back to pending.
- **Reports.** A signed-in user reports a live entry once, with a reason. `catalog admin reports` lists open reports and `catalog admin resolve <number>` closes one. Removing an entry resolves its reports.
- **Remove** writes a tombstone like a withdraw (the name, description, author and notes are blanked and the version content is deleted), and the id stays reserved.
- **Ban** hides every live entry of the publisher (reads answer `404`, the index drops them) and deletes their pending entries, which were never public. Their tokens stay, but writes, reports, `/v1/me` and sign-in answer `403 banned`. Unban shows the live entries again.
- Every admin action, with its note, goes to the `moderation` table.

## Reference server

`src/market/server.ts` is a zero-dependency server (Node built-ins, file-backed storage) that implements protocol v1 with version history on the server, using token auth (`auth: ["token"]`). It has no sign-in, review queue or report routes. The tests run it in-process on `127.0.0.1` with an ephemeral port. It is not part of the npm package (`files` is `dist/` and `schema/`), nothing in `dist/ccinfobar.js` reaches it, and it is not deployed anywhere.

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

To self-host the Worker instead, deploy it to your own Cloudflare account with your own D1 database and OAuth app: change `account_id`, `database_id`, `GITHUB_CLIENT_ID` and `ADMIN_GITHUB_IDS` in `worker/wrangler.jsonc` and set your own `GITHUB_CLIENT_SECRET`.

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

Withdrawing deletes the version content files and keeps a blanked tombstone, so a copied `v1/` never leaks withdrawn content or the author's name. A tombstone written by an older server that still has a name is blanked at the next start. Every file is written atomically, and the files under `v1/` are compact JSON so they stay within the client caps.

### Limits and hardening

| Control | Default |
| --- | --- |
| Writes | 30 per minute per IP and per token |
| Reads | 600 per minute per IP |
| Publisher registration | 5 per minute per IP |
| Rate limiter table | 50,000 keys, cleared every minute; a full table answers `429` (fails closed) |
| Publishers | 10,000 |
| Entries | 5000 live entries in total, 200 per publisher (`413 over-quota`, also after a restart) |
| Withdrawn entries | Their ids stay reserved and count separately: 50,000 in total, 1000 per publisher. At either cap a new publish answers `413 over-quota`; withdrawing always works, so a publisher has at most 1000 + 200 tombstones. Both caps are options of `startMarketServer` (`caps.tombstones`, `caps.tombstonesPerPublisher`) |
| Versions | 5000 per entry; a new version or overwrite that would make the entry document larger than 320 KiB answers `413 over-quota` |
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
- There is no review queue and no report endpoint: anything that passes the content policy is public at once, and Report in ccinfobar does not work against it.

## Privacy

This is not legal advice.

- Published entries are public: anyone can read, download and install them. The landing page at `/` says so.
- The public server stores only the GitHub id, login and display name of a publisher, plus what the protocol already stores: entries, versions, their notes, reports (reporter handle and reason) and the moderation log (admin handle and note). No email, no GitHub token, no machine ids, paths, personal settings or telemetry.
- IP addresses are never stored. Write, sign-in and report limits use a hash of the address with a random salt that changes every day; a salt is deleted once it is two days old (a cron job runs the cleanup every six hours), which makes the old hashes unlinkable, and counters older than two hours are deleted too. The read, write and sign-in bindings keep their keys in memory only. Worker invocation logs are off, and errors log only `market: internal`.
- The author field is optional free text: prefilled from the last save, editable, and it can be blank. The publisher handle is separate from the author and comes from the GitHub login, which is already public.
- ccinfobar sends only the payload it shows: the name, description, author, note and content.
- Withdrawing or removing an entry blanks its name, description, author and version notes in the tombstone and deletes the version content; the index does not list it. The id, the publisher handle, the times and the hashes stay so the id stays reserved.
- Removal requests go to a GitHub issue on https://github.com/alpadalar/ccinfobar/issues. An admin removes the entry with `catalog admin remove`.

## Runbook

All commands run from `worker/`, so wrangler reads `worker/wrangler.jsonc` with the pinned account id. They need Node 22 or later and a signed-in wrangler (a devDependency: run `npm ci` in the repo root first) (`npx wrangler login`) or `CLOUDFLARE_API_TOKEN` in the environment. The account is the owner's own ("Alp.adalar@gmail.com's Account"); never run them against another account. The database is `ccinfobar-market`.

### Deploy

- GitHub Actions → **Marketplace deploy** → Run workflow, or `gh workflow run market-deploy.yml --ref main`. A push to `main` that touches the Worker files (`src/market/**`, `src/core/entry-keys.ts`, `src/core/sanitize.ts`, `worker/**`, the build scripts or the workflow) deploys too.
- The job runs only on `alpadalar/ccinfobar` and only once the repository variable `MARKET_URL` is set (the Worker URL, https://ccinfobar-market.alp-adalar.workers.dev). It needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, which only the wrangler steps that reach Cloudflare get. The checkout and setup-node actions are pinned by commit SHA (the tag in a comment); to update one, look up the new tag's commit and change both.
- Steps: `npm ci --ignore-scripts`, `npx vitest run test/market`, `node scripts/build.mjs --worker` (writes the gitignored `worker/dist/index.js`), `../node_modules/.bin/wrangler deploy --dry-run` (wrangler 4.154.0 is an exact devDependency, so the locked copy runs and nothing is downloaded while the token is set), record the D1 Time Travel bookmark, apply migrations, deploy, then a smoke check of `$MARKET_URL/v1/meta.json` and `$MARKET_URL/`.
- `wrangler deploy` also sets the cron trigger from `worker/wrangler.jsonc` (`triggers.crons`). Workers Free allows 5 cron triggers per account, and this Worker uses one; check the Worker's **Settings → Triggers** page after the first deploy with it.
- Sign-in answers `503` until the `GITHUB_CLIENT_SECRET` secret is set (see [Tokens and secrets](#tokens-and-secrets)).

### Migrations

- Add `worker/migrations/NNNN_name.sql` with the next number. Migrations are additive only: new tables, columns with defaults, new indexes. Never drop or rename what a deployed Worker reads.
- The workflow applies them with `npx wrangler d1 migrations apply ccinfobar-market --remote`. Wrangler takes no backup of a production D1 database (that was only the old alpha backend), so the step before it prints the current Time Travel bookmark (`d1 time-travel info ccinfobar-market --json`) into the job log. To undo a migration, restore to that bookmark (see [Backups](#backups)); every write after it is lost. Deploy the Worker code that needs a new column only after its migration.
- `npx wrangler d1 migrations list ccinfobar-market --remote` shows what is applied.

### Moderation

Sign in as an admin (`ccinfobar catalog login` with the GitHub account whose id is in `ADMIN_GITHUB_IDS`), then use `ccinfobar catalog admin pending|show|approve|reject|remove|ban|unban|reports|resolve` (see [Reports and moderation from the CLI](#reports-and-moderation-from-the-cli)). Check `catalog admin pending` and `catalog admin reports` regularly; nothing notifies you.

### Backups

Take a backup before any manual change to the database.

- D1 Time Travel keeps a point-in-time history for 7 days on Free. `npx wrangler d1 time-travel info ccinfobar-market` prints the current bookmark; keep it, so you can go back to the state before a restore.
- Restore: `npx wrangler d1 time-travel restore ccinfobar-market --timestamp <ISO time>` (or `--bookmark <bookmark>`). It replaces the whole database, so every write after that time is lost.
- Export a full copy: `npx wrangler d1 export ccinfobar-market --remote --output backup.sql`. Keep exports private: they hold GitHub ids, logins, display names and token hashes.

### Tokens and secrets

Only names of secrets appear in this repository; their values never do. The OAuth client id `Ov23liVCN9Nf6VlLv3St` and the admin id are public.

- **Cloudflare API token** (used by the workflow): create a new token in the dashboard (My Profile → API Tokens → Create Custom Token, account resources limited to the one account; permissions Account · Workers Scripts · Edit, Account · D1 · Edit, Account · Account Settings · Read, User · User Details · Read, User · Memberships · Read), then `gh secret set CLOUDFLARE_API_TOKEN` and delete the old token in the dashboard.
- **GitHub client secret** (required for sign-in): on GitHub, open the OAuth app with client id `Ov23liVCN9Nf6VlLv3St` (Settings → Developer settings → OAuth Apps), generate a client secret, then run `npx wrangler secret put GITHUB_CLIENT_SECRET` and paste it. To rotate, generate a new secret, put it, then delete the old one on GitHub. It is never stored in the repository or the workflow.
- **Marketplace tokens of a publisher**: to sign out a publisher everywhere, take a backup, then `npx wrangler d1 execute ccinfobar-market --remote --command "DELETE FROM tokens WHERE handle = '<handle>'"`. They can sign in again unless banned; ban them to keep them out.

### Free limits

| Resource | Workers Free and D1 Free | Guard |
| --- | --- | --- |
| Worker requests | 100,000 a day, shared by all users | the requests budget above; a `304` counts. The read limiter keeps one address under 86,400 a day, but refused requests (`429`) count too, so the budget is not protected against many addresses or a determined client; Cloudflare then answers error 1027 until the UTC day ends |
| CPU | 10 ms per request | canonical JSON once per write; `MAX_ENTRY_BYTES` |
| D1 rows read | 5 million a day | materialized documents, one row per read; caps read counters, never count rows (see below) |
| D1 rows written | 100,000 a day | write rate limits; a refused or unauthenticated request writes nothing; a distributed flood that stays under the per-address bindings can still spend the quota |
| D1 storage | 500 MB per database | `MAX_DB_BYTES` (400 MiB), `PUBLISHER_BYTES` (20 MiB) and the pending caps (at most about 50 MiB waiting for review) |

Rows read per request:

- A read of an index page, an entry or a version reads one row, plus the publisher row for entries and versions. `GET /v1/me` reads only the caller's live and pending entries, never their tombstones.
- A write looks rows up by key only: the token, the publisher, the rate window, the salt, the entry and the counters. The entry and tombstone caps come from counters that triggers keep up to date in the same transaction (`0002_counts.sql`), so a refused write (`409`, `413`, `429`) or a pending one costs a handful of rows however many entries there are. `test/market/worker-counts.test.ts` checks the query plan of every statement.
- A write that changes the public index (a trusted publish, a new version of a live entry, withdraw, approve, remove, ban) then rebuilds the index: one read of every live summary through a covering index, plus the banned publishers. The rebuilds share a daily budget of `INDEX_REBUILD_ROWS` rows (2 million, 40% of the Free reads). Once it is spent, the index is rebuilt at most once every 10 minutes until the UTC day ends, so new writes show up in the index after up to 10 minutes. A takedown (withdraw, remove, ban) never waits: its rebuild ignores the budget, and if it fails the next read or write rebuilds the index, budget or not, so withdrawn, removed and banned entries leave the index at once (`0006_takedown.sql`). A rebuild first claims a lease and the budget in one guarded update (`0007_rebuild_lease.sql`), so concurrent writes or reads never run rebuilds side by side or all pass a spent budget; a lease left by a rebuild that died expires after 30 seconds. At 5000 live entries that caps rebuilds at about 2.7 million rows a day however many writes come in.

- If large publishes fail with Cloudflare error 1102 (CPU limit), set the var `MAX_ENTRY_BYTES` lower (for example `131072`) in `worker/wrangler.jsonc` and deploy; `meta.json` then advertises the smaller limit, and the Worker refuses larger content with `400 invalid`.
- If the free limits are no longer enough, Workers Paid ($5 a month) raises them without code changes. The marketplace stays non-commercial either way.

## Serving options

The options compared before the decision. Prices and limits as of 2026-10-16, from the official pages linked below. They change often.

| Option | Cost | Auth | Version history | Moderation and takedown | Ops burden |
| --- | --- | --- | --- | --- | --- |
| A. Static index on GitHub Pages, submissions by PR or issue form, validated by GitHub Actions | $0. Pages: 1 GB site, soft 100 GB/month bandwidth, soft 10 builds/hour (not for custom Actions workflows). Actions is free for public repos on standard runners | GitHub account through the PR (2FA, GitHub abuse reporting) | git history plus immutable `<n>.json` files | Maintainer review is the moderation; takedown is a PR that writes a tombstone; fast for a small catalog | Lowest: no server, no secrets |
| **B. Cloudflare Workers + D1** (chosen) | $0 within free limits. Workers Free: 100,000 requests/day, 10 ms CPU per call; Paid from $5/month. D1 Free: 5M rows read/day, 100k rows written/day, 500 MB per database, 5 GB in total | GitHub OAuth device flow (15-minute code, poll at `interval`, `slow_down` adds 5 s) | Server rows per version | A review queue and a report endpoint; the Rate Limiting binding is per location and eventually consistent (10 or 60 s periods) | Medium: a Worker, migrations, the OAuth app |
| C. Supabase (Postgres + Auth + RLS) | Free: 500 MB database, 50,000 MAU, 5 GB egress, 1 GB storage, 2 projects; **free projects pause after 1 week of inactivity**; Pro from $25/month | Built in (GitHub OAuth) | SQL rows | Must be built | Low to medium, but the pause is fatal for a low-traffic catalog |
| D. Deno Deploy + KV | Free: 1M requests/month, 20 GiB egress, 10 h active CPU, KV 1 GiB; Pro $20/month | Must be built | KV | Must be built | Medium; the reference server is Node and would need porting |
| E. Vercel Hobby functions | 1M invocations, 100 GB fast data transfer; **non-commercial personal use only** | Must be built | Needs a database add-on | Must be built | Medium; the non-commercial clause fits this project, but a database add-on is still needed |
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
- Netlify credit-based plans (fetched 2026-10-17): https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/
- Render free instances (fetched 2026-10-17): https://render.com/docs/free
- Cloudflare Pages limits (fetched 2026-10-17): https://developers.cloudflare.com/pages/platform/limits/
- Turso pricing (fetched 2026-10-17): https://turso.tech/pricing

Option B was chosen because it takes writes from the CLI and the editor with a GitHub sign-in, reviews new publishers and takes reports, and stays free for the expected traffic. R2 is not used: it needs a payment method, and the content is small enough for D1. Not recommended: Supabase (pauses after 7 days without activity), Netlify Free (a hard limit of 300 credits a month), Render (sleeps after 15 minutes), Fly.io, Railway and Koyeb (no real free tier), npm as transport (takedown), a self-run VPS (ops burden).

Option A remains possible for a read-only mirror: every read is a `.json` path, so the index and entry files can be served from a static host, and the client already shows "This marketplace is read-only. Submit your entries at {url} instead." for `submit: "pull-request"`.

## Lessons from other ecosystems

- **oh-my-posh** keeps its themes in the main repo and ships them with releases (https://ohmyposh.dev/docs/themes).
- **Starship** presets are community pull requests to `docs/presets` (https://starship.rs/presets/).
- **Raycast**: `npm run publish` opens a PR to `raycast/extensions`, the Raycast team reviews it, and the merge publishes it (https://developers.raycast.com/basics/publish-an-extension).
- **Claude Code plugin marketplaces** are git repos with a `.claude-plugin/marketplace.json` index (https://code.claude.com/docs/en/plugin-marketplaces); this repo already is one.
- **Open VSX** has seen namespace squatting, impersonation and updates pushed with stolen tokens, and moved to pre-publish checks in 2026 (https://thehackernews.com/2026/02/eclipse-foundation-mandates-pre-publish.html, medium confidence). What ccinfobar takes from it: content is data-only, the publisher handle is shown next to the author, every version is hashed, withdrawn ids stay reserved, and a new publisher's first entry is reviewed.

## What shipped

- The Worker and its D1 schema, the deploy workflow with pinned wrangler, and the GitHub OAuth app for the device flow (client id `Ov23liVCN9Nf6VlLv3St`).
- Sign-in and sign-out in the CLI (`catalog login`, `catalog logout`) and the web editor, with the review state shown as "Waiting for review".
- Install from the marketplace in the CLI (`catalog install`) and the editor, with the same consent step as `ccinfobar import` for commands and URLs.
- A 24-hour index cache with one conditional request per refresh, and version documents cached for good.
- Reports and the admin commands.
- The public landing page with the privacy and removal notice.
- https://ccinfobar-market.alp-adalar.workers.dev as the default endpoint, live since 2026-10-18.

## Owner decision

```
Owner decision (decided 2026-10-17)

Serving:
  [ ] A  Static index on GitHub Pages, PR or issue-form submissions
  [x] B  Cloudflare Workers Free + D1 with GitHub device-flow sign-in
  [ ] Self-host the reference server
  [ ] Not now

Terms:               free, open source, non-commercial
Repo or domain name: Worker ccinfobar-market at https://ccinfobar-market.alp-adalar.workers.dev
Moderation owner:    alpadalar, GitHub id 65018489 (ADMIN_GITHUB_IDS)
Removal requests to: a GitHub issue on alpadalar/ccinfobar
Ship as default endpoint in ccinfobar:  [x] yes  [ ] no
Decided on (date):   2026-10-17
```
