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
  "theme": "nord",
  "style": "capsule",
  "icons": "text"
}
```

## Top-level fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | `1` | `1` | Config format version |
| `lines` | `Widget[][]` | see presets | One array per status line, top to bottom. Lines with nothing to show are skipped. |
| `theme` | string | `"classic"` | Built-in theme id or the name of your own theme file. See [THEMES.md](THEMES.md). |
| `style` | `text` \| `blocks` \| `powerline` \| `capsule` | theme | Overrides the theme style |
| `separator` | string | theme | Overrides the text between widgets. Use `""` and `separator` widgets for full manual control. |
| `separatorColor` | color | theme | Overrides the separator color |
| `padding` | 0 to 4 | theme | Overrides the spaces inside blocks |
| `glyphs` | object | theme | Overrides `separator`, `thin`, `startCap` and `endCap` glyphs of powerline and capsule styles |
| `icons` | `nerd` \| `emoji` \| `text` \| `none` | `"text"` | What a widget shows before its value: Nerd Font glyph, emoji, short text label or nothing |
| `colorLevel` | `auto` \| 0 \| 1 \| 2 \| 3 | `"auto"` | 0 no color, 1 basic 16, 2 256 colors, 3 truecolor. `auto` honors `NO_COLOR`, `FORCE_COLOR` and `COLORTERM`. |
| `maxWidth` | `auto` \| number | `"auto"` | Lines longer than this are truncated with `…`. `auto` uses the detected terminal width. |
| `widthOffset` | number | `4` | Columns subtracted from the terminal width in `auto` mode, leaving room for Claude Code's own padding |
| `savePayload` | boolean | `true` | Store the latest Claude Code payload so the editors can preview with your real session data |

Fields marked "theme" are optional. Leave them out to use the theme's value.

## Widget fields

Every entry in `lines` is a widget instance:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Unique id. The editors generate it. |
| `type` | string | Widget type, see [WIDGETS.md](WIDGETS.md) |
| `color` | color | Text color. Overrides the theme and any threshold color. |
| `background` | color | Background color. In block styles this is the block color. |
| `bold`, `dim`, `italic` | boolean | Text attributes (`bold` overrides the theme) |
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
