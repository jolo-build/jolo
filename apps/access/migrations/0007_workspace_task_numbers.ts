const sql = `ALTER TABLE tasks ADD COLUMN number INTEGER CHECK(number > 0);

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY CASE WHEN team_id IS NULL THEN 'account:' || account_id ELSE 'team:' || team_id END
    ORDER BY id
  ) AS number FROM tasks
)
UPDATE tasks SET number = (SELECT number FROM numbered WHERE numbered.id = tasks.id);

CREATE UNIQUE INDEX tasks_personal_number ON tasks(account_id, number) WHERE team_id IS NULL;
CREATE UNIQUE INDEX tasks_team_number ON tasks(team_id, number) WHERE team_id IS NOT NULL;
CREATE TABLE task_sequences (
  scope_key TEXT PRIMARY KEY NOT NULL,
  last_number INTEGER NOT NULL CHECK(last_number > 0)
);
INSERT INTO task_sequences(scope_key, last_number)
SELECT CASE WHEN team_id IS NULL THEN 'account:' || account_id ELSE 'team:' || team_id END, MAX(number)
FROM tasks GROUP BY 1;

CREATE TRIGGER tasks_assign_number AFTER INSERT ON tasks WHEN NEW.number IS NULL BEGIN
  INSERT INTO task_sequences(scope_key, last_number)
  VALUES (CASE WHEN NEW.team_id IS NULL THEN 'account:' || NEW.account_id ELSE 'team:' || NEW.team_id END, 1)
  ON CONFLICT(scope_key) DO UPDATE SET last_number = last_number + 1;
  UPDATE tasks SET number = (
    SELECT last_number FROM task_sequences
    WHERE scope_key = CASE WHEN NEW.team_id IS NULL THEN 'account:' || NEW.account_id ELSE 'team:' || NEW.team_id END
  ) WHERE id = NEW.id;
END;

UPDATE task_audit SET subject = (
  SELECT 'JOLO-' || number FROM tasks WHERE id = CAST(substr(task_audit.subject, 6) AS INTEGER)
)
WHERE (action LIKE 'task.%' OR action LIKE 'comment.%') AND subject GLOB 'JOLO-[0-9]*'
  AND EXISTS (SELECT 1 FROM tasks WHERE id = CAST(substr(task_audit.subject, 6) AS INTEGER));
`;

export default sql;
