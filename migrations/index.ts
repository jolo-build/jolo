// Typed migration registry embedded in source, bundled, and compiled engines.
import core from "./0001_core.ts";
import conversation from "./0002_conversation.ts";
import permissions from "./0003_permissions.ts";
import sessionHistory from "./0004_session_history.ts";
import board from "./0005_board.ts";
import worktrees from "./0006_worktrees.ts";
import hostedSessions from "./0007_hosted_sessions.ts";
import plans from "./0008_plans.ts";

import runtimeIndexes from "./0009_runtime_indexes.ts";
import imageAttachments from "./0010_image_attachments.ts";

import taskReferences from "./0011_task_references.ts";

export interface Migration {
  readonly version: number;
  /** Stable database identity; keep the original name even when the source file moves. */
  readonly name: string;
  readonly sql: string;
  readonly compatibleChecksums?: readonly string[];
}

export const migrations: readonly Migration[] = Object.freeze([
  // Development builds used different SQL text for the same schema. Recognize only these
  // historical checksums; migrate() also verifies the applied tables and indexes before accepting them.
  { version: 1, name: "0001_core.sql", sql: core, compatibleChecksums: ['b8f382d2b8ab041d5ad38c2300df729d0de8b2066d1b71ac42d15fac3c4007a2'] },
  { version: 2, name: "0002_conversation.sql", sql: conversation, compatibleChecksums: ['6acee60895a641e88a3cd67a152009c818121225db2a88b58c42da0c70d8b0fc'] },
  { version: 3, name: "0003_permissions.sql", sql: permissions, compatibleChecksums: ['49c3e79cc9704dd50a96c8e63600ae8f111c3df6acdbed567e25d5efeb06f40a'] },
  { version: 4, name: "0004_session_history.sql", sql: sessionHistory },
  { version: 5, name: "0005_board.sql", sql: board },
  { version: 6, name: "0006_worktrees.sql", sql: worktrees, compatibleChecksums: ['267ce1770c1c01dcb05c7a163d7955f0e3be1e64953209183abd65793d0a0ca7'] },
  { version: 7, name: "0007_hosted_sessions.sql", sql: hostedSessions, compatibleChecksums: ['6d3c9a32bd2282b917e08b42734b6b8bc42af94b2b99c14faf71296251daf3a2'] },
  // An earlier development build shipped the same schema with different SQL text. Keep its exact
  // checksum recognized; migrate() verifies the complete applied schema before accepting this alias.
  { version: 8, name: "0008_plans.sql", sql: plans, compatibleChecksums: ['000c93b0bb34bebb785d4a2b843034ac7ecf4f6ccf3f1245c55179c994265284'] },
  { version: 9, name: "0009_runtime_indexes.sql", sql: runtimeIndexes },
  { version: 10, name: "0010_image_attachments.sql", sql: imageAttachments },
  { version: 11, name: "0011_task_references.sql", sql: taskReferences },
]);
