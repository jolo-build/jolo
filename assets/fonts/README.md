# Bundled fonts

Shipped with the desktop renderer (copied to `dist/fonts` by `apps/desktop/scripts/build.js`). The terminal client uses the terminal's own font and ships nothing.

| File | Typeface | Source | Licence |
|------|----------|--------|---------|
| Inter-latin.woff2, Inter-latin-ext.woff2 | Inter, variable weight 100 to 900, Latin and Latin Extended subsets | Google Fonts hosted build of Inter (rsms/inter), fetched 2026-09-07 | SIL OFL 1.1, LICENSE-Inter.txt |
| JetBrainsMono-latin.woff2, JetBrainsMono-latin-ext.woff2 | JetBrains Mono, variable weight 100 to 800, Latin and Latin Extended subsets | Google Fonts hosted build of JetBrains Mono (JetBrains/JetBrainsMono), fetched 2026-09-08 | SIL OFL 1.1, LICENSE-JetBrainsMono.txt |
| JetBrainsMonoNerdFontMono-Regular.woff2 | JetBrainsMono Nerd Font Mono Regular (JetBrains Mono patched with Nerd Fonts glyphs for prompts) | Nerd Fonts release v3.5.1, JetBrainsMono.tar.xz, converted from TTF with fonttools | JetBrains Mono's OFL plus the glyph licences in LICENSE-NerdFonts.txt |

Interface text uses Inter; code, diffs, and tool output use JetBrains Mono with ligatures off; the terminal uses the Nerd Font build, loaded only when a terminal opens. All three are user-overridable in Settings and fall back to the system stacks.
