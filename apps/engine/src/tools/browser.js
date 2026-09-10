// Model-facing browser tools. Names use underscores because provider
// function names disallow dots; each maps to a host operation. Declared only while a host is attached.
import { z } from "zod";
import { ProtocolError } from "@jolo/protocol";

const SCREENSHOT_MAX_BYTES = 1024 * 1024;

const HTTP_URL = z.string().min(1).max(2048).refine((value) => { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } }, "only http(s) URLs can be opened");

export const browserTools = [
  {
    name: "browser_navigate",
    description: "Navigate the inline browser tab to an http(s) URL and wait for it to load. Returns the final URL, title, and a new navigation revision; previous element references expire.",
    executionClass: "browser_action",
    deadlineMs: 45_000,
    browserOperation: "navigate",
    params: z.object({ url: HTTP_URL.describe("Absolute http(s) URL") }),
    async execute(ctx, args) {
      return (await ctx.browser.execute("navigate", args)).result;
    },
  },
  {
    name: "browser_snapshot",
    description: "Return a compact accessibility snapshot of the current page: roles, names, states, and element references (e1, e2, …) usable with browser_click and browser_type until the page navigates.",
    executionClass: "browser_read",
    deadlineMs: 30_000,
    browserOperation: "snapshot",
    params: z.object({ maxNodes: z.number().int().min(20).max(500).default(300).describe("Maximum nodes to include") }),
    async execute(ctx, args) {
      return (await ctx.browser.execute("snapshot", args)).result;
    },
  },
  {
    name: "browser_click",
    description: "Click an element by its snapshot reference with a real pointer event after scrolling it into view and checking nothing covers it. Fails if the reference is stale or obscured.",
    executionClass: "browser_action",
    deadlineMs: 30_000,
    browserOperation: "click",
    params: z.object({ ref: z.string().regex(/^e\d{1,6}$/).describe("Element reference from browser_snapshot"), snapshotId: z.string().max(64).optional().describe("Snapshot the reference came from") }),
    async execute(ctx, args) {
      return (await ctx.browser.execute("click", args)).result;
    },
  },
  {
    name: "browser_type",
    description: "Focus an element by reference and type text into it; optionally press Enter afterwards.",
    executionClass: "browser_action",
    deadlineMs: 30_000,
    browserOperation: "type",
    params: z.object({ ref: z.string().regex(/^e\d{1,6}$/), text: z.string().max(10_000), submit: z.boolean().default(false), snapshotId: z.string().max(64).optional() }),
    async execute(ctx, args) {
      return (await ctx.browser.execute("type", args)).result;
    },
  },
  {
    name: "browser_network",
    description: "List recent network requests observed in the inline browser tab since the last navigation: method, URL, status, resource type, and size. No bodies. Bounded to the most recent entries.",
    executionClass: "browser_read",
    deadlineMs: 15_000,
    browserOperation: "network",
    params: z.object({ maxEntries: z.number().int().min(1).max(200).default(50), filter: z.string().max(200).optional().describe("Only entries whose URL contains this text") }),
    async execute(ctx, args) {
      return (await ctx.browser.execute("network", args)).result;
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture the visible viewport as a PNG artifact (bounded size). Returns the artifact id and dimensions; use it as evidence of what the page shows.",
    executionClass: "browser_read",
    deadlineMs: 30_000,
    browserOperation: "screenshot",
    params: z.object({}),
    async execute(ctx) {
      const { result, screenshot } = await ctx.browser.execute("screenshot", {});
      if (!screenshot) throw new ProtocolError("unavailable", "host returned no image");
      const buffer = Buffer.from(screenshot.base64, "base64");
      if (buffer.length > SCREENSHOT_MAX_BYTES) throw new ProtocolError("limit_exceeded", "screenshot exceeds 1 MiB");
      const artifactId = ctx.storeArtifact("screenshot", buffer);
      return { ...result, artifactId, width: screenshot.width, height: screenshot.height, bytes: buffer.length, mimeType: screenshot.mimeType };
    },
  },
];
