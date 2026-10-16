# Catalog

The catalog keeps layouts and looks you can apply in one step: the built-in ones that ship with ccinfobar and the ones you save yourself. Each saved entry has a version history, so you can update it, overwrite it or go back to an older version.

```sh
ccinfobar catalog list                  # your entries, then the built-in ones
ccinfobar catalog apply bundle/nord-minimal
ccinfobar catalog save "My cockpit"     # save your current setup
```

The main surface is the Catalog page in `ccinfobar edit`. Every action also has a CLI command (see [CLI](#cli)). The TUI has no catalog view.

## Kinds

| Kind | What it holds | Config keys it owns |
| --- | --- | --- |
| Preset | Lines and widgets only | `lines`, `align`, `lineAlign`, `overflow`, `autoWrap`, `widthOffset`, `tui` |
| Theme | Theme, style and colors only | `theme`, `style`, `separator`, `separatorColor`, `padding`, `glyphs`, plus the theme itself when it is not a plain built-in |
| Bundle | A preset and a theme together | Both sets |

Personal settings are never stored in an entry, never changed by applying one and never published: `charset`, `icons`, `colorLevel`, `maxWidth`, `glyphMode`, `ambiguousWidth`, `update`, `usageApi`, `savePayload`, `gitHardening`, `gsdAutoLine`, `loadingText`, `budget`, `profiles`, `progress` and `language`. Budgets, profiles and your language stay yours, and your terminal and font settings keep working.

## Where entries come from

- **System** entries are built in and read-only (author `ccinfobar`, version 1). There are 15 curated bundles, such as `bundle/catppuccin-cockpit`, `bundle/nord-minimal`, `bundle/tokyo-night-limits` and `bundle/panel-dashboard`, plus every built-in preset (`preset/<id>`) and theme (`theme/<id>`). Without GSD installed, built-in presets leave out the GSD widgets, and `preset/gsd` and `bundle/solarized-gsd` are hidden.
- **User** entries are the ones you saved. They show their version, author and share state.
- **Preset file** and **Theme file** mark presets and themes in `presets/<id>.json` and `themes/<id>.json` that are not catalog entries: ones saved before the catalog existed, from the Presets dialog or the theme builder, or themes installed by applying an entry. A preset file that carries a theme shows as a bundle, one without as a preset. They have version 1, no history, and are not shared. Their files are never moved. Sharing or restoring one turns it into a catalog entry; the old file stays until you delete the entry. If an entry of the same kind already has that name, the new one gets a free ref such as `bundle/mine-2`, so a name always finds the entry you saved.

## Opening the catalog

Run `ccinfobar edit` and click **Catalog** in the header. The page has these tabs:

| Tab | Shows |
| --- | --- |
| All (default) | Your entries on top, the built-in ones below, each grouped as Bundles, Presets and Themes |
| User | Only your entries |
| System | Only the built-in entries |
| Marketplace | Read-only list of the marketplace entries; only shown when a marketplace endpoint is set |

Every card has a live preview of your config with that entry applied, rendered with sample data. User cards also have Version history, Share or Stop sharing, and Delete buttons; built-in cards have none.

## Applying

Click a card (or press Enter on it) to apply it. Only the keys of the entry's kind change:

- A **preset** replaces your lines and layout and keeps your current theme and style. For the boxed dashboard look, apply the `panel-dashboard` bundle instead of `preset/dashboard`.
- A **theme** replaces your theme and style overrides and keeps your lines. If your widgets have their own colors, the editor asks whether to clear them, as the Theme gallery does.
- A **bundle** replaces both.

In the editor, applying is one undoable step. If you have unsaved changes, it asks first; they stay in the undo history. A saved or pre-catalog entry with command, HTTP or link widgets first lists them, like `catalog apply` in a terminal: **Apply without them** (the default), **Keep them** or **Cancel**. Each target is shown in full exactly as it runs or opens, wrapped and never cut, with invisible, bidi and control characters shown as ⟨U+XXXX⟩ and runs of spaces as ⟨N spaces⟩; a target longer than 2000 characters is too long to review and is always dropped. Built-in entries apply directly. Nothing is written to your config until you click Save. Built-in labels follow the editor language.

A theme or bundle can carry its own theme. Applying it installs that theme into your `themes` folder (this happens at apply time, even before you save the config). If a different theme already uses that id, the new one is installed as `<id>-2` (then `-3`, and so on), and you get a message with the new id. A theme that looks the same (same colors, style, separator, padding and glyphs) is reused, so applying a bundle you saved from your own theme keeps using that theme.

`ccinfobar catalog apply <ref>` applies an entry to the config file directly. It keeps your `language`, backs up the existing config first (`config.json.<time>.bak`) and refuses a config with a syntax error. Command, HTTP and link widgets in an entry go through the same consent step as `ccinfobar import`: a terminal asks, `--allow-commands` keeps them, and `--yes` or a run without a terminal drops them.

## Saving

In the Catalog page, click **Save current as…**. The form has:

| Field | Notes |
| --- | --- |
| Save | **Preset + theme** (default), **Preset only** or **Theme only** |
| Name | 1 to 64 characters |
| Description | Up to 200 characters |
| Author | Up to 64 characters. Prefilled with the author of your last save, and remembered for the next one when you change it. On Update or Overwrite it shows the entry's own author, which stays unless you type another |
| Share to marketplace | On by default. Without a marketplace endpoint the entry waits to publish and nothing is sent |

When you save a theme or bundle, a built-in theme without overrides is stored as a reference to its id. Anything else (your own theme, a built-in with style overrides, or a user theme that replaces a built-in id) is stored as the full theme, so it looks the same on another machine. Your charset and glyph mode are not baked in; the machine that applies it uses its own.

### Update or overwrite

A name that already exists for the same kind (compared ignoring case and accents, so `Çalışma` and `calisma` clash) gives two choices:

| Choice | Effect | Version |
| --- | --- | --- |
| Update | Adds the current setup as a new version; the history is kept | `vN+1` |
| Overwrite | Replaces the content and note of the latest version in place; the history marks it as overwritten | stays `vN` |

Both take an optional note ("what changed") and keep the entry's description and share setting unless you change them; in the editor the share switch shows the entry's setting. The change is one write, so the entry's backup (`.bak`) still holds the version an overwrite replaced. The same name with a different kind is a separate entry. On a marketplace, entries whose names map to the same id get the kind added (`nord-preset`, `nord-theme`), and a number after that when names differ only in punctuation or accents (`nord-preset-2`, oldest first).

If the editor and the CLI change the same entry at once, only one writes at a time (a short lock in the catalog folder), and the second write is refused with "This entry changed since you opened it; reload and try again", so nothing is lost. If another ccinfobar holds the lock for more than 3 s, a write stops with "Another ccinfobar window is changing the catalog; try again in a moment".

## History and restore

**Version history** on a user card lists every version, newest first, with its time, note, a Current tag on the latest one, and "restored from vN" or "overwritten" where they apply. **Restore** on an older version adds a copy of it as a new version, marked "restored from vN"; the versions in between stay.

## Sharing and publishing

The share switch decides whether an entry should go to a marketplace. No marketplace endpoint is set by default, and with none set nothing leaves your machine: shared entries just wait.

| State | Meaning |
| --- | --- |
| Not shared | Share is off; the entry stays local |
| Waiting to publish | Share is on; it is sent on your next publish |
| Published vN | Version N is on the marketplace |
| Changed since publish | You updated or overwrote it after publishing; the next publish sends the change |
| Waiting to withdraw | You stopped sharing a published entry; the next publish withdraws it |
| Withdrawn | It was withdrawn from the marketplace |

- Stop sharing a "Waiting to publish" entry and it goes back to Not shared. The marketplace keeps withdrawn ids reserved, so sharing a withdrawn entry again is refused (in the editor and with `catalog share` or `catalog save --share`) with "withdrawn ids stay reserved. Save it under a new name to publish it again"; it never sits in Waiting to publish.
- Only the latest version is sent; your local history stays local. Text goes out as the marketplace stores it: control characters, escape sequences and bidi marks are removed and tabs and newlines become spaces. Your local entry keeps the original, and it stays "Published vN" until you really change it.
- Publishing only happens when you ask for it: `ccinfobar catalog publish`, or **Publish…** in the Catalog page. Both first show exactly what will be sent (action, name, kind, description, author and the content as JSON) and name the endpoint. The review first reads the marketplace's `meta.json`, so it shows the action the server will really do (New version where the server does not allow Replace latest) and, before a first publish, the publisher handle that gets registered. The CLI sends only after you confirm in a terminal or pass `--yes`, and then plans again: if anything changed since the list was shown, nothing is sent and the new list is shown (a terminal asks again; otherwise it exits 1). The editor sends only from the Publish button in that review, and refuses if the entries changed since you opened it. Either way, each entry is sent only while it is exactly as reviewed. Nothing is ever published in the background or during a status line refresh.
- Without an endpoint, the Catalog page shows no Publish button and no Marketplace tab, and says that shared entries wait.
- Deleting a published entry does not remove the published copy, and afterwards ccinfobar can no longer withdraw it. Stop sharing it and publish first to withdraw it. The editor's delete dialog and `catalog delete` say so (the CLI also after `--yes`, and `--json` adds `published: true`).

Set an endpoint with `ccinfobar catalog endpoint <url>` (https only; http only for `localhost`, `127.0.0.1` and `[::1]`), or for one run with the `CCINFOBAR_MARKETPLACE_URL` environment variable, which wins over the stored one. See [MARKETPLACE.md](MARKETPLACE.md) for the protocol, the reference server and what is planned for a real marketplace.

## Files

Everything lives in the ccinfobar config folder (`~/.config/ccinfobar` on Linux and macOS, `%APPDATA%\ccinfobar` on Windows, or `CCINFOBAR_CONFIG_DIR`). Nothing goes into Claude Code's settings.

| File | What it is |
| --- | --- |
| `catalog/entries/<id>.json` | One file per entry. Ids are `u-` plus 12 hex characters, so names never become file names |
| `catalog/entries/<id>.json.bak` | The previous content of the entry file, written before every change |
| `catalog/.lock` | Held for a moment while ccinfobar writes an entry, the profile or a token, so the editor and the CLI never write at once. A lock older than 10 s is taken over |
| `catalog/trash/` | Deleted entries and copies of deleted pre-catalog files. The newest 20 are kept |
| `catalog/profile.json` | Your remembered author, the marketplace endpoint and your publisher handle for each marketplace |
| `catalog/credentials.json` | Publisher tokens per marketplace endpoint (origin and path, so two marketplaces on one host never share a token), only after a publish. Mode 0600 on Linux and macOS; on Windows the mode bits do not apply and the file is protected by the access rules of your user profile folder |
| `presets/<id>.json`, `themes/<id>.json` | Presets and themes saved before the catalog. Never moved; `themes/` is also where applied themes are installed, because the status line reads themes from there |

Every write is atomic. Keys that a newer ccinfobar version adds to an entry file are kept at every level (the entry, its share state and every version) when an older one rewrites it; only an overwrite replaces the content of the version it overwrites. An entry file is limited to 1 MiB; a save that would go over it is refused instead of dropping history. Delete moves the file to the trash instead of removing it, and deleting an entry that came from a pre-catalog file also moves that file to the trash, except a theme file your saved config uses (directly or as the base of its theme): that file stays, and the CLI and the editor say so.

## CLI

Refs name an entry:

- a built-in entry: `bundle/nord-minimal`, `preset/cockpit`, `theme/nord`
- your entry: its id (`u-3f9a1c2b7d4e`) or `<kind>/<slug>` (`bundle/nord-cockpit`)
- a pre-catalog file: `legacy:preset/<id>` or `legacy:theme/<id>`
- a bare name or slug, when it matches only one entry (`nord-cockpit`, `"Nord cockpit"`). An ambiguous one such as `minimal` lists the matching refs and exits 1.

Your own `<kind>/<slug>` wins over a built-in ref with the same text.

| Command | Does |
| --- | --- |
| `ccinfobar catalog list [--kind preset\|theme\|bundle] [--user\|--system] [--json]` | Your entries first, then the built-in ones, grouped by kind, with ref, version, author and share state |
| `ccinfobar catalog show <ref> [--scenario <name>] [--width <n>] [--json]` | Details and a preview of your config with the entry applied. Writes nothing |
| `ccinfobar catalog history <ref> [--json]` | Versions with time, note, restores and overwrites |
| `ccinfobar catalog apply <ref> [--allow-commands] [--yes] [--dry-run] [--json]` | Apply to the config file (backup first) |
| `ccinfobar catalog save <name> [--kind bundle\|preset\|theme] [--description <text>] [--author <name>] [--note <text>] [--no-share] [--update\|--overwrite] [--dry-run] [--json]` | Save the current setup. Kind defaults to bundle, share is on unless `--no-share`. `--author` is remembered |
| `ccinfobar catalog restore <ref> <version> [--dry-run] [--json]` | Restore an older version as a new one (`2` or `v2`) |
| `ccinfobar catalog share\|unshare <ref> [--dry-run] [--json]` | Turn sharing on or off |
| `ccinfobar catalog delete <ref> [--yes] [--dry-run] [--json]` | Move an entry to the trash. Asks in a terminal; needs `--yes` otherwise |
| `ccinfobar catalog author [<name>] [--dry-run] [--json]` | Show or set the remembered author |
| `ccinfobar catalog endpoint [<url>\|--clear] [--dry-run] [--json]` | Show, set or remove the marketplace endpoint. Only checks the URL; sends nothing |
| `ccinfobar catalog publisher [<handle>\|--forget] [--dry-run] [--json]` | Show or set the publisher handle a first publish registers on the current endpoint (lowercase letters, digits and hyphens; without one, the author as a slug). `--forget` drops the handle and token for that endpoint, so the next publish registers again. Sends nothing |
| `ccinfobar catalog publish [<ref>...] [--yes] [--dry-run] [--json]` | Show what waits to publish, then send it after confirmation |
| `ccinfobar catalog list --remote [--kind ...] [--json]` | Read-only list of the marketplace entries |
| `ccinfobar catalog show <publisher/slug> --remote [--json]` | A marketplace entry with its versions and the commands or URLs it would run or open |

Examples:

```sh
ccinfobar catalog list --kind bundle --system
ccinfobar catalog show bundle/tokyo-night-limits --scenario near-5h-limit
ccinfobar catalog history nord-cockpit
ccinfobar catalog apply bundle/panel-dashboard --dry-run
ccinfobar catalog save "Nord cockpit" --description "My daily layout" --author Alperen
ccinfobar catalog save "Nord cockpit" --update --note "wider context bar"
ccinfobar catalog save "Quiet colors" --kind theme --no-share
ccinfobar catalog restore nord-cockpit v1
ccinfobar catalog unshare bundle/nord-cockpit
ccinfobar catalog delete nord-cockpit --yes
ccinfobar catalog author "Alperen"
ccinfobar catalog endpoint https://catalog.example.com
ccinfobar catalog publisher alperen
ccinfobar catalog publish --dry-run
```

- Without `--update` or `--overwrite`, a name clash asks in a terminal and exits 1 otherwise.
- `--dry-run` shows what would happen and writes nothing; `publish --dry-run` sends nothing (it reads the marketplace's `meta.json` to show the real actions).
- `--json` prints one English object with `schema: 1`, whatever the language, and never prompts.
- Unknown or ambiguous refs, a name clash without a terminal, a broken config and a publish or `--remote` without an endpoint exit 1.
- `catalog publish` and `--remote` run even with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set, because you asked for them; the publish confirmation says so.
