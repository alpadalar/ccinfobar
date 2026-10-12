# Themes

A theme decides how the whole status line looks: whether widgets are colored text or colored blocks, how they are joined, and which colors they use. Pick one the way you would pick an oh-my-zsh theme, then tweak or replace it.

```sh
ccinfobar themes            # preview every theme in your terminal
ccinfobar theme nord        # switch
```

Both editors have a theme gallery with live previews: **Theme** in `ccinfobar edit`, `T` in `ccinfobar tui`.

Named colors such as `red` or `brightBlue` look different in every terminal color scheme, while hex colors stay the same. Pick your terminal's colors next to the editor preview (or let `ccinfobar edit` detect them) so theme previews match your terminal.

## Built-in themes

| Theme | Style | Look |
| --- | --- | --- |
| `classic` (default) | text | Each widget in its own color, thin bar separators |
| `minimal` | text | Quiet gray and white, wide spacing |
| `mono` | text | No colors, dot separators |
| `neon` | text | Vivid truecolor text per category, bold |
| `pastel` | text | Soft pastel text per category |
| `amber` | text | Retro amber terminal |
| `matrix` | text | Green phosphor shades |
| `blocks` | blocks | Solid colored blocks per category |
| `slate` | blocks | Colored text on a single dark slate background |
| `paper` | blocks | Dark text on light blocks, for light terminals |
| `powerline` | powerline | Classic arrows in the 16 terminal colors |
| `nord` | powerline | Arctic blues |
| `dracula` | powerline | Dracula palette |
| `gruvbox` | powerline | Warm retro groove |
| `tokyo-night` | powerline | Neon city night |
| `solarized` | powerline | Solarized accents |
| `monochrome` | powerline | Shades of gray |
| `dark` | powerline | Dark grays with a rust directory (from claude-powerline) |
| `light` | powerline | Bright segments for light terminals (from claude-powerline) |
| `rose-pine` | powerline | Muted pine and rose tones (from claude-powerline) |
| `catppuccin` | capsule | Mocha pastels in rounded pills |
| `bubblegum` | capsule | Bright pills in the 16 terminal colors |
| `panel` | tui | Rounded box panel with category colors |

