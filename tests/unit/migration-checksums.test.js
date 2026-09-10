import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { migrations } from '../../migrations/index.ts';

// Released SQL identities and checksums, captured before moving the files to TypeScript.
// Append migrations instead of changing these definitions: existing profiles retain this ledger.
const released = [
  {
    "version": 1,
    "name": "0001_core.sql",
    "checksum": "b5f77feaffe64f4d4ad298eb70c57b4ff4030c0549ae58135d64135387a4b72b"
  },
  {
    "version": 2,
    "name": "0002_conversation.sql",
    "checksum": "a3c30a8d140abdcd979cfb890f8178a281c0e097949abb41faa23a5f7b9f1a51"
  },
  {
    "version": 3,
    "name": "0003_permissions.sql",
    "checksum": "2682b7507f17e716ff71bc8b0d19cd9dcf9e037453ce6839858b59a9d1a18277"
  },
  {
    "version": 4,
    "name": "0004_session_history.sql",
    "checksum": "19114a21243b5f66acb316a807a6e973787e1f5e806b8627f7aec2c418c874d7"
  },
  {
    "version": 5,
    "name": "0005_board.sql",
    "checksum": "a3bc6fae1419d5e30d47f2cafe3dd4a2f9542a2d46bb846086d6e29c8f2ee262"
  },
  {
    "version": 6,
    "name": "0006_worktrees.sql",
    "checksum": "7c87a34b9fd1f2c20b9c11cf107a755a292044fb7a853d640dceda8d038b7e19"
  },
  {
    "version": 7,
    "name": "0007_hosted_sessions.sql",
    "checksum": "9d673342965dab1d9b28b12b2401bc9183eeb71a98d360d59fa44d58f92424da"
  },
  {
    "version": 8,
    "name": "0008_plans.sql",
    "checksum": "38993128a79e913a9f897346827a3c1161134c58f5cec029b8c000d4ca46fffd"
  },
  {
    "version": 9,
    "name": "0009_runtime_indexes.sql",
    "checksum": "689da2417a110cdd1cff77e45c3e928578e456ac9fd095a521dd6947ad53e431"
  },
  {
    "version": 10,
    "name": "0010_image_attachments.sql",
    "checksum": "919fd1aecd346196f8d2d4dede52a3c5019c724e53db20c46fdf57480bdee469"
  },
  {
    "version": 11,
    "name": "0011_task_references.sql",
    "checksum": "125c3abf2ad4d8e947358589724cba7a2ee4878c4490d05a658e3dfcba607dce"
  }
];

test.each(released)('TypeScript migration $version retains its released SQL identity and checksum', ({ version, name, checksum }) => {
  const migration = migrations.find(entry => entry.version === version);
  expect(migration?.name).toBe(name);
  expect(createHash('sha256').update(migration.sql).digest('hex')).toBe(checksum);
});
