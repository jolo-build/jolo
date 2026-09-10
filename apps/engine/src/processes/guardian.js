// The guardian owns the vendor process group and observes the engine's stdin
// pipe. Even SIGKILL of the engine closes that pipe, triggering group cleanup.
// It is embedded text so source, bundled, and compiled engines use the same code.
export const GUARDIAN_SOURCE = `
const argv = process.argv.slice(1);
const child = Bun.spawn(argv, { stdin: "pipe", stdout: "inherit", stderr: "inherit", detached: process.platform !== "win32" });
let stopping = false;
const kill = signal => { try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch {} };
const stop = () => {
  if (stopping) return;
  stopping = true;
  try { child.stdin.end(); } catch {}
  kill("SIGTERM");
  setTimeout(() => { kill("SIGKILL"); process.exit(1); }, 1500);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGHUP", stop);
process.stdin.on("data", data => { try { child.stdin.write(data); child.stdin.flush?.(); } catch {} });
process.stdin.on("end", stop);
process.stdin.on("error", stop);
child.exited.then(code => { kill("SIGKILL"); process.exit(code ?? 1); });
`;
