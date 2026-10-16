import { describe, expect, test } from "bun:test";
import { claudeWindows, codexWindows } from "../src/agents/limits.js";

// The get_usage answer Claude Code 2.1.300 gave for a Max sign-in.
const claudeUsage = (rateLimits) => ({ subscription_type: "max", rate_limits_available: true, rate_limits: rateLimits, behaviors: null });
const CLAUDE_MAX = claudeUsage({
  five_hour: { utilization: 16, resets_at: "2026-10-14T22:49:59.786341+00:00" },
  seven_day: { utilization: 44, resets_at: "2026-10-19T06:59:59.786360+00:00" },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  model_scoped: [{ display_name: "Fable", utilization: 44, resets_at: "2026-10-19T06:59:59.786515+00:00" }],
  extra_usage: { is_enabled: false },
});
const NO_CLAUDE_WINDOWS = { five_hour: null, seven_day: null, seven_day_oauth_apps: null, seven_day_opus: null, seven_day_sonnet: null, model_scoped: [], extra_usage: { is_enabled: false } };

// The account/rateLimits/read result codex-cli 0.153.3 gave for a Pro sign-in.
const CODEX_BUCKET = {
  limitId: "codex",
  limitName: null,
  primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1792497649 },
  secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: "62500.0000000000" },
  planType: "pro",
  rateLimitReachedType: null,
};
const CODEX_PRO = { rateLimits: CODEX_BUCKET, rateLimitsByLimitId: { codex: CODEX_BUCKET } };
const codexBucket = (fields) => ({ ...CODEX_BUCKET, ...fields });
const codexLabels = (windows) => codexWindows({ rateLimitsByLimitId: { codex: codexBucket(windows) } }).windows.map((window) => window.label);
const unixIso = (seconds) => new Date(seconds * 1000).toISOString();

