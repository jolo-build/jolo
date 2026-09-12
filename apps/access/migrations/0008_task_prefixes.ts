const sql = `CREATE TABLE task_prefixes (
  prefix TEXT PRIMARY KEY NOT NULL COLLATE NOCASE
    CHECK(length(prefix) BETWEEN 2 AND 24 AND prefix GLOB '[A-Z]*' AND prefix NOT GLOB '*[^A-Z0-9]*'),
  account_id TEXT UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  team_id TEXT UNIQUE REFERENCES teams(id) ON DELETE CASCADE,
  CHECK((account_id IS NULL) != (team_id IS NULL))
);

-- Deterministic, disjoint namespaces for existing personal accounts and teams.
INSERT INTO task_prefixes(prefix,account_id)
SELECT 'PERSONAL' || ROW_NUMBER() OVER (ORDER BY created_at,id),id FROM accounts;
INSERT INTO task_prefixes(prefix,team_id)
SELECT 'TEAM' || ROW_NUMBER() OVER (ORDER BY created_at,id),id FROM teams;

ALTER TABLE tasks ADD COLUMN prefix TEXT REFERENCES task_prefixes(prefix);
UPDATE tasks SET prefix=(SELECT prefix FROM task_prefixes p
  WHERE (tasks.team_id IS NOT NULL AND p.team_id=tasks.team_id)
     OR (tasks.team_id IS NULL AND p.account_id=tasks.account_id));
CREATE UNIQUE INDEX tasks_prefix_number ON tasks(prefix,number);

UPDATE task_audit SET subject=(SELECT prefix FROM task_prefixes p
  WHERE (task_audit.team_id IS NOT NULL AND p.team_id=task_audit.team_id)
     OR (task_audit.team_id IS NULL AND p.account_id=task_audit.account_id)) || substr(subject,5)
WHERE (action LIKE 'task.%' OR action LIKE 'comment.%') AND subject GLOB 'JOLO-[0-9]*';

CREATE TRIGGER tasks_assign_prefix AFTER INSERT ON tasks WHEN NEW.prefix IS NULL BEGIN
  INSERT INTO task_prefixes(prefix,account_id,team_id)
  SELECT 'P' || hex(randomblob(10)),NEW.account_id,NULL
  WHERE NEW.team_id IS NULL AND NOT EXISTS (SELECT 1 FROM task_prefixes WHERE account_id=NEW.account_id);
  INSERT INTO task_prefixes(prefix,account_id,team_id)
  SELECT 'T' || hex(randomblob(10)),NULL,NEW.team_id
  WHERE NEW.team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_prefixes WHERE team_id=NEW.team_id);
  UPDATE tasks SET prefix=(SELECT prefix FROM task_prefixes p
    WHERE (NEW.team_id IS NOT NULL AND p.team_id=NEW.team_id)
       OR (NEW.team_id IS NULL AND p.account_id=NEW.account_id)) WHERE id=NEW.id;
  SELECT CASE WHEN prefix IS NULL THEN RAISE(ABORT, 'Workspace ticket prefix is required') END
    FROM tasks WHERE id=NEW.id;
END;
`;

export default sql;
