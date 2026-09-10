# Native repository search

Jolo integrates [Microsoft tgrep](https://github.com/microsoft/tgrep), pinned in [`release.json`](release.json), under the MIT license in `LICENSE`.

Run `bun run setup:tgrep` to download the matching macOS/Linux release. `release.json` records the release archive SHA-256 for each architecture. Setup verifies the archive before extracting and atomically installing `vendor/tgrep/<platform>-<arch>/tgrep`. Generated executables are ignored by Git. For an offline install, use `bun scripts/setup-tgrep.js --archive /path/to/release.tar.gz`; the same checksum check applies.

The engine resolves `JOLO_TGREP`, the bundled executable, then `tgrep` on PATH. `JOLO_TGREP=""` disables indexing and the hosted search bridge. No application startup downloads occur. `bun run build` includes the installed native executable, release metadata, and MIT license in CLI and desktop artifacts; install it before building to include indexed search. The release manifest hashes those files.

`search_text` uses a healthy native-watched index, falling back to ripgrep while warming up or on failure. Without ripgrep, the bounded built-in fallback is available, though it does not interpret gitignore rules. Results identify `engine` and `freshness`. Use `fresh: true` after external edits when immediate disk consistency matters. Normal index queries can lag filesystem changes briefly. Negative indexed results are verified live. Literal search is the default; regex, case sensitivity, scoped paths, and pagination share the existing tool interface. Searches skip files over 1 MiB and never return paths outside the workspace.

Indexes live in `<profile data>/search/tgrep-v1`, not in the repository. At most two servers are retained; they stop after five idle minutes and during orderly engine shutdown. Each builds with a 128 MiB memory budget, 25% CPU budget, and 2,048 native-watch budget; these are tgrep build/watch settings, not hard process resource ceilings. Polling or degraded watchers use live search. Caches persist across restarts and are reconciled before reuse.

Structured Codex, Claude Code, and ACP sessions receive a `jolo_search` stdio MCP server with one `search_text` tool, pinned to the task's workspace and checked by the engine's inspection grant. Other MCP configuration stays in effect. The vendor agent decides which search tool to call; Jolo does not replace its own shell or native grep tools. Terminal-only agents are unchanged.

Validation: `bun test tests/integration/tgrep.test.js tests/unit/search-hosted.test.js`. Native integration cases skip when tgrep is absent; run setup first to exercise the real index. `tests/integration/packaging.test.js` validates the release layout.

## Automated release updates

The **Update tgrep vendor** GitHub Actions workflow checks for a new stable release daily at 07:41 UTC and can also be started manually. It rejects prereleases and downgrades. Before changing the pin, it downloads all four supported archives and matches their SHA-256 hashes against both upstream `checksums.txt` and GitHub's release asset digests. Missing assets, changed pinned checksums during verification, failed requests, or conflicting hashes fail the run without changing the pin.

When an update is available, separate read-only jobs install it and run native search and CLI packaging tests on macOS/Linux, ARM64/x64. Only after all four jobs pass does a separate job open or update a PR on `codex/update-tgrep`. The PR includes only the proposed release metadata, and the write-enabled job never runs the vendor executable. PRs are not merged automatically. A current pin creates no PR. Generated binaries stay out of Git.

GitHub must allow Actions to create pull requests under **Settings → Actions → General → Workflow permissions**. The workflow requests write permissions only for the PR job. Its pre-PR validation runs are linked in the PR because PRs created with the default `GITHUB_TOKEN` do not start new workflows. The schedule becomes active after this workflow is merged into the default branch.

To check locally and update the metadata, run `bun scripts/update-tgrep.js`. To verify every archive for the existing pin without changing it, run `bun scripts/update-tgrep.js --verify`. An optional `GH_TOKEN` authenticates GitHub API requests; it is not forwarded to archive downloads. Then run setup and the validation commands above. The updater never installs or executes downloaded files.
