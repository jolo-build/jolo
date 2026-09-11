import { describe, expect, test } from "bun:test";
import { compileRules, detectStatus, region } from "../src/agents/status.js";
import { GENERIC_RULES } from "../src/agents/manifests.js";

const rules = compileRules(GENERIC_RULES);
const screenModel = (screen, extra = {}) => detectStatus({ rules, statusModel: "screen", idleMs: 4_000, screen, msSinceOutput: 0, ...extra });

describe("hosted agent status", () => {
  test("process liveness outranks every rule, because it is the only thing Jolo knows", () => {
    const busy = "Thinking…\nesc to interrupt";
    expect(screenModel(busy)).toMatchObject({ status: "working", source: "screen" });
    expect(screenModel(busy, { exited: true, exitCode: 0 })).toEqual({ status: "done", source: "process", detail: null });
    expect(screenModel(busy, { exited: true, exitCode: 2 })).toEqual({ status: "done", source: "process", detail: "exit 2" });
    expect(screenModel("", { started: false })).toEqual({ status: "starting", source: "process", detail: null });
  });

  test("a question outranks a spinner, so a prompt behind busy output still asks for the user", () => {
    expect(screenModel("⠋ working\nDo you want to proceed? (y/n)")).toMatchObject({ status: "needs_input", source: "screen", detail: "yes-no-prompt" });
    expect(screenModel("Allow this command?\n  esc to interrupt")).toMatchObject({ status: "needs_input", detail: "asks-to-proceed" });
    expect(screenModel("❯ 1. Yes\n  2. No")).toMatchObject({ status: "needs_input", detail: "numbered-choice" });
    expect(screenModel("Press enter to continue")).toMatchObject({ status: "needs_input", detail: "press-enter" });
    expect(screenModel("⠹ Generating...")).toMatchObject({ status: "working", detail: "spinner" });
  });

  test("without a matching rule, silence decides, and the answer says so", () => {
    expect(screenModel("just some output", { msSinceOutput: 100 })).toEqual({ status: "working", source: "silence", detail: null });
    expect(screenModel("just some output", { msSinceOutput: 9_000 })).toEqual({ status: "idle", source: "silence", detail: null });
    // A process-model agent never consults rules even when the screen would match one.
    expect(detectStatus({ rules, statusModel: "process", idleMs: 1_000, screen: "Do you want to proceed? (y/n)", msSinceOutput: 0 }))
      .toEqual({ status: "working", source: "silence", detail: null });
  });

  test("rules read a bounded slice of the screen, never the whole scrollback", () => {
    const noise = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    expect(screenModel(`Do you want to proceed? (y/n)\n${noise}`)).toMatchObject({ status: "working", source: "silence" });
    expect(region({ region: "bottom", regionLines: 2 }, { screen: "a\n\nb\n\nc" })).toBe("b\nc");
    expect(region({ region: "title" }, { title: "claude — working" })).toBe("claude — working");
    expect(region({ region: "screen" }, { screen: noise }).split("\n")).toHaveLength(60);
  });

  test("an unusable pattern is dropped instead of disabling the agent", () => {
    const warnings = [];
    const compiled = compileRules([{ id: "bad", state: "working", priority: 100, region: "bottom", regionLines: 4, regex: "([" }, ...GENERIC_RULES], { warn: (_message, fields) => warnings.push(fields.rule) });
    expect(warnings).toEqual(["bad"]);
    expect(compiled.length).toBe(GENERIC_RULES.length);
    expect(compiled[0].priority).toBeGreaterThanOrEqual(compiled.at(-1).priority); // highest priority first
  });
});
