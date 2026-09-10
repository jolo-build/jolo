# Ink 7.1.1 native scrollback

`ink@7.1.1.patch` adds an opt-in `nativeScrollback` render option. Bun applies it through the root `patchedDependencies` entry and lockfile. Headless commands do not load Ink.

Jolo uses the normal terminal buffer, immutable `Static` transcript batches, and compact live controls. The terminal owns wheel/trackpad scrolling while Jolo runs. On exit, Jolo clears the visible screen and restores the cursor and terminal input mode; saved conversations remain available through `/sessions`. Ink releases previous batches instead of keeping a second replay copy of the whole transcript.

The patch handles normal-buffer resize problems:

- Count the previous live frame's physical rows after terminal reflow before erasing it. Defer painting until `useWindowSize` has received the new geometry, so the old-width prompt is not drawn again.
- Disable Ink's whole-terminal clear/replay fallback for this option, preserving native scrollback during resize. The CLI owns the explicit screen clear after Ink finishes unmounting.
- Paint trailing background padding with terminal erase-to-end-of-line instead of space characters. The padded prompt keeps its full-width surface without reflowing that padding into extra scrollback lines when the terminal shrinks.

Other Ink callers retain the default behavior. Review or remove this patch when upgrading Ink; do not silently drop it. The application uses percentage-width layout and short live controls. The prompt's padded charcoal surface, straight accent edge, and model footer are the user-approved style; preserve them when changing behavior.

Regression checks use a real Bun PTY and a headless terminal emulator, exercising `bun run jolo` with and without color, native scrolling, prompt recall, preserved history, tiny windows, and rapid width/height changes. Color checks verify that the input surface is filled with background cells rather than literal spaces:

```sh
bun test tests/integration/tui-screen.test.js tests/integration/tui.test.js
```
