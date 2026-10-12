# GSD integration

[GSD (Get Shit Done)](https://github.com/gsd-build/get-shit-done) plans work as milestones, phases and plans under a `.planning/` folder. GSD ships its own single-line status line. ccinfobar reads the same files and exposes each piece as a separate widget, so you can place, color and combine them freely next to everything else.

Outside GSD projects GSD widgets show `—`. If you would rather not see them there, put them on their own line and turn on **Hide when no data** (`hideEmpty: true`); the line then disappears when you work elsewhere.

## Quick start

```sh
ccinfobar init gsd --force   # GSD focused preset
ccinfobar preview            # see it with sample data
```

Or open `ccinfobar edit` and drag widgets from the **GSD** category.

If you previously used GSD's own status line (`~/.claude/hooks/gsd-statusline.js`), `ccinfobar install` replaces it in `~/.claude/settings.json`. Your previous settings are backed up first. GSD's other hooks keep working.

## Widgets

| Widget | Example | Shows |
| --- | --- | --- |
| `gsd-milestone` | `v1.2 Billing` | Current milestone version and name |
| `gsd-milestone-progress` | `█████░░░░░ 50%` | Milestone completion; `showCounts` adds `3/6 phases` |
| `gsd-phase` | `Phase 4/6 Invoice export` | Current phase number, total and name |
| `gsd-status` | `executing` | Lifecycle stage, colored by stage |
| `gsd-plans` | `plans 3/5` | Plans finished in the current phase |
| `gsd-plan-progress` | `██████░░░░ 60%` | Same as a bar |
| `gsd-next` | `next: /gsd-execute-phase 4` | The command to run next |
| `gsd-workstream` | `ws billing` | Active workstream |
| `gsd-blockers` | `⚠ 1 concern` | Open items under Blockers/Concerns in `STATE.md` |
| `gsd-todos` | `2 todos` | Pending todos in `STATE.md` |
| `gsd-requirements` | `req 14/22` | Checked requirements in `REQUIREMENTS.md` |
| `gsd-last-command` | `/gsd-execute-phase` | Last GSD slash command in this session |
| `gsd-update` | `⬆ GSD 1.41.0` | A GSD update is available, or hooks are stale |
| `gsd-task` | `Wiring GSD widgets…` | The in-progress todo of the current session |
| `gsd-summary` | `v1.2 Billing [█████░░░░░] 50% · Phase 4 executing` | One segment that mirrors GSD's own status line |

Full option lists are in [WIDGETS.md](WIDGETS.md#gsd).

## Where the data comes from

ccinfobar only reads files, never runs GSD or any other process, and finishes in a few milliseconds.

| Data | Source |
| --- | --- |
| Project root | Walks up from the working directory to the nearest `.planning/` (up to 10 levels, stops at your home directory) |
| Workstream | `GSD_WORKSTREAM`, otherwise `.planning/active-workstream`; then reads `.planning/workstreams/<name>/` |
| Milestone, status, active phase, next action | `STATE.md` frontmatter (`milestone`, `milestone_name`, `status`, `active_phase`, `next_action`, `next_phases`), otherwise the `Phase:` / `Status:` lines in the body |
| Phases | Checkboxes in `ROADMAP.md`; phases of shipped milestones inside `<details>` blocks are excluded |
| Plans | `phases/NN-slug/*-PLAN.md` vs `*-SUMMARY.md` (nested `plans/` folders work too); a summary marks a plan as done |
| Milestone percent | `min(done plans / plans, done phases / phases)`, the same formula GSD uses, computed from disk |
| Blockers, todos | Bullets under `Blockers/Concerns` and `Pending Todos` in `STATE.md` |
| Requirements | Checkboxes in `REQUIREMENTS.md` |
| Update notice | GSD's update check cache in `~/.cache/gsd/gsd-update-check.json` |
| Last command, task | The Claude Code session transcript |

Counts come from the files on disk instead of `STATE.md` frontmatter, because the frontmatter can lag behind. A project whose frontmatter still says 63% but whose plans all have summaries shows 100%.

## Recipes

Compact single line:

```json
[
  { "id": "m", "type": "gsd-milestone", "options": { "showName": false } },
  { "id": "p", "type": "gsd-phase", "options": { "showName": false } },
  { "id": "s", "type": "gsd-status" },
  { "id": "pl", "type": "gsd-plans", "raw": true }
]
```

`v1.2 │ Phase 4/6 │ executing │ 3/5`

Progress-focused line:

```json
[
  { "id": "m", "type": "gsd-milestone", "bold": true },
  { "id": "mp", "type": "gsd-milestone-progress", "options": { "width": 20, "style": "thin", "showCounts": true } },
  { "id": "f", "type": "flex" },
  { "id": "n", "type": "gsd-next", "color": "brightBlack" }
]
```

Older GSD versions use `/gsd:command` instead of `/gsd-command`. Set `"slashPrefix": "/gsd:"` on `gsd-next` if that is what you type.
