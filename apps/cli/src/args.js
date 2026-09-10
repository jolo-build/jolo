export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && ["path", "profile", "home", "session", "model", "context-window", "max-output", "base-url", "reasoning", "max-iterations", "max-active-time", "branch", "base", "agent", "effort", "task", "server", "device-name"].includes(key)) {
        // A flag given more than once collects its values, which is how a plan's tasks are written on one line.
        if (flags[key] === undefined) flags[key] = next;
        else flags[key] = Array.isArray(flags[key]) ? [...flags[key], next] : [flags[key], next];
        i += 1;
      } else flags[key] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}
