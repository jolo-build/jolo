import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile(new URL('../../../deploy/access.wrangler.jsonc', import.meta.url), 'utf8'));
const id = config.d1_databases.find(database => database.binding === 'ACCESS_DB')?.database_id;
if (!id || id === '00000000-0000-0000-0000-000000000000') {
  console.error('Create the production D1 database and set its database_id in deploy/access.wrangler.jsonc before deploying. See apps/access/README.md.');
  process.exit(1);
}
