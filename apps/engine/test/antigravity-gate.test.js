import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gateRequest } from "../src/agents/antigravity-gate.js";

const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jolo-gate-test-")));
mkdirSync(path.join(ws, "app"));
afterAll(() => rmSync(ws, { recursive: true, force: true }));

test("the gate asks Jolo about each of agy's calls by everything the call can reach", () => {
  // A command is the user's call, shown by its command line and where it runs.
  expect(gateRequest("run_command", { CommandLine: "npm test", Cwd: path.join(ws, "app") }, ws)).toMatchObject({ toolClass: "process", summary: "run_command: npm test", script: "npm test", cwd: "app" });
  // A file tool is judged by every path it names, so an outside path anywhere in the call is refused.
  expect(gateRequest("view_file", { AbsolutePath: path.join(ws, "a.md") }, ws)).toEqual({ toolClass: "read", targets: [path.join(ws, "a.md")] });
  expect(gateRequest("write_to_file", { AbsolutePath: path.join(ws, "a.txt"), TargetFile: "/elsewhere/.zshrc" }, ws)).toEqual({ toolClass: "mutation", targets: [path.join(ws, "a.txt"), "/elsewhere/.zshrc"] });
  // sed_file's expressions can reach other files, and a file tool without a path Jolo knows could reach anything.
  expect(gateRequest("sed_file", { TargetFile: path.join(ws, "a.txt") }, ws).toolClass).toBe("process");
  expect(gateRequest("view_file", {}, ws).toolClass).toBe("process");
  // A subagent in the parent's own workspace decides nothing itself; one given a new workspace is the user's call.
  expect(gateRequest("invoke_subagent", { Subagents: [{ Prompt: "check" }] }, ws)).toEqual({ toolClass: "read", targets: [] });
  expect(gateRequest("invoke_subagent", { Subagents: [{ Prompt: "check", Workspace: "share" }] }, ws).toolClass).toBe("process");
  // Anything else asks.
  expect(gateRequest("search_web", { Query: "agy" }, ws).toolClass).toBe("process");
});
