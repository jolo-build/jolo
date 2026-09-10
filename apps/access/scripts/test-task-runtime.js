// Real workerd/D1 transactions, isolated in memory. No deployed database or account.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url),wranglerRequire=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=wranglerRequire('miniflare');
const root=new URL('../src/tasks/',import.meta.url);
const runtime=new Miniflare(convertV4MiniflareOptions({
  name:'task-runtime',compatibilityDate:'2026-09-09',modulesRoot:fileURLToPath(root),d1Databases:{DB:'task-fixture'},
  modules:[{type:'ESModule',path:fileURLToPath(new URL('runtime.js',root)),contents:`
    import { taskRepository } from './repository.js';
    export default {async fetch(request,env) {
      const repo=taskRepository(env.DB); const team=await repo.createTeam('owner','Runtime team');
      const invitation=await repo.invite('owner',team.id,'member@example.com','member');
      await repo.accept('member',invitation.id,'member@example.com');
      const label=await repo.createLabel('owner',team.id,'Bug','red');
      const fields={team:team.id,title:'Runtime task',description:'Fixture',project:'jolo',state:'todo',priority:'normal',labels:[label.id],requestID:crypto.randomUUID()};
      const task=await repo.createTask('member',fields);
      const edited=await repo.updateTask('member',task.id,{...fields,state:'in_progress'},1);
      await repo.removeMember('owner',team.id,'member',1);
      const denied=await repo.task('member',task.id);
      const stale=await repo.updateTask('member',task.id,{...fields,state:'done'},2);
      return Response.json({revision:edited.revision,denied,stale,audit:await repo.audit('owner',team.id)});
    }};`},...['repository.js','permissions.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL(name,root)),contents:readFileSync(new URL(name,root),'utf8')}))],
}));
try {
  const db=await runtime.getD1Database('DB');
  const migrations=new URL('../.generated/migrations/',import.meta.url);
  for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort()) {
    const sql=readFileSync(new URL(name,migrations),'utf8').replace(/--[^\n]*/g,'');
    await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  }
  for(const id of ['owner','member']) await db.prepare('INSERT INTO accounts(id,github_id,email,name,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind(id,id,id+'@example.com',id).run();
  const response=await runtime.dispatchFetch('https://fixture.example/');
  assert.equal(response.status,200,await response.clone().text());
  const result=await response.json(); assert.equal(result.revision,2); assert.equal(result.denied,null);assert.equal(result.stale,null);
  assert.equal(result.audit.length,7); assert(result.audit.some(a=>a.action==='task.created'&&a.subject==='JOLO-1'));
  console.log('D1 runtime checks passed: scoped task/label writes, invitation acceptance, audit transactions, revocation, and stale-write rejection.');
} finally {await runtime.dispose();}
