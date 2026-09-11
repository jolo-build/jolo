import { expect, test } from 'bun:test';
import { fixture } from './fixture.js';
import { taskRepository } from '../src/tasks/repository.js';
import { commentRepository } from '../src/tasks/comments.js';

async function actor(f, n) {
  f.cookies.clear(); f.identity.id=n; f.identity.name=`Person ${n}`; f.emails[0].email=`person${n}@example.com`;
  await f.login();
  const account=f.sqlite.query('SELECT * FROM accounts WHERE provider_key=?').get(`github:${n}`);
  return {...account,cookie:[...f.cookies].map(([k,v])=>`${k}=${v}`).join('; '),csrf:f.sqlite.query('SELECT csrf FROM sessions WHERE account_id=?').get(account.id).csrf};
}
const get=(f,a,path)=>f.send(path,{headers:{cookie:a.cookie}});
function post(f,a,path,values={},origin=f.env.ACCESS_ORIGIN) {
  return f.send(path,{method:'POST',headers:{cookie:a.cookie,origin},body:new URLSearchParams({csrf:a.csrf,...values})});
}
async function setup(shared=false) {
  const f=fixture(),owner=await actor(f,1),other=await actor(f,2),viewer=await actor(f,3),outsider=await actor(f,4);
  const tasks=taskRepository(f.db,f.now),comments=commentRepository(f.db,f.now);
  const team=shared?await tasks.createTeam(owner.id,'Core'):null;
  if(team) for(const [a,role] of [[other,'member'],[viewer,'viewer']]) {
    const invitation=await tasks.invite(owner.id,team.id,a.email,role);
    await tasks.accept(a.id,invitation.id,a.email);
  }
  const task=await tasks.createTask(owner.id,{team:team?.id??null,title:'Discuss the fix',description:'Task description',project:'',state:'todo',priority:'normal',labels:[],requestID:crypto.randomUUID()});
  return {f,owner,other,viewer,outsider,tasks,comments,team,task,path:`/tasks/JOLO-${task.id}`};
}
const input=(body='A useful update')=>({body,request_id:crypto.randomUUID()});

test('comments persist, escape HTML, and post idempotently without changing task revisions',async()=>{
  const {f,owner,other,task,path}=await setup(),data=input('<script>alert(1)</script>\nSecond line');
  const first=await post(f,owner,path+'/comments',data);
  expect(first.status).toBe(303); expect(first.headers.get('location')).toBe(path+'#comment-1');
  expect((await post(f,owner,path+'/comments',data)).headers.get('location')).toBe(first.headers.get('location'));
  expect(f.sqlite.query('SELECT count(*) n FROM task_comments').get().n).toBe(1);
  expect(f.sqlite.query('SELECT revision FROM tasks WHERE id=?').get(task.id).revision).toBe(1);
  const html=await (await get(f,owner,path)).text();
  expect(html).toContain('Person 1'); expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(html).not.toContain('<script>alert');
  expect(html).toContain('id="comment-composer"'); expect(html).toContain('datetime=');
  expect((await get(f,other,path)).status).toBe(404);
  expect((await post(f,other,path+'/comments',input())).status).toBe(404);
  expect(f.sqlite.query("SELECT count(*) n FROM task_audit WHERE action='comment.created'").get().n).toBe(1);
});

test('own comments edit and delete with revision checks; failed edits keep the draft',async()=>{
  const {f,owner,path}=await setup(),data=input();
  await post(f,owner,path+'/comments',data);
  f.advance(1000);
  expect((await post(f,owner,path+'/comments/1/edit',{body:'Edited update',revision:'1'})).status).toBe(303);
  const conflict=await post(f,owner,path+'/comments/1/edit',{body:'Keep this draft',revision:'1'});
  expect(conflict.status).toBe(409);
  const html=await conflict.text();
  expect(html).toContain('Edited update'); expect(html).toContain('Keep this draft'); expect(html).toContain('class="comment-edit" open');
  expect((await post(f,owner,path+'/comments/1/delete',{revision:'1'})).status).toBe(409);
  expect((await post(f,owner,path+'/comments/1/delete',{revision:'2'})).status).toBe(303);
  expect(await (await get(f,owner,path)).text()).not.toContain('Edited update');
  const deleted=f.sqlite.query('SELECT * FROM task_comments').get();
  expect(deleted.body).toBe(''); expect(deleted.deleted_at).toBeGreaterThan(0);
  expect((await post(f,owner,path+'/comments',data)).status).toBe(303);
  expect(f.sqlite.query('SELECT count(*) n FROM task_comments').get().n).toBe(1);
  expect((await post(f,owner,path+'/comments/1/edit',{body:'Resurrect',revision:'3'})).status).toBe(404);
  expect(f.sqlite.query("SELECT action FROM task_audit WHERE action LIKE 'comment.%' ORDER BY id").all().map(row=>row.action)).toEqual(['comment.created','comment.edited','comment.deleted']);
});

