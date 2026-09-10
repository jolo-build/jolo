// Engine entry: `bun apps/engine/src/main.js serve [--profile p] [--home dir] [--idle-ms n] [--agent fake]`.
import { resolvePaths } from "@jolo/launcher";
import { createEngine, OwnershipError, SchemaError } from "./engine.js";
import { createLogger } from "./log.js";

export const EXIT_OWNERSHIP_BUSY = 75;
export const EXIT_SCHEMA_UNSUPPORTED = 78;

function parseArgs(argv) {
  const options = { command: argv[0] ?? "serve", flags: {} };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    options.flags[key] = value;
  }
  return options;
}

export async function serve(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  if (command !== "serve") {
    process.stderr.write("usage: engine serve [--profile <name>] [--home <dir>] [--idle-ms <n>]\n");
    return 2;
  }
  const paths = resolvePaths({ home: flags.home, profile: flags.profile });
  const log = createLogger({ logDir: paths.logDir });
  const engine = createEngine({
    paths,
    log,
    build: process.env.JOLO_BUILD ?? "dev",
    idleMs: Number(flags["idle-ms"] ?? process.env.JOLO_IDLE_MS ?? 30_000),
  });
  try {
    await engine.start();
  } catch (error) {
    if (error instanceof OwnershipError) { log.info("another engine owns this profile; exiting", { profile: paths.profile }); return EXIT_OWNERSHIP_BUSY; }
    if (error instanceof SchemaError) { log.error("unsupported database schema", { error: error.message }); return EXIT_SCHEMA_UNSUPPORTED; }
    log.error("engine failed to start", { error: String(error?.stack ?? error) });
    return 1;
  }
  const onSignal = (signal) => void engine.stop(signal);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await engine.stopped;
  return 0;
}

if (import.meta.main) {
  const task = process.argv[2] === 'search-mcp' ? import('./search/mcp.js').then(module => module.runSearchMcp()).then(() => 0) : serve();
  task.then((code) => process.exit(code), (error) => { process.stderr.write(`${error?.stack ?? error}\n`); process.exit(1); });
}
