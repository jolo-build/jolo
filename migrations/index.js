// Migrations embedded as text so bundled and compiled engines carry them.
import core from "./0001_core.sql" with { type: "text" };
import conversation from "./0002_conversation.sql" with { type: "text" };
import permissions from "./0003_permissions.sql" with { type: "text" };
import sessionHistory from "./0004_session_history.sql" with { type: "text" };
import board from "./0005_board.sql" with { type: "text" };
import worktrees from "./0006_worktrees.sql" with { type: "text" };
import hostedSessions from "./0007_hosted_sessions.sql" with { type: "text" };
import plans from "./0008_plans.sql" with { type: "text" };

import runtimeIndexes from "./0009_runtime_indexes.sql" with { type: "text" };
import imageAttachments from "./0010_image_attachments.sql" with { type: "text" };

import taskReferences from "./0011_task_references.sql" with { type: "text" };

export const migrations = Object.freeze([
  { version: 1, name: "0001_core.sql", sql: core },
  { version: 2, name: "0002_conversation.sql", sql: conversation },
  { version: 3, name: "0003_permissions.sql", sql: permissions },
  { version: 4, name: "0004_session_history.sql", sql: sessionHistory },
  { version: 5, name: "0005_board.sql", sql: board },
  { version: 6, name: "0006_worktrees.sql", sql: worktrees },
  { version: 7, name: "0007_hosted_sessions.sql", sql: hostedSessions },
  // An earlier development build shipped the same schema with different SQL text. Keep its exact
  // checksum recognized; migrate() verifies the complete applied schema before accepting this alias.
  { version: 8, name: "0008_plans.sql", sql: plans, compatibleChecksums: ['000c93b0bb34bebb785d4a2b843034ac7ecf4f6ccf3f1245c55179c994265284'] },
  { version: 9, name: "0009_runtime_indexes.sql", sql: runtimeIndexes },
  { version: 10, name: "0010_image_attachments.sql", sql: imageAttachments },
  { version: 11, name: "0011_task_references.sql", sql: taskReferences },
]);