test('team members can discuss any team task, viewers read only, and authors alone change comments',async()=>{
  const {f,owner,other,viewer,outsider,tasks,comments,task,team,path}=await setup(true);
  expect((await post(f,other,path+'/comments',input('Member discussion'))).status).toBe(303);
  expect((await post(f,owner,path+'/comments',input('Owner discussion'))).status).toBe(303);
  expect((await post(f,viewer,path+'/comments',input())).status).toBe(403);
  const read=await (await get(f,viewer,path)).text();
  expect(read).toContain('Member discussion'); expect(read).not.toContain('id="comment-composer"'); expect(read).not.toContain('Save comment');
  expect((await get(f,outsider,path)).status).toBe(404);
  for(const a of [owner,viewer]) for(const action of ['edit','delete']) expect((await post(f,a,`${path}/comments/1/${action}`,{body:'Changed',revision:'1'})).status).toBe(403);
  await tasks.setMember(owner.id,team.id,other.id,'admin',1);
  expect((await post(f,other,path+'/comments/2/edit',{body:'Admin takeover',revision:'1'})).status).toBe(403);
  await tasks.removeMember(owner.id,team.id,other.id,2);
  expect((await get(f,other,path)).status).toBe(404);
  expect(await comments.create(other.id,task.id,'Stale member',crypto.randomUUID())).toBeNull();
  expect(await comments.edit(other.id,task.id,1,'Stale edit',1)).toBeNull();
  expect(await comments.remove(other.id,task.id,1,1)).toBeNull();
  expect((await comments.list(other.id,task.id)).comments).toEqual([]);
});

test('archiving makes discussion read-only and live SQL rejects stale mutations',async()=>{
  const {f,owner,tasks,comments,task,path}=await setup();
  await post(f,owner,path+'/comments',input());
  await tasks.archiveTask(owner.id,task.id,1,true,null);
  const html=await (await get(f,owner,path)).text();
  expect(html).toContain('A useful update'); expect(html).not.toContain('id="comment-composer"');
  for(const action of ['', '/1/edit', '/1/delete']) expect((await post(f,owner,path+'/comments'+action,{...input(),revision:'1'})).status).toBe(403);
  expect(await comments.create(owner.id,task.id,'Stale archive',crypto.randomUUID())).toBeNull();
  expect(await comments.edit(owner.id,task.id,1,'Stale edit',1)).toBeNull();
  expect(await comments.remove(owner.id,task.id,1,1)).toBeNull();
  await tasks.archiveTask(owner.id,task.id,2,false,null);
  expect((await post(f,owner,path+'/comments',input('Restored discussion'))).status).toBe(303);
});

test('comment forms enforce CSRF, origin, bounded text, request identities, and retain rejected drafts',async()=>{
  const {f,owner,path}=await setup(),data=input();
  for(const origin of ['https://evil.example','null']) expect((await post(f,owner,path+'/comments',data,origin)).status).toBe(403);
  expect((await post(f,owner,path+'/comments',{...data,csrf:'wrong'})).status).toBe(403);
  for(const body of ['', '   ', '\u0000', 'x'.repeat(8193), '🙂'.repeat(2049)]) expect((await post(f,owner,path+'/comments',input(body))).status).toBe(400);
  const invalid=await post(f,owner,path+'/comments',{body:'Preserve my comment',request_id:'invalid'});
  expect(invalid.status).toBe(400); expect(await invalid.text()).toContain('Preserve my comment');
  await post(f,owner,path+'/comments',data);
  const duplicate=await post(f,owner,path+'/comments',{...data,body:'A different draft'});
  expect(duplicate.status).toBe(409);
  const html=await duplicate.text(); expect(html).toContain('A different draft'); expect(html).not.toContain(`value="${data.request_id}"`);
  const unauthenticated=await f.send(path+'/comments',{method:'POST',headers:{cookie:'',origin:f.env.ACCESS_ORIGIN},body:new URLSearchParams(data)});
  expect(unauthenticated.status).toBe(401);
});

test('history pages are bounded and chronological, and comment IDs cannot cross tasks',async()=>{
  const {f,owner,other,comments,tasks,task,path}=await setup();
  for(let i=1;i<=53;i++) await comments.create(owner.id,task.id,`Update ${i}`,crypto.randomUUID());
  const latest=await comments.list(owner.id,task.id);
  expect(latest.comments).toHaveLength(50); expect(latest.comments[0].body).toBe('Update 4'); expect(latest.comments.at(-1).body).toBe('Update 53'); expect(latest.older).toBe(4);
  expect((await comments.list(owner.id,task.id,latest.older)).comments.map(c=>c.body)).toEqual(['Update 1','Update 2','Update 3']);
  const older=await (await get(f,owner,path+'?comments_before=4#comments')).text();
  expect(older).toContain('Latest comments'); expect(older).toContain('Update 3'); expect(older).not.toContain('Update 4');
  for(const value of ['0','-1','NaN','1.5','9007199254740992']) expect((await get(f,owner,path+'?comments_before='+value)).status).toBe(400);
  const another=await tasks.createTask(owner.id,{team:null,title:'Other task',description:'',project:'',state:'todo',priority:'normal',labels:[],requestID:crypto.randomUUID()});
  expect((await post(f,owner,`/tasks/JOLO-${another.id}/comments/1/delete`,{revision:'1'})).status).toBe(404);
  expect((await comments.list(other.id,task.id)).comments).toEqual([]);
});

test('comment mutations roll back when their audit transaction fails',async()=>{
  const {f,owner,path}=await setup();
  f.sqlite.exec("CREATE TRIGGER fail_comment_audit BEFORE INSERT ON task_audit WHEN NEW.action='comment.created' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  expect((await post(f,owner,path+'/comments',input())).status).toBe(503);
  expect(f.sqlite.query('SELECT count(*) n FROM task_comments').get().n).toBe(0);
});