Powerline arrows and capsule caps come from [Nerd Fonts](https://www.nerdfonts.com/). Without one, use `"charset": "unicode"` (plain colored blocks and half-block caps) or `"text"` (ASCII). The default `"auto"` already does this in Apple Terminal. Themes using hex colors look best in a truecolor terminal; ccinfobar converts them to the nearest 256 or 16 colors otherwise.

## Styles

| Style | Rendering |
| --- | --- |
| `text` | Colored text on the terminal background, joined by the separator |
| `blocks` | Each widget on a colored background with padding |
| `powerline` | Blocks joined by arrow glyphs; neighbors with the same color get a thin arrow |
| `capsule` | Each widget in a rounded pill |
| `tui` | A bordered panel; each config line is a row, or lay it out with a responsive grid |

Any theme works in any style. Set `"style"` in your config to keep a theme's colors but change the shape, e.g. `nord` colors as capsules:

```json
{ "theme": "nord", "style": "capsule" }
```

## Panel style

The `tui` style (theme `panel`, or `"style": "tui"` with any theme) draws a box around the status line:

```
╭─ Opus 5.5 ─────────────────────────────────── ccinfobar ─╮
│ Opus 5.5  acme-app  feat/statusline  Ctx ███░░░░░░░ 34%  │
├──────────────────────────────────────────────────────────┤
│ v1.2 Billing  █████░░░░░ 50%  Phase 4/6  plans 3/5       │
╰──────────────────────────────────────────────────────────╯
```

Without further settings each config line becomes a row. Configure it under `tui`:

| Field | Default | Description |
| --- | --- | --- |
| `box` | `"rounded"` | `rounded`, `square`, `heavy`, `double`, `dashed`, `heavy-dashed`, `mixed`, `ascii`, `invisible`, or an object with `topLeft`, `topRight`, `bottomLeft`, `bottomRight`, `horizontal`, `vertical`, `teeLeft`, `teeRight` |
| `fitContent` | `false` | Shrink to the content instead of filling the terminal width |
| `minWidth` / `maxWidth` | `32` / none | Width limits |
| `padding` | `1` | Spaces inside the border |
| `columnGap` | theme separator | Text between widgets or grid columns |
| `dividers` | `true` | Divider rows between config lines (without breakpoints) |
| `divider` | box line | Character for divider rows |
| `title.left` / `title.right` | `"{model}"` / `"ccinfobar"` | Text in the top border; `right: false` hides it |
| `footer.left` / `footer.right` | none | Text in the bottom border |
| `templates` | | Named cells built from several widgets |
| `breakpoints` | | Responsive grid layouts |

Title, footer and template text can contain `{widget}` tokens: a widget type (`{model}`, `{gsd-phase}`), a widget id from your config, or either one with `.label` / `.value` (`{context-bar.value}`). Widgets do not have to be on a line to be used as tokens.

### Grid layouts

```json
{
  "theme": "panel",
  "tui": {
    "box": "heavy",
    "title": { "left": "{model} · {effort}", "right": "{cwd}" },
    "footer": { "left": "{session-cost}" },
    "breakpoints": [
      {
        "minWidth": 80,
        "areas": [
          "git-branch  git-branch  git-changes",
          "---",
          "context-bar.label  context-bar.value  .",
          "gsd-phase  gsd-plans  gsd-next"
        ],
        "columns": ["auto", "auto", "1fr"],
        "align": ["left", "left", "right"]
      },
      { "minWidth": 0, "areas": ["git-branch", "context-bar", "gsd-phase"] }
    ]
  }
}
```

- The widest breakpoint whose `minWidth` fits the panel wins.
- `areas` rows hold space separated cell names. Repeat a name to span columns, use `.` for an empty cell and `---` for a divider row.
- `columns`: `auto` (widest content), `1fr`/`2fr` (share of the remaining space) or a fixed number. The last column defaults to `1fr`.
- `align`: `left`, `center` or `right` per column.
- Cells whose widget has nothing to show become empty; empty rows and leftover dividers are removed, so a GSD row disappears outside GSD projects.
- `templates` combine widgets in one cell: `"cost": { "items": ["{session-cost}", "{cost-rate}"], "gap": 1, "justify": "between" }`, then use `cost` in `areas`.

## Character sets

`"charset": "unicode"` keeps colors, bars and boxes but drops Nerd Font glyphs: powerline segments touch without arrows, capsules use `▐` and `▌` as caps, and Nerd icons fall back to text labels. `"auto"` (default) picks `unicode` in Apple Terminal and `nerd` elsewhere.

`"charset": "text"` makes the whole status line plain ASCII: bars use `=` and `-`, powerline arrows and capsule caps are dropped (blocks stay colored), panel boxes use `+-|`, and Nerd Font or emoji icons fall back to text labels.

## Adjusting a theme without making a new one

These config fields override the theme when set, and fall back to it when removed:

| Field | Example |
| --- | --- |
| `style` | `"blocks"` |
| `separator` | `" / "` |
| `separatorColor` | `"#5c5f77"` |
| `padding` | `2` |
| `glyphs` | `{ "separator": "", "endCap": "" }` |

Per-widget `color`, `background` and `bold` always win over the theme. `ccinfobar theme <id>` clears the overrides above so the new theme shows as designed.

## Creating your own theme

Themes are JSON files in the `themes` folder next to your config:

| Platform | Folder |
| --- | --- |
| Linux, macOS | `~/.config/ccinfobar/themes/` |
| Windows | `%APPDATA%\ccinfobar\themes\` |

The file name is the theme id. Start from an existing theme:

```sh
ccinfobar theme new sunset --from dracula
# edit ~/.config/ccinfobar/themes/sunset.json
ccinfobar theme sunset
```

You can also save your current look from the editors with **Save as my theme**.

A theme only needs the fields that differ from the theme it `extends` (default `classic`):

```json
{
  "$schema": "https://raw.githubusercontent.com/alpadalar/ccinfobar/main/schema/theme.schema.json",
  "name": "Sunset",
  "description": "Warm capsules",
  "extends": "catppuccin",
  "colors": {
    "on": "#1a1b26",
    "categories": {
      "gsd": "#ff9e64",
      "git": { "fg": "#ffffff", "bg": "#f7768e" }
    }
  }
}
```

A file with the same name as a built-in theme (e.g. `nord.json`) replaces it and extends it automatically.

### Theme fields

| Field | Description |
| --- | --- |
| `name`, `description`, `author` | Shown in the galleries |
| `extends` | Theme to start from |
| `style` | `text`, `blocks`, `powerline`, `capsule` or `tui` |
| `separator` | Text between widgets (text and blocks styles) |
| `padding` | Spaces inside blocks, 0 to 4 |
| `bold` | Make all widgets bold |
| `statusColors` | In text style, let widgets such as `context-bar` turn green, yellow or red by threshold (default `true`) |
| `glyphs.separator`, `glyphs.thin` | Powerline arrows between different and same colors |
| `glyphs.startCap`, `glyphs.endCap` | Line or pill caps |
| `colors.mode` | `widget`: each widget's default color. `category`: one color per widget category. `cycle`: rotate through `colors.cycle`. |
| `colors.categories` | Colors per category: `session`, `context`, `tokens`, `cost`, `limits`, `gsd`, `git`, `workspace`, `system`, `custom`, `layout` |
| `colors.cycle` | List of colors to rotate through |
| `colors.fg` | Default text color |
| `colors.bg` | Default block background |
| `colors.on` | Text color on colored blocks |
| `colors.muted` | Separator color |

Each color in `categories` and `cycle` is either a string or an object:

- `"#7aa2f7"`: text color in the text style, block color with `colors.on` text in block styles
- `{ "fg": "#c0caf5", "bg": "#414868" }`: explicit text and block colors

Colors accept names (`red`, `brightBlue`), `ansi256:208` and hex. The theme schema gives you completion and validation in VS Code.

## Sharing themes

A theme is a single JSON file, so sharing it is copying it into someone else's `themes` folder. Pull requests that add well-designed themes to the built-in set are welcome; see [CONTRIBUTING.md](../CONTRIBUTING.md).
