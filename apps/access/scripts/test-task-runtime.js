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
    import { commentRepository } from './comments.js';
    export default {async fetch(request,env) {
      const repo=taskRepository(env.DB); const team=await repo.createTeam('owner','Runtime team');
      const invitation=await repo.invite('owner',team.id,'member@example.com','member',{from:'fixture@example.com',to:['member@example.com'],subject:'Fixture',text:'Fixture'});
      const mail=await env.DB.prepare('SELECT state,payload FROM mail_outbox WHERE id=?').bind(invitation.id).first();
      await repo.accept('member',invitation.id,'member@example.com');
      const label=await repo.createLabel('owner',team.id,'Bug','red');
      const fields={team:team.id,title:'Runtime task',description:'Fixture',project:'jolo',state:'todo',priority:'normal',labels:[label.id],requestID:crypto.randomUUID()};
      const task=await repo.createTask('member',fields);
      const edited=await repo.updateTask('member',task.id,{...fields,state:'in_progress'},1);
      const comments=commentRepository(env.DB),requestID=crypto.randomUUID();
      const comment=await comments.create('member',task.id,'D1 comment',requestID);
      const replay=await comments.create('member',task.id,'D1 comment',requestID);
      const revised=await comments.edit('member',task.id,comment.id,'Edited in D1',1);
      const history=await comments.list('owner',task.id);
      const ownOnly=await comments.edit('owner',task.id,comment.id,'Not the author',2);
      const removedComment=await comments.remove('member',task.id,comment.id,2);
      const deletedReplay=await comments.create('member',task.id,'D1 comment',requestID);
      await repo.removeMember('owner',team.id,'member',1);
      const deniedComment=await comments.create('member',task.id,'After removal',crypto.randomUUID());
      const denied=await repo.task('member',task.id);
      const stale=await repo.updateTask('member',task.id,{...fields,state:'done'},2);
      return Response.json({revision:edited.revision,denied,stale,mail,comment,replay,revised,history,ownOnly,removedComment,deletedReplay,deniedComment,audit:await repo.audit('owner',team.id)});
    }};`},...['repository.js','permissions.js','comments.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL(name,root)),contents:readFileSync(new URL(name,root),'utf8')}))],
}));
try {
  const db=await runtime.getD1Database('DB');
  const migrations=new URL('../.generated/migrations/',import.meta.url);
  for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort()) {
    const sql=readFileSync(new URL(name,migrations),'utf8').replace(/--[^\n]*/g,'');
    await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  }
  for(const id of ['owner','member']) await db.prepare('INSERT INTO accounts(id,provider_key,email,name,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind(id,'github:'+id,id+'@example.com',id).run();
  const response=await runtime.dispatchFetch('https://fixture.example/');
  assert.equal(response.status,200,await response.clone().text());
  const result=await response.json(); assert.equal(result.revision,2); assert.equal(result.denied,null);assert.equal(result.stale,null);
  assert.equal(result.mail.state,'pending');assert.equal(JSON.parse(result.mail.payload).to[0],'member@example.com');
  assert.equal(result.audit.length,10); assert(result.audit.some(a=>a.action==='task.created'&&a.subject==='JOLO-1'));
  assert.equal(result.comment.id,result.replay.id);assert.equal(result.revised.revision,2);assert.equal(result.history.comments[0].body,'Edited in D1');
  assert.equal(result.ownOnly,null);assert.equal(result.deniedComment,null);assert.equal(result.removedComment.body,'');assert.equal(result.deletedReplay.id,result.comment.id);assert(result.deletedReplay.deleted_at);
  console.log('D1 runtime checks passed: task and comment writes, idempotent posting, authorship, deletion, invitation acceptance, audit transactions, revocation, and stale-write rejection.');
} finally {await runtime.dispose();}
