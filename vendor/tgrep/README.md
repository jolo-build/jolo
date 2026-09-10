# Native repository search

Jolo integrates [Microsoft tgrep](https://github.com/microsoft/tgrep), pinned to **v1.0.5**, under the MIT license in `LICENSE`.

Run `bun run setup:tgrep` to download the matching macOS/Linux release. `release.json` records the release archive SHA-256 for each architecture. Setup verifies the archive before extracting and atomically installing `vendor/tgrep/<platform>-<arch>/tgrep`. Generated executables are ignored by Git. For an offline install, use `bun scripts/setup-tgrep.js --archive /path/to/release.tar.gz`; the same checksum check applies.

The engine resolves `JOLO_TGREP`, the bundled executable, then `tgrep` on PATH. `JOLO_TGREP=""` disables indexing and the hosted search bridge. No application startup downloads occur. `bun run build` includes the installed native executable, release metadata, and MIT license in CLI and desktop artifacts; install it before building to include indexed search. The release manifest hashes those files.

`search_text` uses a healthy native-watched index, falling back to ripgrep while warming up or on failure. Without ripgrep, the bounded built-in fallback is available, though it does not interpret gitignore rules. Results identify `engine` and `freshness`. Use `fresh: true` after external edits when immediate disk consistency matters. Normal index queries can lag filesystem changes briefly. Negative indexed results are verified live. Literal search is the default; regex, case sensitivity, scoped paths, and pagination share the existing tool interface. Searches skip files over 1 MiB and never return paths outside the workspace.

Indexes live in `<profile data>/search/tgrep-v1`, not in the repository. At most two servers are retained; they stop after five idle minutes and during orderly engine shutdown. Each builds with a 128 MiB memory budget, 25% CPU budget, and 2,048 native-watch budget; these are tgrep build/watch settings, not hard process resource ceilings. Polling or degraded watchers use live search. Caches persist across restarts and are reconciled before reuse.

Structured Codex, Claude Code, and ACP sessions receive a `jolo_search` stdio MCP server with one `search_text` tool, pinned to the task's workspace and checked by the engine's inspection grant. Other MCP configuration stays in effect. The vendor agent decides which search tool to call; Jolo does not replace its own shell or native grep tools. Terminal-only agents are unchanged.

Validation: `bun test tests/integration/tgrep.test.js tests/unit/search-hosted.test.js`. Native integration cases skip when tgrep is absent; run setup first to exercise the real index. `tests/integration/packaging.test.js` validates the release layout.
