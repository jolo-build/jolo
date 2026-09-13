// `jolo demo` — a scripted walkthrough that needs no agent, provider, or account.
// It plays a short transcript of a real session so a fresh install can see what
// Jolo does before anything is configured. Timed playback on a TTY; instant when piped.
import { EXIT } from "./exit-codes.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function commandDemo({ flags }) {
  const tty = Boolean(process.stdout.isTTY) && !flags.fast;
  const dim = (s) => (tty ? `[2m${s}[0m` : s);
  const bold = (s) => (tty ? `[1m${s}[0m` : s);
  const green = (s) => (tty ? `[32m${s}[0m` : s);

  const say = async (ms, text = "") => {
    if (tty && ms) await sleep(ms);
    if (text) process.stdout.write(`${text}\n`);
  };

  await say(0, "");
  await say(300, `${dim("$")} jolo .`);
  await say(700, "");
  await say(0, bold("❯ Explain how this project is organized."));
  await say(800, "");
  await say(0, "Jolo");
  await say(500, dim("  Read package.json · listed apps/ · searched packages/"));
  await say(700, "  The project has three main parts:");
  await say(120, "    apps/      Application entry points");
  await say(120, "    packages/  Shared components and tools");
  await say(120, "    tests/     Checks for expected behavior");
  await say(400, dim("  No files changed."));
  await say(700, "");

  await say(0, bold("❯ Add a saved-searches filter to the dashboard and cover it with a test."));
  await say(900, "");
  await say(0, "Jolo");
  await say(500, dim("  Found the filter bar in apps/desktop/src/renderer · wrote searches.ts · extended dashboard.test.js"));
  await say(700, `  ${green("+42")} ${green("−3")} in 2 files ${dim("— changes stay in the conversation until you review them")}`);
  await say(400, `  ${green("✓")} 4 tests passed ${dim("· typecheck clean")}`);
  await say(700, "");

  await say(0, dim("  Other commands worth knowing:"));
  await say(150, dim("    jolo run \"Fix the sign-in redirect loop\"   one task, headless"));
  await say(150, dim("    jolo plan new \"Prepare the release\" …     ordered steps, an agent per step"));
  await say(150, dim("    jolo worktree add --branch fix/login      isolated edits per task"));
  await say(150, dim("    jolo board                                every project at a glance"));
  await say(700, "");

  await say(0, "  Ready for the real thing:");
  await say(150, "    1. Install an agent — Claude Code, Codex, Devin CLI, Grok CLI, or Gemini CLI — or run " + bold("jolo provider set") + " to use an API provider.");
  await say(150, "    2. Run " + bold("jolo .") + " inside a project and ask your first question.");
  await say(150, `    3. The full guide lives at ${bold("https://docs.jolo.build")}.`);
  await say(200, "");
  return EXIT.completed;
}