describe("reading Claude Code's usage windows", () => {
  test("a Max sign-in shows the five-hour, weekly and per-model windows with their reset instants", () => {
    expect(claudeWindows(CLAUDE_MAX)).toEqual({
      windows: [
        { label: "5-hour", usedPercent: 16, resetsAt: "2026-10-14T22:49:59.786Z" },
        { label: "Weekly", usedPercent: 44, resetsAt: "2026-10-19T06:59:59.786Z" },
        { label: "Weekly · Fable", usedPercent: 44, resetsAt: "2026-10-19T06:59:59.786Z" },
      ],
      plan: "max",
      source: "agent",
      note: null,
    });
  });

  test("the older per-family weekly windows come after the weekly one, Opus before Sonnet", () => {
    const usage = claudeUsage({
      ...NO_CLAUDE_WINDOWS,
      seven_day: { utilization: 30, resets_at: "2026-10-19T07:00:00+00:00" },
      seven_day_opus: { utilization: 55, resets_at: "2026-10-19T07:00:00+00:00" },
      seven_day_sonnet: { utilization: 12, resets_at: "2026-10-20T07:00:00+00:00" },
    });
    expect(claudeWindows(usage).windows).toEqual([
      { label: "Weekly", usedPercent: 30, resetsAt: "2026-10-19T07:00:00.000Z" },
      { label: "Weekly · Opus", usedPercent: 55, resetsAt: "2026-10-19T07:00:00.000Z" },
      { label: "Weekly · Sonnet", usedPercent: 12, resetsAt: "2026-10-20T07:00:00.000Z" },
    ]);
  });

  test("every per-model window gets its own row in the order Claude listed them", () => {
    const usage = claudeUsage({
      ...NO_CLAUDE_WINDOWS,
      model_scoped: [
        { display_name: "Fable", utilization: 44, resets_at: "2026-10-19T06:59:59+00:00" },
        { display_name: "Opus", utilization: 7, resets_at: "2026-10-18T06:59:59+00:00" },
        { utilization: 3, resets_at: "2026-10-17T06:59:59+00:00" }, // a model without a display name
      ],
    });
    expect(claudeWindows(usage).windows).toEqual([
      { label: "Weekly · Fable", usedPercent: 44, resetsAt: "2026-10-19T06:59:59.000Z" },
      { label: "Weekly · Opus", usedPercent: 7, resetsAt: "2026-10-18T06:59:59.000Z" },
      { label: "Weekly · model", usedPercent: 3, resetsAt: "2026-10-17T06:59:59.000Z" },
    ]);
  });

  test("a window without a numeric utilization is not in force and is left out", () => {
    const usage = claudeUsage({
      ...NO_CLAUDE_WINDOWS,
      five_hour: { resets_at: "2026-10-14T22:49:59+00:00" },
      seven_day: { utilization: "44", resets_at: "2026-10-19T06:59:59+00:00" },
      seven_day_opus: { utilization: Number.NaN, resets_at: "2026-10-19T06:59:59+00:00" },
      seven_day_sonnet: { utilization: 9, resets_at: "2026-10-19T06:59:59+00:00" },
      model_scoped: [{ display_name: "Fable", utilization: null, resets_at: "2026-10-19T06:59:59+00:00" }],
    });
    expect(claudeWindows(usage)).toEqual({
      windows: [{ label: "Weekly · Sonnet", usedPercent: 9, resetsAt: "2026-10-19T06:59:59.000Z" }],
      plan: "max",
      source: "agent",
      note: null,
    });
  });

  test("a missing or unreadable reset instant becomes null while the window itself stays", () => {
    const usage = claudeUsage({
      ...NO_CLAUDE_WINDOWS,
      five_hour: { utilization: 16, resets_at: null },
      seven_day: { utilization: 44, resets_at: "not a date" },
      seven_day_opus: { utilization: 5 },
    });
    expect(claudeWindows(usage).windows).toEqual([
      { label: "5-hour", usedPercent: 16, resetsAt: null },
      { label: "Weekly", usedPercent: 44, resetsAt: null },
      { label: "Weekly · Opus", usedPercent: 5, resetsAt: null },
    ]);
  });

  test("usage over the plan is shown as reported and a negative utilization reads as zero", () => {
    const usage = claudeUsage({ ...NO_CLAUDE_WINDOWS, five_hour: { utilization: 112.5, resets_at: null }, seven_day: { utilization: -3, resets_at: null } });
    expect(claudeWindows(usage).windows).toEqual([
      { label: "5-hour", usedPercent: 112.5, resetsAt: null },
      { label: "Weekly", usedPercent: 0, resetsAt: null },
    ]);
  });

  test("an API-key sign-in has no plan windows and says so", () => {
    const usage = { subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null };
    expect(claudeWindows(usage)).toEqual({ windows: [], plan: null, source: "none", note: "Claude Code reports no plan limits for this sign-in" });
  });

  test("a usage endpoint failure keeps the plan, explains it, and is not an answer about the account", () => {
    const answer = claudeWindows(claudeUsage(null));
    expect(answer).toEqual({ windows: [], plan: "max", note: "Claude Code could not fetch its usage limits right now" });
    expect("source" in answer).toBe(false); // so the engine asks again next time instead of keeping it
  });

  test("no more than twenty windows are reported, in the order Claude listed them", () => {
    const models = Array.from({ length: 25 }, (_, index) => ({ display_name: `Model ${index + 1}`, utilization: index, resets_at: null }));
    const windows = claudeWindows(claudeUsage({ ...NO_CLAUDE_WINDOWS, five_hour: { utilization: 1, resets_at: null }, model_scoped: models })).windows;
    expect(windows).toHaveLength(20);
    expect(windows[0].label).toBe("5-hour");
    expect(windows.at(-1).label).toBe("Weekly · Model 19");
  });

  test("an answer whose windows are all absent says Claude listed no limits", () => {
    expect(claudeWindows(claudeUsage(NO_CLAUDE_WINDOWS))).toEqual({ windows: [], plan: "max", source: "none", note: "Claude Code listed no limits" });
  });
});

