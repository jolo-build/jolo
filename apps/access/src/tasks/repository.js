import { roleSQL, readSQL, writeSQL } from './permissions.js';

export function taskRepository(db, now = Date.now) {
  const statement = (sql, values) => db.prepare(sql).bind(...values);
  const one = (sql, values) => statement(sql, values).first();
  const all = async (sql, values) => (await statement(sql, values).all()).results;
  // Mutation and audit commit together. The audit's changes() refers to the
  // immediately preceding conditional mutation in the same D1 transaction.
  const mutate = async (sql, values, { actor, team = null, action, subject, after = [] }) => {
    const results = await db.batch([
      statement(sql, values),
      statement("INSERT INTO task_audit(team_id,account_id,actor_id,action,subject,at) SELECT ?,?,?,?,CASE WHEN ?='task.created' THEN (SELECT 'JOLO-'||number FROM tasks WHERE mutation_id=?) WHEN ? LIKE 'task.%' THEN (SELECT 'JOLO-'||number FROM tasks WHERE id=?) ELSE ? END,? WHERE changes() > 0", [team, actor, actor, action, action, subject, action, subject, subject, now()]),
      ...after,
    ]);
    return results[0].results?.[0] ?? null;
  };
  const role = team => roleSQL(team);
  const scopeWrite = `(team_id IS NULL AND account_id = ?1) OR ${role('task_labels.team_id')} IN ('owner','admin')`;
  const validLabels = `(SELECT count(*) FROM task_labels l WHERE l.id IN (SELECT value FROM json_each(?9)) AND ((?2 IS NULL AND l.team_id IS NULL AND l.account_id = ?1) OR (?2 IS NOT NULL AND l.team_id = ?2))) = json_array_length(?9)`;
  const validAssignee = `(?3 IS NULL OR (?2 IS NULL AND ?3 = ?1) OR (?2 IS NOT NULL AND ${roleSQL('?2', '?3')} IS NOT NULL))`;
  return {
    team: (actor, id) => one(`SELECT teams.*, ${role('teams.id')} AS role FROM teams WHERE id = ?2 AND ${role('teams.id')} IS NOT NULL`, [actor, id]),
    teams: actor => all(`SELECT teams.id,teams.name,${role('teams.id')} AS role FROM teams WHERE ${role('teams.id')} IS NOT NULL ORDER BY name LIMIT 100`, [actor]),
    createTeam: (actor, name) => {
      const id = crypto.randomUUID();
      return mutate('INSERT INTO teams(id,owner_id,name,created_at,updated_at) SELECT ?2,?1,?3,?4,?4 WHERE (SELECT count(*) FROM teams WHERE owner_id=?1)<50 RETURNING *', [actor,id,name,now()], { actor, team:id, action:'team.created', subject:id });
    },
    renameTeam: (actor, id, name, revision) => mutate('UPDATE teams SET name=?3,revision=revision+1,updated_at=?5 WHERE owner_id=?1 AND id=?2 AND revision=?4 RETURNING *', [actor,id,name,revision,now()], {actor,team:id,action:'team.renamed',subject:id}),
    members: (actor, id) => all(`SELECT a.id,a.name,a.email,'owner' AS role,0 AS revision FROM teams t JOIN accounts a ON a.id=t.owner_id WHERE t.id=?2 AND ${role('t.id')} IS NOT NULL UNION ALL SELECT a.id,a.name,a.email,m.role,m.revision FROM team_members m JOIN accounts a ON a.id=m.account_id WHERE m.team_id=?2 AND ${role('m.team_id')} IS NOT NULL`, [actor,id]),
    member: (actor, id, target) => one(`SELECT * FROM team_members WHERE team_id=?2 AND account_id=?3 AND ${role('team_members.team_id')} IS NOT NULL`, [actor,id,target]),
    setMember: (actor,id,target,nextRole,revision) => mutate(`UPDATE team_members SET role=?4,revision=revision+1 WHERE team_id=?2 AND account_id=?3 AND account_id!=?1 AND revision=?5 AND (${role('team_members.team_id')}='owner' OR (${role('team_members.team_id')}='admin' AND role IN ('member','viewer') AND ?4 IN ('member','viewer'))) RETURNING *`, [actor,id,target,nextRole,revision], {actor,team:id,action:'member.role_changed',subject:target}),
    removeMember: (actor,id,target,revision) => mutate(`DELETE FROM team_members WHERE team_id=?2 AND account_id=?3 AND revision=?4 AND (account_id=?1 OR ${role('team_members.team_id')}='owner' OR (${role('team_members.team_id')}='admin' AND role IN ('member','viewer'))) RETURNING *`, [actor,id,target,revision], {actor,team:id,action:'member.removed',subject:target}),
    invite: (actor,id,email,nextRole,mail = null) => {
      const invitation = crypto.randomUUID();
      const after = mail ? [statement(`INSERT INTO mail_outbox(id,payload,available_at,created_at)
        SELECT ?1,?2,?3,?3 WHERE EXISTS(SELECT 1 FROM team_invitations WHERE id=?1)`, [invitation,JSON.stringify(mail),now()])] : [];
      return mutate(`INSERT INTO team_invitations(id,team_id,inviter_id,email,role,expires_at,created_at) SELECT ?3,?2,?1,?4,?5,?6,?7 WHERE (${role('?2')}='owner' OR (${role('?2')}='admin' AND ?5 IN ('member','viewer'))) AND NOT EXISTS(SELECT 1 FROM team_invitations WHERE team_id=?2 AND email=?4 AND accepted_by IS NULL AND revoked_at IS NULL AND expires_at>?7) RETURNING *`, [actor,id,invitation,email,nextRole,now()+7*86400_000,now()], {actor,team:id,action:'invitation.created',subject:invitation,after});
    },
    invitations: (actor,email) => all(`SELECT i.id,i.team_id,i.role,i.email,t.name AS team_name,i.expires_at FROM team_invitations i JOIN teams t ON t.id=i.team_id WHERE i.email=?2 AND i.accepted_by IS NULL AND i.revoked_at IS NULL AND i.expires_at>?3 AND (?1!=t.owner_id) ORDER BY i.created_at DESC LIMIT 100`, [actor,email,now()]),
    teamInvitations: (actor,id) => all(`SELECT team_invitations.*,(SELECT state FROM mail_outbox WHERE id=team_invitations.id) AS mail_state FROM team_invitations WHERE team_id=?2 AND accepted_by IS NULL AND revoked_at IS NULL AND expires_at>?3 AND ${role('team_invitations.team_id')} IN ('owner','admin') ORDER BY created_at DESC LIMIT 100`, [actor,id,now()]),
    async accept(actor,id,email) {
      // Acceptance is one transaction. Recheck the inviter's current authority,
      // exact verified recipient, expiry, and absence of membership in the INSERT.
      const results = await db.batch([
        statement(`INSERT INTO team_members(team_id,account_id,role) SELECT i.team_id,?1,i.role FROM team_invitations i JOIN teams t ON t.id=i.team_id WHERE i.id=?2 AND i.email=?3 AND i.accepted_by IS NULL AND i.revoked_at IS NULL AND i.expires_at>?4 AND t.owner_id!=?1 AND (${roleSQL('i.team_id','i.inviter_id')}='owner' OR (${roleSQL('i.team_id','i.inviter_id')}='admin' AND i.role IN ('member','viewer'))) ON CONFLICT(team_id,account_id) DO NOTHING RETURNING *`, [actor,id,email,now()]),
        statement('UPDATE team_invitations SET accepted_by=?1 WHERE id=?2 AND changes()>0 RETURNING *', [actor,id]),
        statement("INSERT INTO task_audit(team_id,account_id,actor_id,action,subject,at) SELECT team_id,?1,?1,'invitation.accepted',id,?3 FROM team_invitations WHERE id=?2 AND changes()>0", [actor,id,now()]),
      ]);
      return results[0].results?.[0] ?? null;
    },
    revokeInvitation: (actor,team,id) => mutate(`UPDATE team_invitations SET revoked_at=?4 WHERE id=?3 AND team_id=?2 AND accepted_by IS NULL AND revoked_at IS NULL AND (${role('team_invitations.team_id')}='owner' OR (${role('team_invitations.team_id')}='admin' AND role IN ('member','viewer'))) RETURNING *`, [actor,team,id,now()], {actor,team,action:'invitation.revoked',subject:id}),
    labels: (actor,team=null) => all(`SELECT *,${role('task_labels.team_id')} AS role FROM task_labels WHERE ((?2 IS NULL AND team_id IS NULL AND account_id=?1) OR (team_id=?2 AND ${role('task_labels.team_id')} IS NOT NULL)) ORDER BY name LIMIT 100`, [actor,team]),
    createLabel: (actor,team,name,color) => {
      const id=crypto.randomUUID(), scope=team ? `team:${team}` : `account:${actor}`;
      return mutate(`INSERT INTO task_labels(id,account_id,team_id,scope_key,name,color) SELECT ?3,?1,?2,?4,?5,?6 WHERE (?2 IS NULL OR ${role('?2')} IN ('owner','admin')) AND (SELECT count(*) FROM task_labels WHERE scope_key=?4)<100 ON CONFLICT(scope_key,name) DO NOTHING RETURNING *`, [actor,team,id,scope,name,color], {actor,team,action:'label.created',subject:id});
    },
    editLabel: (actor,id,name,color,revision,team=null) => mutate(`UPDATE task_labels SET name=?3,color=?4,revision=revision+1 WHERE id=?2 AND revision=?5 AND (${scopeWrite}) AND NOT EXISTS(SELECT 1 FROM task_labels other WHERE other.scope_key=task_labels.scope_key AND other.name=?3 AND other.id!=?2) RETURNING *`, [actor,id,name,color,revision], {actor,team,action:'label.updated',subject:id}),
    task: (actor,id) => one(`SELECT tasks.*,${role('tasks.team_id')} AS role,(SELECT name FROM teams WHERE id=tasks.team_id) AS team_name FROM tasks WHERE id=?2 AND ${readSQL()}`, [actor,id]),
    scopedTask: (actor,number,kind,scope) => one(`SELECT tasks.*,${role('tasks.team_id')} AS role,(SELECT name FROM teams WHERE id=tasks.team_id) AS team_name FROM tasks WHERE number=?2 AND ((?3='accounts' AND team_id IS NULL AND account_id=?4) OR (?3='teams' AND team_id=?4)) AND ${readSQL()}`, [actor,number,kind,scope]),
    taskNumber: (actor,number,team='') => all(`SELECT tasks.*,${role('tasks.team_id')} AS role,(SELECT name FROM teams WHERE id=tasks.team_id) AS team_name FROM tasks WHERE number=?2 AND (?3='' OR (?3='personal' AND team_id IS NULL) OR team_id=?3) AND ${readSQL()} LIMIT 2`, [actor,number,team]),
    async list(actor,{q='',state='',team='',label='',project='',archived=false,before=null}={}) {
      return all(`SELECT tasks.id,tasks.number,tasks.account_id,tasks.team_id,tasks.assignee_id,tasks.title,tasks.project,tasks.state,tasks.priority,tasks.labels,tasks.revision,tasks.archived_at,tasks.created_at,tasks.updated_at,${role('tasks.team_id')} AS role,(SELECT name FROM teams WHERE id=tasks.team_id) AS team_name FROM tasks WHERE ${readSQL()} AND (?2='' OR instr(lower(title),lower(?2))>0 OR ('JOLO-'||number) LIKE upper(?2)||'%') AND (?3='' OR state=?3) AND (?4='' OR (?4='personal' AND team_id IS NULL) OR team_id=?4) AND (?5='' OR ?5 IN (SELECT value FROM json_each(labels))) AND ((?6=0 AND archived_at IS NULL) OR (?6=1 AND archived_at IS NOT NULL)) AND (?7 IS NULL OR id<?7) AND (?8='' OR project=?8) ORDER BY id DESC LIMIT 21`, [actor,q,state,team,label,Number(archived),before,project]);
    },
    async createTask(actor,fields) {
      const {team=null,assignee=null,title,description,project,state,priority,labels,requestID}=fields, mutation=crypto.randomUUID();
      const values=[actor,team,assignee,title,description,project,state,priority,JSON.stringify(labels),requestID,mutation,now()];
      await mutate(`INSERT INTO tasks(account_id,team_id,assignee_id,title,description,project,state,priority,labels,request_id,mutation_id,created_at,updated_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12 WHERE (?2 IS NULL OR ${role('?2')} IN ('owner','admin','member')) AND ${validAssignee} AND (?3 IS NULL OR ?3=?1 OR ${role('?2')} IN ('owner','admin')) AND ${validLabels} ON CONFLICT(account_id,request_id) DO NOTHING RETURNING *`, values, {actor,team,action:'task.created',subject:mutation});
      return one(`SELECT * FROM tasks WHERE account_id=?1 AND request_id=?2 AND ${readSQL()}`, [actor,requestID]);
    },
    updateTask(actor,id,fields,revision) {
      const {team=null,assignee=null,title,description,project,state,priority,labels}=fields, mutation=crypto.randomUUID();
      return mutate(`UPDATE tasks SET assignee_id=?3,title=?4,description=?5,project=?6,state=?7,priority=?8,labels=?9,revision=revision+1,mutation_id=?12,updated_at=?13 WHERE id=?10 AND revision=?11 AND archived_at IS NULL AND team_id IS ?2 AND ${writeSQL()} AND (assignee_id IS ?3 OR ${validAssignee}) AND (?2 IS NULL OR assignee_id IS ?3 OR ${role('?2')} IN ('owner','admin')) AND ${validLabels} RETURNING *`, [actor,team,assignee,title,description,project,state,priority,JSON.stringify(labels),id,revision,mutation,now()], {actor,team,action:'task.updated',subject:id});
    },
    archiveTask: (actor,id,revision,archive,team) => mutate(`UPDATE tasks SET archived_at=?4,revision=revision+1,updated_at=?5 WHERE id=?2 AND revision=?3 AND ${writeSQL()} RETURNING *`, [actor,id,revision,archive?now():null,now()], {actor,team,action:archive?'task.archived':'task.restored',subject:id}),
    audit: (actor,team=null) => all(`SELECT action,subject,at,actor_id FROM task_audit WHERE (?2 IS NULL AND team_id IS NULL AND account_id=?1) OR (team_id=?2 AND ${role('task_audit.team_id')} IN ('owner','admin')) ORDER BY id DESC LIMIT 50`, [actor,team]),
  };
}
