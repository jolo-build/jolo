import accounts from './0001_accounts.ts';
import devices from './0002_devices.ts';
import tasksTeams from './0003_tasks_teams.ts';
import mailOutbox from './0004_mail_outbox.ts';
import googleAuth from './0005_google_auth.ts';
import taskComments from './0006_task_comments.ts';

export interface D1Migration {
  /** Keep the original name: D1 records applied migrations by this identity. */
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly D1Migration[] = Object.freeze([
  { name: '0001_accounts.sql', sql: accounts },
  { name: '0002_devices.sql', sql: devices },
  { name: '0003_tasks_teams.sql', sql: tasksTeams },
  { name: '0004_mail_outbox.sql', sql: mailOutbox },
  { name: '0005_google_auth.sql', sql: googleAuth },
  { name: '0006_task_comments.sql', sql: taskComments },
]);
