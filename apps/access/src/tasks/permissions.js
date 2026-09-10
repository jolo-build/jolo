export const canManage = role => role === 'owner' || role === 'admin';
export const canWriteTask = (task, actor) => !task.team_id ? task.account_id === actor : canManage(task.role) || (task.role === 'member' && [task.account_id, task.assignee_id].includes(actor));
export const canManageMember = (role, targetRole) => role === 'owner' || (role === 'admin' && ['member', 'viewer'].includes(targetRole));
// All SQL policy expressions read live membership. Never substitute a role
// cached by a previous HTTP request or accept a role supplied by a client.
export const roleSQL = (team, actor = '?1') => `(SELECT CASE WHEN _role_team.owner_id = ${actor} THEN 'owner' ELSE _role_member.role END FROM teams _role_team LEFT JOIN team_members _role_member ON _role_member.team_id = _role_team.id AND _role_member.account_id = ${actor} WHERE _role_team.id = ${team})`;
export const readSQL = (table = 'tasks', actor = '?1') => `((${table}.team_id IS NULL AND ${table}.account_id = ${actor}) OR ${roleSQL(`${table}.team_id`, actor)} IS NOT NULL)`;
export const writeSQL = (table = 'tasks', actor = '?1') => `((${table}.team_id IS NULL AND ${table}.account_id = ${actor}) OR ${roleSQL(`${table}.team_id`, actor)} IN ('owner','admin') OR (${roleSQL(`${table}.team_id`, actor)} = 'member' AND (${table}.account_id = ${actor} OR ${table}.assignee_id = ${actor})))`;
