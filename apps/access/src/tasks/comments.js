import { readSQL, commentSQL } from './permissions.js';

export function commentRepository(db, now = Date.now) {
  const statement = (sql, values) => db.prepare(sql).bind(...values);
  const one = (sql, values) => statement(sql, values).first();
  const readable = `EXISTS(SELECT 1 FROM tasks WHERE tasks.id=task_comments.task_id AND ${readSQL()})`;
  const writable = `EXISTS(SELECT 1 FROM tasks WHERE tasks.id=task_comments.task_id AND ${commentSQL()})`;
  const mutate = async (sql, values, actor, task, action) => {
    const result = await db.batch([
      statement(sql, values),
      statement(`INSERT INTO task_audit(team_id,account_id,actor_id,action,subject,at)
        SELECT team_id,?1,?1,?3,prefix||'-'||number,?4 FROM tasks WHERE id=?2 AND changes()>0`, [actor,task,action,now()]),
    ]);
    return result[0].results?.[0] ?? null;
  };
  return {
    async list(actor, task, before = null) {
      const { results } = await statement(`SELECT task_comments.*,accounts.name AS author_name
        FROM task_comments JOIN accounts ON accounts.id=task_comments.author_id
        WHERE task_id=?2 AND deleted_at IS NULL AND (?3 IS NULL OR task_comments.id<?3) AND ${readable}
        ORDER BY task_comments.id DESC LIMIT 51`, [actor,task,before]).all();
      return { comments:results.slice(0,50).reverse(), older:results.length>50?results[49].id:null };
    },
    get: (actor,task,id) => one(`SELECT * FROM task_comments WHERE id=?3 AND task_id=?2 AND deleted_at IS NULL AND ${readable}`, [actor,task,id]),
    async create(actor, task, body, requestID) {
      const result = await mutate(`INSERT INTO task_comments(task_id,author_id,body,request_id,created_at,updated_at)
        SELECT ?2,?1,?3,?4,?5,?5 FROM tasks WHERE id=?2 AND ${commentSQL()}
        ON CONFLICT(task_id,author_id,request_id) DO NOTHING RETURNING *`, [actor,task,body,requestID,now()], actor,task,'comment.created');
      // Retain the request identity after deletion so a retried POST cannot
      // recreate a deleted comment or duplicate a successful submission.
      return result ?? one(`SELECT * FROM task_comments WHERE task_id=?2 AND author_id=?1 AND request_id=?3 AND ${writable}`, [actor,task,requestID]);
    },
    edit: (actor,task,id,body,revision) => mutate(`UPDATE task_comments SET body=?4,revision=revision+1,updated_at=?6
      WHERE id=?3 AND task_id=?2 AND author_id=?1 AND revision=?5 AND deleted_at IS NULL AND ${writable} RETURNING *`, [actor,task,id,body,revision,now()], actor,task,'comment.edited'),
    remove: (actor,task,id,revision) => mutate(`UPDATE task_comments SET body='',deleted_at=?5,updated_at=?5,revision=revision+1
      WHERE id=?3 AND task_id=?2 AND author_id=?1 AND revision=?4 AND deleted_at IS NULL AND ${writable} RETURNING *`, [actor,task,id,revision,now()], actor,task,'comment.deleted'),
  };
}
