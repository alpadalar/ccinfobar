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
| `catppuccin` | capsule | Mocha pastels in rounded pills |
| `bubblegum` | capsule | Bright pills in the 16 terminal colors |

Powerline and capsule themes need a [Nerd Font](https://www.nerdfonts.com/). Themes using hex colors look best in a truecolor terminal; ccinfobar converts them to the nearest 256 or 16 colors otherwise.

## Styles

| Style | Rendering |
| --- | --- |
| `text` | Colored text on the terminal background, joined by the separator |
| `blocks` | Each widget on a colored background with padding |
| `powerline` | Blocks joined by arrow glyphs; neighbors with the same color get a thin arrow |
| `capsule` | Each widget in a rounded pill |

Any theme works in any style. Set `"style"` in your config to keep a theme's colors but change the shape, e.g. `nord` colors as capsules:

```json
{ "theme": "nord", "style": "capsule" }
```

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
| `style` | `text`, `blocks`, `powerline` or `capsule` |
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