describe("reading Codex's usage windows", () => {
  test("a Pro sign-in shows its one weekly window with the reset instant from Unix seconds", () => {
    expect(codexWindows(CODEX_PRO)).toEqual({
      windows: [{ label: "Weekly", usedPercent: 17, resetsAt: "2026-10-20T12:00:49.000Z" }],
      plan: "pro",
      source: "agent",
      note: null,
    });
  });

  test("a bucket with a five-hour primary and a weekly secondary lists the primary first", () => {
    const result = { rateLimitsByLimitId: { codex: codexBucket({
      primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: 1792018200 },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1792497649 },
      planType: "plus",
    }) } };
    expect(codexWindows(result)).toEqual({
      windows: [
        { label: "5-hour", usedPercent: 62, resetsAt: unixIso(1792018200) },
        { label: "Weekly", usedPercent: 40, resetsAt: unixIso(1792497649) },
      ],
      plan: "plus",
      source: "agent",
      note: null,
    });
  });

  test("a window is named after its length in days, hours or minutes, and an unknown length is plain usage", () => {
    const window = (windowDurationMins) => ({ usedPercent: 1, windowDurationMins, resetsAt: null });
    expect(codexLabels({ primary: window(4320), secondary: window(120) })).toEqual(["3-day", "2-hour"]);
    expect(codexLabels({ primary: window(1440), secondary: window(45) })).toEqual(["1-day", "45-minute"]);
    expect(codexLabels({ primary: window(0), secondary: { usedPercent: 1, resetsAt: null } })).toEqual(["Usage", "Usage"]);
  });

  test("a named bucket carries its name after the window length", () => {
    const result = { rateLimitsByLimitId: {
      codex: CODEX_BUCKET,
      mini: codexBucket({ limitId: "mini", limitName: "GPT-5 mini", primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1792497649 } }),
    } };
    expect(codexWindows(result).windows).toEqual([
      { label: "Weekly", usedPercent: 17, resetsAt: unixIso(1792497649) },
      { label: "Weekly · GPT-5 mini", usedPercent: 8, resetsAt: unixIso(1792497649) },
    ]);
  });

  test("an answer without per-limit buckets, or with an empty list of them, is read from its single rateLimits bucket", () => {
    /** @type {import("../src/agents/limits.js").LimitAnswer} */
    const pro = { windows: [{ label: "Weekly", usedPercent: 17, resetsAt: "2026-10-20T12:00:49.000Z" }], plan: "pro", source: "agent", note: null };
    expect(codexWindows({ rateLimits: CODEX_BUCKET })).toEqual(pro);
    expect(codexWindows({ rateLimits: CODEX_BUCKET, rateLimitsByLimitId: {} })).toEqual(pro);
  });

  test("the plan comes from the first bucket that names one", () => {
    const result = { rateLimitsByLimitId: { spark: codexBucket({ limitId: "spark", planType: null }), codex: CODEX_BUCKET } };
    expect(codexWindows(result).plan).toBe("pro");
  });

  test("an answer with no buckets or no windows says Codex reports no limits", () => {
    /** @type {Omit<import("../src/agents/limits.js").LimitReport, "agentId" | "checkedAt">} */
    const none = { windows: [], plan: null, source: "none", note: "Codex reports no usage limits for this sign-in" };
    expect(codexWindows({})).toEqual(none);
    expect(codexWindows(null)).toEqual(none);
    expect(codexWindows({ rateLimits: null, rateLimitsByLimitId: {} })).toEqual(none);
    expect(codexWindows({ rateLimitsByLimitId: { codex: codexBucket({ primary: null, secondary: null }) } })).toEqual({ ...none, plan: "pro" });
  });

  test("a plan type spelled with underscores reads with spaces", () => {
    const result = { rateLimitsByLimitId: { codex: codexBucket({ planType: "self_serve_business_usage_based" }) } };
    expect(codexWindows(result).plan).toBe("self serve business usage based");
  });

  test("a missing secondary window adds no row", () => {
    expect(codexWindows({ rateLimitsByLimitId: { codex: codexBucket({ secondary: undefined }) } }).windows).toEqual([{ label: "Weekly", usedPercent: 17, resetsAt: "2026-10-20T12:00:49.000Z" }]);
  });
});
