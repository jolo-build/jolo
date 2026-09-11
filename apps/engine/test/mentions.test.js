import { describe, expect, test } from "bun:test";
import { mentionOf, routeFor, withoutMention } from "../src/agents/mentions.js";

const catalog = {
  get(id) {
    const known = { codex: { id: "codex", transport: "codex-app-server" }, claude: { id: "claude", transport: "claude-stream" }, shell: { id: "shell", transport: "pty" } };
    if (!known[id]) throw new Error("unknown");
    return known[id];
  },
};

describe("calling an agent into a conversation by name", () => {
  test("a name at the start of a message routes that turn; anywhere else it is ordinary text", () => {
    expect(mentionOf("@codex review this")).toBe("codex");
    expect(mentionOf("  @Codex review this")).toBe("codex");
    expect(mentionOf("@codex")).toBe("codex");
    expect(mentionOf("ask @codex about it later")).toBeNull();
    expect(mentionOf("email me at a@codex.dev")).toBeNull();
    expect(mentionOf("")).toBeNull();
  });

  test("the mention is addressed to Jolo, so the agent is asked only for what follows", () => {
    expect(withoutMention("@codex review the last change")).toBe("review the last change");
    expect(withoutMention("@codex\nreview this")).toBe("\nreview this");
    expect(withoutMention("no mention here")).toBe("no mention here");
    // A bare mention would leave the agent nothing to answer, so it keeps the text as written.
    expect(withoutMention("@codex")).toBe("@codex");
  });

  test("only an agent that can answer a task is routed to, and never the one already answering", () => {
    expect(routeFor({ prompt: "@codex look", catalog, sessionAgentId: "claude" })).toEqual({ agentId: "codex" });
    expect(routeFor({ prompt: "@codex look", catalog, sessionAgentId: null })).toEqual({ agentId: "codex" });
    expect(routeFor({ prompt: "@codex look", catalog, sessionAgentId: "codex" })).toBeNull(); // already answering
    expect(routeFor({ prompt: "@shell look", catalog, sessionAgentId: null })).toBeNull(); // a terminal agent
    expect(routeFor({ prompt: "@nobody look", catalog, sessionAgentId: null })).toBeNull(); // just text
    expect(routeFor({ prompt: "@jolo look", catalog, sessionAgentId: "claude" })).toEqual({ agentId: "jolo" });
    expect(routeFor({ prompt: "@jolo look", catalog, sessionAgentId: null })).toBeNull(); // Jolo already answers
  });
});
