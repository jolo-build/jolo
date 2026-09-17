// schedule_*: a heartbeat on this task — the agent asks to be woken on an interval to check on
// delegated work and correct course, without a person watching the clock.
import { z } from "zod";
import { ProtocolError, SCHEDULE_LIMITS, parseEveryMs } from "@jolo/protocol";

const everyParam = z.string().min(1).max(16).describe(`How often to wake, e.g. "15m", "1h", "1d" (between ${SCHEDULE_LIMITS.minEveryMs / 60_000}m and ${SCHEDULE_LIMITS.maxEveryMs / 86_400_000}d)`);
const idParam = z.object({ scheduleId: z.string().min(1).max(128).describe("Schedule id, e.g. sch_…") });

const service = (ctx) => {
  if (!ctx.schedules) throw new ProtocolError("unavailable", "schedules are not available in this engine");
  return ctx.schedules;
};

export const scheduleTools = [
  {
    name: "schedule_create",
    description: "Set a heartbeat on THIS task: every interval, Jolo posts the prompt back into this conversation as a new turn, waking you to check on delegated work and correct course. The schedule survives restarts and fires even while you are idle. Use when the user asks to check in, monitor, or revisit work on an interval.",
    executionClass: "mutation",
    deadlineMs: 10_000,
    params: z.object({
      every: everyParam,
      prompt: z.string().min(1).max(16 * 1024).describe("The message you will see on each wake-up, e.g. \"check the board and course-correct\""),
    }),
    async execute(ctx, args) {
      const everyMs = parseEveryMs(args.every);
      if (!everyMs) throw new ProtocolError("invalid_params", `unrecognized interval "${args.every}" — use e.g. "15m", "1h", "1d"`);
      const { schedule } = service(ctx).create({ sessionId: ctx.sessionId, prompt: args.prompt, everyMs });
      return { schedule };
    },
  },
  {
    name: "schedule_list",
    description: "List the heartbeat schedules set on this task.",
    executionClass: "read",
    deadlineMs: 10_000,
    params: z.object({}),
    async execute(ctx) {
      return service(ctx).list({ sessionId: ctx.sessionId });
    },
  },
  ...[["schedule_pause", "Pause a heartbeat schedule on this task; it stops firing until resumed.", "pause"],
       ["schedule_resume", "Resume a paused heartbeat schedule; the next wake is one interval from now.", "resume"],
       ["schedule_cancel", "Cancel a heartbeat schedule on this task permanently.", "cancel"]].map(([name, description, method]) => ({
    name, description,
    executionClass: "mutation",
    deadlineMs: 10_000,
    params: idParam,
    async execute(ctx, args) {
      return service(ctx)[method](args.scheduleId, { sessionId: ctx.sessionId });
    },
  })),
];
