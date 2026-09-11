export const taskKeyOf = task => `JOLO-${task.number}`;
export const taskPath = task => `/tasks/${task.team_id ? `teams/${task.team_id}` : `accounts/${task.account_id}`}/${taskKeyOf(task)}`;
