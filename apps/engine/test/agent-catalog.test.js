import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCatalog, modelSupport } from "../src/agents/catalog.js";
import { BUILTIN_MANIFESTS } from "../src/agents/manifests.js";

// Stand-ins on a PATH of their own, so what this machine happens to have installed cannot change the result.
const bin = mkdtempSync(path.join(os.tmpdir(), "jolo-bin-"));
for (const name of ["claude", "codex", "grok", "gemini"]) {
  const file = path.join(bin, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
}
afterAll(() => rmSync(bin, { recursive: true, force: true }));
const env = { path: bin };
const catalogWith = (agents = {}) => createCatalog({ dir: "/nonexistent-agents-dir", env, shell: "/bin/sh", settings: { agent: (id) => agents[id] ?? { model: null, effort: null } }, log: { warn() {} } });
const argvFor = (catalog, id, options) => catalog.command(catalog.get(id), options).slice(1); // drop the resolved binary

describe("choosing a model for a hosted agent", () => {
  test("a manifest says how its CLI is told, and the option comes before the agent's own arguments", () => {
    const catalog = catalogWith({ grok: { model: "grok-4.5", effort: "high" } });
    // Grok wants its own options before the subcommand, which is exactly why order matters here.
    expect(argvFor(catalog, "grok")).toEqual(["-m", "grok-4.5", "--reasoning-effort", "high", "--permission-mode", "default", "agent", "stdio"]);
    expect(argvFor(catalog, "claude")).toEqual([]); // unconfigured: the agent keeps its own default
    expect(argvFor(catalogWith({ claude: { model: "opus", effort: null } }), "claude")).toEqual(["--model", "opus"]);
    expect(argvFor(catalogWith({ claude: { model: null, effort: "max" } }), "claude")).toEqual(["--effort", "max"]);
  });

  test("a transport that carries the model itself contributes no flags", () => {
    const catalog = catalogWith({ codex: { model: "fake-large", effort: "high" } });
    expect(argvFor(catalog, "codex")).toEqual([]); // Codex is told over its app-server, not on the command line
    expect(catalog.config(catalog.get("codex"))).toMatchObject({ model: "fake-large", effort: "high" });
  });

  test("a model is ignored for an agent whose transport or manifest cannot carry one", () => {
    const catalog = catalogWith({ shell: { model: "nonsense", effort: "high" } });
    expect(argvFor(catalog, "shell")).toEqual([]);
    expect(catalog.config(catalog.get("shell"))).toMatchObject({ model: null, effort: null }); // never offered, so never applied
    const listed = catalog.list().find((entry) => entry.id === "shell");
    expect(listed).toMatchObject({ supportsModel: false, supportsEffort: false, model: null, effort: null });
  });

  test("the catalog reports what each agent is set to run and whether Jolo can set it", () => {
    const listed = catalogWith({ claude: { model: "fable", effort: "high" } }).list();
    expect(listed.find((entry) => entry.id === "claude")).toMatchObject({ model: "fable", effort: "high", supportsModel: true, supportsEffort: true });
    expect(listed.find((entry) => entry.id === "codex")).toMatchObject({ model: null, supportsModel: true, supportsEffort: true });
    // Gemini takes a model but publishes no effort option, and the catalog says so rather than guessing.
    expect(listed.find((entry) => entry.id === "gemini")).toMatchObject({ supportsModel: true, supportsEffort: false });
  });

  test("an explicit override beats the setting, and a null asks for the agent's own default", () => {
    const catalog = catalogWith({ claude: { model: "fable", effort: "high" } });
    expect(argvFor(catalog, "claude", { model: "haiku" })).toEqual(["--model", "haiku", "--effort", "high"]);
    expect(argvFor(catalog, "claude", { model: null, effort: null })).toEqual([]); // how model discovery asks
  });

  test("support is judged per manifest, so a user's own ACP agent without a model option says so", () => {
    const acp = BUILTIN_MANIFESTS.find((manifest) => manifest.id === "grok");
    expect(modelSupport(acp)).toEqual({ model: "flag", effort: "flag" });
    expect(modelSupport({ ...acp, modelArgs: undefined, effortArgs: undefined })).toEqual({ model: "none", effort: "none" });
    expect(modelSupport({ transport: "codex-app-server" })).toEqual({ model: "protocol", effort: "protocol" });
    expect(modelSupport({ transport: "pty", modelArgs: ["-m", "{model}"] })).toEqual({ model: "none", effort: "none" });
  });
});
