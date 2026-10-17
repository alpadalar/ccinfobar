# Import fixtures

Hand-written fixtures in each tool's documented format; no upstream code or secrets.

| Fixture | Tool | Modelled on (upstream file) | Upstream license |
| --- | --- | --- | --- |
| `ccstatusline-settings.json` | [sirmalloc/ccstatusline](https://github.com/sirmalloc/ccstatusline) | `src/types/Settings.ts` | MIT |
| `ccstatusline-link.json` | [sirmalloc/ccstatusline](https://github.com/sirmalloc/ccstatusline) | `src/types/Settings.ts` | MIT |
| `claude-powerline.json` | [Owloops/claude-powerline](https://github.com/Owloops/claude-powerline) | `README.md` (configuration), `src/config/defaults.ts` | MIT |
| `ccometixline.toml` | [Haleclipse/CCometixLine](https://github.com/Haleclipse/CCometixLine) | `src/config/types.rs`, `src/config/defaults.rs` | MIT |
| `ccometixline-inline.toml` | [Haleclipse/CCometixLine](https://github.com/Haleclipse/CCometixLine) | `src/config/types.rs` (inline-table form) | MIT |
| `ccline-theme.toml` | [Haleclipse/CCometixLine](https://github.com/Haleclipse/CCometixLine) | `src/ui/themes/presets.rs` | MIT |
| `cship.toml` | [stephenleo/cship](https://github.com/stephenleo/cship) | `cship.toml`, `docs/configuration.md` | Apache-2.0 |
| `cship-wrapperless.toml` | [stephenleo/cship](https://github.com/stephenleo/cship) | `docs/configuration.md` (legacy file without `[cship]`) | Apache-2.0 |
| `starship.toml` | [stephenleo/cship](https://github.com/stephenleo/cship) | `docs/configuration.md` (`[cship]` in `starship.toml`) | Apache-2.0 |
| `claude-hud.json` | [jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud) | `src/config.ts`, `README.md` | MIT |
| `claude-hud.override.json` | [jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud) | `src/config.ts` (`claude-hud.json` override) | MIT |
| `best-claude-hud.toml` | [GaoSSR/best-claude-hud](https://github.com/GaoSSR/best-claude-hud) | `src/config/types.rs`, `src/ui/themes/presets.rs` | Apache-2.0 |
| `byebyecode.toml` | [byebye-code/byebyecode](https://github.com/byebye-code/byebyecode) | `src/config/types.rs` (`line_break_after`, 88code segments) | MIT |
| `ccstatusline-new-widgets.json` | [sirmalloc/ccstatusline](https://github.com/sirmalloc/ccstatusline) | `src/utils/widget-manifest.ts`, `src/types/Settings.ts` | MIT |
| `claudebar.toml` | [micschr0/claudebar](https://github.com/micschr0/claudebar) | `README.md` (Configure), `src/model/config.rs` | MIT |
| `statusline-pro.toml` | [Wangnov/claude-code-statusline-pro](https://github.com/Wangnov/claude-code-statusline-pro) | `configs/config.template.toml`, `configs/components/usage.template.toml` (widget shape) | MIT |
| `claude-code-statusline.toml` | [rz1989s/claude-code-statusline](https://github.com/rz1989s/claude-code-statusline) | `examples/Config.toml` (theme and display sections, a weather plugin key) | MIT |
| `starship-claude-minimal.toml` | [martinemde/starship-claude](https://github.com/martinemde/starship-claude) | `plugin/templates/minimal-text.toml` + `plugin/templates/palettes/catppuccin_mocha.toml` (what `configure.sh --write` writes) | MIT |
| `starship-claude-powerline.toml` | [martinemde/starship-claude](https://github.com/martinemde/starship-claude) | `plugin/templates/powerline.toml` + `plugin/templates/palettes/nord.toml` (glyphs as `\u` escapes) | MIT |
| `pyccsl.env` | [wolfdenpublishing/pyccsl](https://github.com/wolfdenpublishing/pyccsl) | `pyccsl.env.example` (plus a non-PYCCSL line and a `$(…)` line) | MIT |
| `coralline.conf` | [Nanako0129/coralline](https://github.com/Nanako0129/coralline) | `configure.sh` `write_candidate_config` (`printf %q` values, theme include, p10k color hint), `statusline.ps1` REMORA line | MIT |
| `coralline-theme.conf` | [Nanako0129/coralline](https://github.com/Nanako0129/coralline) | `themes/claude-coral.conf` (colors, two subagent candidates) | MIT |
| `claude-statusbar.json` | [leeguooooo/claude-code-usage-bar](https://github.com/leeguooooo/claude-code-usage-bar) | `docs/configuration.md` (configuration file example), `src/claude_statusbar/config.py` | MIT |
| `nycu-cc-statusline.json` | [NYCU-Chung/cc-statusline](https://github.com/NYCU-Chung/cc-statusline) | `commands/rows.md` (special options and row keys tables), `statusline.js` `rowDefaults` | MIT |
| `claude-ultimate-hud.json` | [ai-younggle-man/claude-ultimate-hud](https://github.com/ai-younggle-man/claude-ultimate-hud) | `commands/setup.md` (Step 2 configuration file), `README.md` (display options), `src/types.ts` | MIT |
| `ccpet.json` | [terryso/ccpet](https://github.com/terryso/ccpet) | `src/services/ConfigService.ts` `DEFAULT_CONFIG` without its `supabase` block, `README.md` | MIT |
| `cc-statusline.sh` | [chongdashu/cc-statusline](https://github.com/chongdashu/cc-statusline) | `src/generators/bash-generator.ts` (script header), `.claude/statusline.sh` (first four lines); header comments plus `echo` filler, not executable | MIT |
| (none; command strings in tests) | [fredrikaverpil/claudeline](https://github.com/fredrikaverpil/claudeline) | `main.go` (flags), `internal/render/render.go` `Build` and `Output`, `README.md` (Flags) | MIT |
