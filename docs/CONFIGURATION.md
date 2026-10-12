# Configuration

ccinfobar reads a single JSON file. You rarely need to edit it by hand: `ccinfobar edit` (browser) and `ccinfobar tui` (terminal) write it for you. This page documents every field for those who prefer a text editor or want to keep the file in their dotfiles.

## Location

| Platform | Default path |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/ccinfobar/config.json` (falls back to `~/.config/ccinfobar/config.json`) |
| macOS | `~/.config/ccinfobar/config.json` |
| Windows | `%APPDATA%\ccinfobar\config.json` |

Override it with:

- `--config <file>` on any command
- `CCINFOBAR_CONFIG=<file>` for the file
- `CCINFOBAR_CONFIG_DIR=<dir>` for the directory

To use a project-specific layout, point the Claude Code `statusLine` command at a different file, e.g. `ccinfobar --config ./.claude/infobar.json`.

## Editor support

The file declares a JSON schema, so VS Code and other editors offer completion and validation:

```json
{
  "$schema": "https://raw.githubusercontent.com/alpadalar/ccinfobar/main/schema/config.schema.json"
}
```

## Example

```json
{
  "version": 1,
  "lines": [
    [
      { "id": "model-1", "type": "model" },
      { "id": "cwd-1", "type": "cwd", "options": { "style": "tilde" } },
      { "id": "git-branch-1", "type": "git-branch", "color": "magenta" },
      { "id": "flex-1", "type": "flex" },
      { "id": "context-bar-1", "type": "context-bar", "options": { "width": 12 } }
    ],
    [
      { "id": "gsd-milestone-1", "type": "gsd-milestone", "bold": true },
      { "id": "gsd-phase-1", "type": "gsd-phase" },
      { "id": "gsd-plans-1", "type": "gsd-plans", "color": "#7aa2f7" }
    ]
  ],
  "separator": " │ ",
  "separatorColor": "brightBlack",
  "icons": "text",
  "powerline": { "enabled": false, "theme": "default" }
}
```

## Top-level fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | `1` | `1` | Config format version |
| `lines` | `Widget[][]` | see presets | One array per status line, top to bottom. Lines with nothing to show are skipped. |
| `separator` | string | `" │ "` | Text placed between widgets. Use `""` and `separator` widgets for full manual control. |
| `separatorColor` | color | `"brightBlack"` | Color of the separator |
| `padding` | 0 to 4 | `1` | Spaces on each side of a segment in powerline mode |
| `icons` | `nerd` \| `emoji` \| `text` \| `none` | `"text"` | What a widget shows before its value: Nerd Font glyph, emoji, short text label or nothing |
| `colorLevel` | `auto` \| 0 \| 1 \| 2 \| 3 | `"auto"` | 0 no color, 1 basic 16, 2 256 colors, 3 truecolor. `auto` honors `NO_COLOR`, `FORCE_COLOR` and `COLORTERM`. |
| `maxWidth` | `auto` \| number | `"auto"` | Lines longer than this are truncated with `…`. `auto` uses the detected terminal width. |
| `widthOffset` | number | `4` | Columns subtracted from the terminal width in `auto` mode, leaving room for Claude Code's own padding |
| `savePayload` | boolean | `true` | Store the latest Claude Code payload so the editors can preview with your real session data |
| `powerline` | object | see below | Powerline mode |

### `powerline`

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Render widgets as colored segments joined by arrows |
| `theme` | `"default"` | `default`, `nord`, `dracula`, `gruvbox`, `tokyo-night`, `catppuccin`, `solarized`, `monochrome` |
| `separator` | `""` (U+E0B0) | Glyph between segments |
| `startCap` | `""` | Glyph before the first segment, e.g. `""` (U+E0B6) for rounded caps |
| `endCap` | `""` (U+E0B0) | Glyph after the last segment |

Powerline glyphs need a [Nerd Font](https://www.nerdfonts.com/) in your terminal. Widgets without a `background` take the next theme color in order.

## Widget fields

Every entry in `lines` is a widget instance:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Unique id. The editors generate it. |
| `type` | string | Widget type, see [WIDGETS.md](WIDGETS.md) |
| `color` | color | Text color. Overrides the widget default and any threshold color. |
| `background` | color | Background color |
| `bold`, `dim`, `italic` | boolean | Text attributes |
| `label` | string | Replaces the default label, e.g. `"ctx "`. `""` removes it. |
| `raw` | boolean | Value only, no label or icon |
| `merge` | boolean | Glue the next widget directly to this one, with no separator |
| `options` | object | Widget specific options, listed in [WIDGETS.md](WIDGETS.md) |

## Colors

Any of these work wherever a color is accepted:

- Named: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white` and their `bright*` variants (`brightBlack` is a good gray)
- 256 palette: `ansi256:208` or just `208`
- Hex: `#ff8800` or `#f80`
- `default` to fall back to the terminal color

Colors are converted down automatically when the terminal supports fewer colors.

## Layout tips

- Put a `flex` widget between two groups to push the second group to the right edge.
- Set `merge: true` on a `text` widget to attach a custom prefix to the next widget.
- Keep GSD widgets on their own line: the whole line disappears outside GSD projects.
- `raw: true` plus a `text` widget lets you build any label style you like.
