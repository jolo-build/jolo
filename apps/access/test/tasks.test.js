import { expect, test } from 'bun:test';
import { fixture } from './fixture.js';
import { taskPath, taskKeyOf } from '../src/tasks/identity.js';
import { taskRepository } from '../src/tasks/repository.js';
import { createRepository } from '../src/storage.js';
import { randomToken, hashToken } from '../src/security.js';

async function actor(f,n) {
  f.cookies.clear(); f.identity.id=n; f.identity.name=`Person ${n}`; f.emails[0].email=`person${n}@example.com`;
  await f.login();
  const account=f.sqlite.query('SELECT * FROM accounts WHERE provider_key=?').get(`github:${n}`);
  return {...account,cookie:[...f.cookies].map(([k,v])=>`${k}=${v}`).join('; '),csrf:f.sqlite.query('SELECT csrf FROM sessions WHERE account_id=?').get(account.id).csrf};
}
function post(f,a,path,values={},origin=f.env.ACCESS_ORIGIN) {
  const body=new URLSearchParams();
  for(const [key,value] of Object.entries({csrf:a.csrf,...values})) for(const item of Array.isArray(value)?value:[value]) body.append(key,item??'');
  return f.send(path,{method:'POST',headers:{cookie:a.cookie,origin,'content-type':'application/x-www-form-urlencoded'},body});
}
const get=(f,a,path)=>f.send(path,{headers:{cookie:a.cookie}});
const fields=(extra={})=>({title:'Fix the sign-in form',description:'Reproduce, fix, and test the browser flow.',project:'jolo',state:'todo',priority:'normal',team:'',assignee:'',request_id:crypto.randomUUID(),...extra});
async function setup() {
  const f=fixture(),owner=await actor(f,1),admin=await actor(f,2),member=await actor(f,3),viewer=await actor(f,4),outsider=await actor(f,5),repo=taskRepository(f.db,f.now);
  const team=await repo.createTeam(owner.id,'Core');
  for(const [a,role] of [[admin,'admin'],[member,'member'],[viewer,'viewer']]) {
    const invite=await repo.invite(owner.id,team.id,a.email,role);
    expect(await repo.accept(a.id,invite.id,a.email)).not.toBeNull();
  }
  return {f,owner,admin,member,viewer,outsider,repo,team};
}

test('personal task forms create idempotently, edit with revisions, archive, and escape content', async()=>{
  const f=fixture(),a=await actor(f,1),b=await actor(f,2),input=fields({title:'<script>alert(1)</script>'});
  const created=await post(f,a,'/tasks',input);
  expect(created.status).toBe(303);
  const location=created.headers.get('location');
  expect((await post(f,a,'/tasks',input)).headers.get('location')).toBe(location);
  expect(f.sqlite.query('SELECT count(*) n FROM tasks').get().n).toBe(1);
  const page=await (await get(f,a,location)).text();
  expect(page).toContain('&lt;script&gt;'); expect(page).not.toContain('<script>');
  expect(page).toContain(`href="${location}/edit"`); expect(page).not.toContain('id="task-edit"');
  const editor=await (await get(f,a,location+'/edit')).text();
  expect(editor).toContain('id="task-edit"'); expect(editor).toContain(`href="${location}">Cancel</a>`);
  expect(editor).toContain('&lt;script&gt;'); expect(editor).not.toContain('<script>');
  expect((await get(f,b,location)).status).toBe(404);
  expect((await get(f,b,location+'/edit')).status).toBe(404);
  expect((await post(f,a,location+'/edit',{...input,revision:'1'})).status).toBe(404);
  expect((await post(f,b,location,{...input,revision:'1'})).status).toBe(404);
  expect((await post(f,a,location,{...input,revision:'1',state:'in_progress'})).status).toBe(303);
  const conflict=await post(f,a,location,{...input,revision:'1',title:'Keep my draft'});
  const conflictPage=await conflict.text();
  expect(conflict.status).toBe(409); expect(conflictPage).toContain('value="Keep my draft"'); expect(conflictPage).toContain('id="task-edit"');
  expect((await post(f,a,location+'/archive',{revision:'2'})).status).toBe(303);
  const archived=await (await get(f,a,location)).text();
  expect(archived).toContain('Restore task'); expect(archived).not.toContain(`href="${location}/edit"`);
  expect((await get(f,a,location+'/edit')).headers.get('location')).toBe(location);
  expect((await get(f,a,'/tasks')).status).toBe(200);
  expect((await get(f,a,'/tasks?archived=1')).status).toBe(200);
  expect((await post(f,a,location+'/restore',{revision:'3'})).status).toBe(303);
  const staleArchive=await post(f,a,location+'/archive',{revision:'3'});
  expect(staleArchive.status).toBe(409);
  const archiveConflict=await staleArchive.text();
  expect(archiveConflict).toContain('This record changed'); expect(archiveConflict).toContain('&lt;script&gt;'); expect(archiveConflict).not.toContain('id="task-edit"');
  expect(f.sqlite.query('SELECT count(*) n FROM task_audit WHERE action LIKE \'task.%\'').get().n).toBe(4);
});

test('every team role enforces task writes and assignee restrictions on direct HTTP requests', async()=>{
  const {f,owner,admin,member,viewer,outsider,repo,team}=await setup();
  for(const a of [owner,admin,member]) expect((await post(f,a,'/tasks',fields({team:team.id}))).status).toBe(303);
  expect((await post(f,viewer,'/tasks',fields({team:team.id}))).status).toBe(403);
  expect((await post(f,outsider,'/tasks',fields({team:team.id}))).status).toBe(404);
  const task=f.sqlite.query('SELECT * FROM tasks WHERE account_id=?').get(owner.id),path=taskPath(task);
  for(const a of [owner,admin,member,viewer]) {
    const detail=await (await get(f,a,path)).text();
    expect(detail).not.toContain('id="task-edit"');
    expect(detail.includes(`href="${path}/edit"`)).toBe([owner,admin].includes(a));
    expect((await get(f,a,path+'/edit')).status).toBe([owner,admin].includes(a)?200:403);
  }
  const edit=fields({team:team.id,revision:'1',state:'done'});
  for(const a of [member,viewer]) expect((await post(f,a,path,edit)).status).toBe(403);
  expect((await post(f,outsider,path,edit)).status).toBe(404);
  expect((await post(f,admin,path,{...edit,assignee:member.id})).status).toBe(303);
  expect((await get(f,member,path+'/edit')).status).toBe(200);
  expect((await post(f,member,path,{...edit,assignee:member.id,revision:'2'})).status).toBe(303);
  expect((await post(f,member,path,{...edit,assignee:admin.id,revision:'3'})).status).toBe(409);
  expect((await post(f,admin,path,{...edit,assignee:outsider.id,revision:'3'})).status).toBe(409);
  expect((await get(f,viewer,path)).status).toBe(200);
  const before=await repo.task(member.id,task.id);
  await repo.removeMember(owner.id,team.id,member.id,1);
  expect((await get(f,member,path+'/edit')).status).toBe(404);
  expect(await repo.task(member.id,task.id)).toBeNull();
  expect(await repo.updateTask(member.id,task.id,{team:team.id,assignee:member.id,title:'stale',description:'',project:'',state:'done',priority:'normal',labels:[]},before.revision)).toBeNull();
});

test('label IDs and task keys cannot cross personal or team boundaries',async()=>{
  const {f,owner,admin,member,viewer,outsider,repo,team}=await setup();
  const personal=await repo.createLabel(owner.id,null,'Private','blue');
  const shared=await repo.createLabel(owner.id,team.id,'Bug','red');
  const foreign=await repo.createLabel(outsider.id,null,'Secret','purple');
  expect((await post(f,member,'/labels',{team:team.id,name:'Exploit',color:'red'})).status).toBe(403);
  expect((await post(f,viewer,`/labels/${shared.id}`,{team:team.id,name:'Changed',color:'blue',revision:'1'})).status).toBe(403);
  expect((await post(f,admin,`/labels/${shared.id}`,{team:team.id,name:'Bug fix',color:'yellow',revision:'1'})).status).toBe(303);
  for(const label of [personal.id,foreign.id]) expect((await post(f,owner,'/tasks',fields({team:team.id,label}))).status).toBe(403);
  expect((await post(f,owner,'/tasks',fields({label:shared.id}))).status).toBe(403);
  const r=await post(f,member,'/tasks',fields({team:team.id,label:shared.id})); expect(r.status).toBe(303);
  expect(await (await get(f,viewer,r.headers.get('location'))).text()).toContain('Bug fix');
  expect(await (await get(f,outsider,'/tasks')).text()).not.toContain('Fix the sign-in form');
  expect((await get(f,outsider,`/tasks?team=${team.id}`)).status).toBe(404);
  expect((await post(f,outsider,`/labels/${personal.id}`,{name:'Stolen',color:'blue',revision:'1'})).status).toBe(404);
});

test('invitations require exact recipients, current inviter authority, expiry, and single acceptance',async()=>{
  const {f,owner,admin,member,viewer,outsider,repo,team}=await setup();
  expect(await repo.invite(member.id,team.id,outsider.email,'viewer')).toBeNull();
  expect(await repo.invite(viewer.id,team.id,outsider.email,'viewer')).toBeNull();
  expect(await repo.invite(admin.id,team.id,outsider.email,'admin')).toBeNull();
  const invitation=await repo.invite(admin.id,team.id,outsider.email,'member');
  expect(await repo.accept(member.id,invitation.id,member.email)).toBeNull();
  await repo.removeMember(owner.id,team.id,admin.id,1);
  expect(await repo.accept(outsider.id,invitation.id,outsider.email)).toBeNull();
  await repo.revokeInvitation(owner.id,team.id,invitation.id);
  const fresh=await repo.invite(owner.id,team.id,outsider.email,'viewer');
  const results=await Promise.all([repo.accept(outsider.id,fresh.id,outsider.email),repo.accept(outsider.id,fresh.id,outsider.email)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const another=await actor(f,6),expired=await repo.invite(owner.id,team.id,another.email,'admin');
  f.advance(7*86400_000);
  expect(await repo.accept(another.id,expired.id,another.email)).toBeNull();
});

test('admins cannot promote themselves, manage other admins, or remove the owner',async()=>{
  const {owner,admin,member,viewer,repo,team}=await setup();
  expect(await repo.setMember(admin.id,team.id,admin.id,'member',1)).toBeNull();
  expect(await repo.setMember(admin.id,team.id,member.id,'admin',1)).toBeNull();
  expect(await repo.setMember(member.id,team.id,member.id,'admin',1)).toBeNull();
  expect(await repo.removeMember(admin.id,team.id,owner.id,0)).toBeNull();
  expect(await repo.removeMember(owner.id,team.id,owner.id,0)).toBeNull();
  expect(await repo.renameTeam(admin.id,team.id,'Taken',1)).toBeNull();
  expect(await repo.setMember(admin.id,team.id,viewer.id,'member',1)).not.toBeNull();
  expect(await repo.setMember(owner.id,team.id,member.id,'admin',1)).not.toBeNull();
  expect(await repo.removeMember(admin.id,team.id,member.id,2)).toBeNull();
});

test('all web mutations require origin and CSRF, including forged invitation and membership actions',async()=>{
  const {f,owner,member,repo,team}=await setup();
  // Each entry is a path and the form fields to post to it, so keep the pair a tuple rather than a
  // mixed array; the loop below spreads the fields to forge a CSRF token.
  /** @type {[string, Record<string, string>][]} */
  const requests=[['/tasks',fields()],['/teams',{name:'Injected'}],['/labels',{name:'Injected',color:'red'}],[`/teams/${team.id}/invite`,{email:'a@example.com',role:'admin'}],[`/teams/${team.id}/members/${member.id}/remove`,{revision:'1'}],[`/invitations/${crypto.randomUUID()}/accept`,{}]];
  for(const [path,data] of requests) {
    expect((await post(f,owner,path,data,'https://evil.example')).status).toBe(403);
    expect((await post(f,owner,path,{...data,csrf:'wrong'})).status).toBe(403);
    expect((await post(f,owner,path,data,'null')).status).toBe(403);
  }
  expect(await repo.team(member.id,team.id)).not.toBeNull();
});

test('device scope is explicit and team removal immediately blocks API reads',async()=>{
  const {f,owner,member,repo,team}=await setup();
  const r=await post(f,owner,'/tasks',fields({team:team.id})),path='/api'+r.headers.get('location');
  const auth=createRepository(f.db,f.now),identityToken=randomToken(),tasksToken=randomToken();
  await auth.createDevice(crypto.randomUUID(),await hashToken(identityToken),member.id,'Identity only',f.now()+100_000);
  await auth.createDevice(crypto.randomUUID(),await hashToken(tasksToken),member.id,'Task access',f.now()+100_000,'account:read tasks:read');
  const read=token=>f.send(path,{headers:{cookie:'',authorization:`Bearer ${token}`}});
  expect((await read(identityToken)).status).toBe(403);
  expect((await read(tasksToken)).status).toBe(200);
  expect((await f.send(path+'/edit',{headers:{cookie:'',authorization:`Bearer ${tasksToken}`}})).status).toBe(404);
  expect((await f.send('/api/tasks',{method:'POST',headers:{authorization:`Bearer ${tasksToken}`}})).status).toBe(405);
  await repo.removeMember(owner.id,team.id,member.id,1);
  expect((await read(tasksToken)).status).toBe(404);
  expect((await read('a'.repeat(64))).status).toBe(401);
});

test('scope approval is displayed and cannot silently grant unknown permissions',async()=>{
  const f=fixture(),a=await actor(f,1);
  const start=scope=>post(f,a,'/device/code',{client_id:'jolo',device_name:'Tasks',scope});
  expect((await start('account:read tasks:write')).status).toBe(400);
  const grant=await (await start('account:read tasks:read')).json();
  expect(await (await get(f,a,`/device?user_code=${grant.user_code}`)).text()).toContain('selected coding agent');
  await post(f,a,'/device/approve',{user_code:grant.user_code,decision:'approved'});
  f.advance(5000);
  const issued=await (await post(f,a,'/device/token',{client_id:'jolo',device_code:grant.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'})).json();
  expect(issued.scope).toBe('account:read tasks:read');
});

test('demotion and foreign team IDs cannot bypass conditional SQL, and audit rolls back with mutations',async()=>{
  const {f,owner,admin,member,outsider,repo,team}=await setup();
  const other=await repo.createTeam(outsider.id,'Other');
  expect(await repo.createLabel(admin.id,other.id,'Stolen','red')).toBeNull();
  expect(await repo.invite(admin.id,other.id,member.email,'viewer')).toBeNull();
  const task=await repo.createTask(owner.id,{team:team.id,assignee:null,title:'Atomic',description:'',project:'',state:'todo',priority:'normal',labels:[],requestID:crypto.randomUUID()});
  await repo.setMember(owner.id,team.id,admin.id,'viewer',1);
  expect(await repo.updateTask(admin.id,task.id,{...task,team:team.id,assignee:null,labels:[]},1)).toBeNull();
  expect((await repo.audit(owner.id,team.id)).some(a=>a.subject===taskKeyOf(task)&&a.action==='task.created')).toBe(true);
  expect((await repo.audit(admin.id,team.id))).toEqual([]);
  const before=f.sqlite.query('SELECT count(*) n FROM teams').get().n;
  f.sqlite.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON task_audit BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  await expect(repo.createTeam(owner.id,'Must roll back')).rejects.toThrow();
  expect(f.sqlite.query('SELECT count(*) n FROM teams').get().n).toBe(before);
});

test('task validation preserves rejected drafts and cannot accept oversized or duplicate-label payloads',async()=>{
  const {f,owner,repo}=await setup();
  const label=await repo.createLabel(owner.id,null,'Bug','red');
  for(const extra of [{description:'🐈'.repeat(2100)},{state:'admin'},{label:[label.id,label.id]},{priority:'owner'}]) {
    const result=await post(f,owner,'/tasks',fields({...extra,title:'Keep this draft'}));
    expect(result.status).toBe(400); expect(await result.text()).toContain('Keep this draft');
  }
  expect(f.sqlite.query('SELECT count(*) n FROM tasks').get().n).toBe(0);
});

test('personal accounts and teams number tickets independently, including concurrent creators and retries',async()=>{
  const {f,owner,member,viewer,outsider,repo,team}=await setup();
  const secondTeam=await repo.createTeam(owner.id,'Second team');
  const create=(a,scope=null,requestID=crypto.randomUUID())=>repo.createTask(a.id,{team:scope,title:'Scoped task',description:'',project:'',state:'todo',priority:'normal',labels:[],requestID});
  const a=await create(owner),b=await create(outsider),shared=await create(owner,team.id),other=await create(owner,secondTeam.id);
  expect([a.number,b.number,shared.number,other.number]).toEqual([1,1,1,1]);
  expect(new Set([a.id,b.id,shared.id,other.id]).size).toBe(4);
  expect(await create(viewer,team.id)).toBeNull();
  expect(await create(outsider,team.id)).toBeNull();
  const requestID=crypto.randomUUID();
  const repeated=await Promise.all([create(member,team.id,requestID),create(member,team.id,requestID)]);
  expect(repeated.map(t=>t.number)).toEqual([2,2]); expect(repeated[0].id).toBe(repeated[1].id);
  const parallel=await Promise.all([create(member,team.id),create(owner,team.id)]);
  expect(parallel.map(t=>t.number).sort()).toEqual([3,4]);
  await repo.archiveTask(owner.id,a.id,1,true,null);
  expect((await create(owner)).number).toBe(2);
  const before=f.sqlite.query('SELECT * FROM task_sequences ORDER BY scope_key').all();
  f.sqlite.exec("CREATE TRIGGER reject_task_audit BEFORE INSERT ON task_audit WHEN NEW.action='task.created' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  await expect(create(owner,team.id)).rejects.toThrow();
  expect(f.sqlite.query('SELECT * FROM task_sequences ORDER BY scope_key').all()).toEqual(before);
  f.sqlite.exec('DROP TRIGGER reject_task_audit');
  expect((await create(owner,team.id)).number).toBe(5);
  expect((await repo.audit(owner.id,team.id)).filter(a=>a.action==='task.created').map(a=>a.subject).sort()).toEqual(['CORE-1','CORE-2','CORE-3','CORE-4','CORE-5']);
});

test('unique workspace keys resolve directly while old scoped and global links preserve their task',async()=>{
  const {f,owner,member,outsider,repo,team}=await setup();
  const personal=(await post(f,owner,'/tasks',fields({title:'Owner personal'}))).headers.get('location');
  const foreign=(await post(f,outsider,'/tasks',fields({title:'Outsider personal'}))).headers.get('location');
  const shared=(await post(f,member,'/tasks',fields({title:'Team task',team:team.id}))).headers.get('location');
  expect([personal,foreign,shared].map(p=>p.split('/').at(-1))).toEqual(['PERSON1-1','PERSON5-1','CORE-1']);
  expect(new Set([personal,foreign,shared]).size).toBe(3);
  expect(await (await get(f,owner,personal)).text()).toContain('Owner personal');
  expect((await get(f,outsider,personal)).status).toBe(404);
  expect((await get(f,owner,foreign)).status).toBe(404);
  expect(await (await get(f,owner,shared)).text()).toContain('Team task');
  expect((await post(f,owner,shared,fields({team:team.id,title:'Edited team',revision:'1'}))).status).toBe(303);
  expect((await post(f,owner,shared+'/comments',{body:'Shared discussion',request_id:crypto.randomUUID()})).status).toBe(303);
  expect(await (await get(f,member,shared)).text()).toContain('Shared discussion');
  expect(await (await get(f,owner,personal)).text()).not.toContain('Shared discussion');
  expect(await (await get(f,owner,'/tasks?q=PERSON1-1&team=personal')).text()).toContain('Owner personal');
  expect(await (await get(f,owner,`/tasks?q=CORE-1&team=${team.id}`)).text()).not.toContain('Owner personal');
  const token=randomToken();
  await createRepository(f.db,f.now).createDevice(crypto.randomUUID(),await hashToken(token),owner.id,'Task access',f.now()+100_000,'account:read tasks:read');
  const api=path=>f.send(path,{headers:{cookie:'',authorization:`Bearer ${token}`}});
  expect((await api('/api/tasks/JOLO-1')).status).toBe(404);
  expect((await api('/api/tasks/PERSON5-1')).status).toBe(404);
  expect((await api('/api/tasks/CORE-1?team=personal')).status).toBe(404);
  expect((await (await api('/api/tasks/PERSON1-1?team=personal')).json()).task.title).toBe('Owner personal');
  expect((await (await api(`/api/tasks/CORE-1?team=${team.id}`)).json()).task.title).toBe('Edited team');
  expect((await (await api('/api'+shared)).json()).task.title).toBe('Edited team');
  expect((await api('/api'+foreign)).status).toBe(404);
  const list=await (await api('/api/tasks?q=')).json();
  expect(list.tasks.map(t=>t.key)).toEqual(['CORE-1','PERSON1-1']);
  expect(new Set(list.tasks.map(t=>t.url)).size).toBe(2);
  expect((await (await api('/api/tasks/core-1')).json()).task.title).toBe('Edited team');
  expect((await get(f,owner,'/tasks/CORE-1')).headers.get('location')).toBe(shared);
  const legacyShared=shared.replace('/CORE-1','/JOLO-1');
  expect((await get(f,owner,legacyShared)).headers.get('location')).toBe(shared);
  expect((await (await api('/api'+legacyShared)).json()).task.key).toBe('CORE-1');
  expect((await api('/api'+shared.replace('/CORE-1','/PERSON1-1'))).status).toBe(404);
  const original=f.sqlite.query("SELECT id FROM tasks WHERE title='Edited team'").get().id;
  expect((await get(f,owner,`/tasks/JOLO-${original}`)).headers.get('location')).toBe(shared);
  await repo.removeMember(owner.id,team.id,member.id,1);
  expect((await get(f,member,shared)).status).toBe(404);
});

test('team prefixes are chosen at creation, globally unique, case insensitive, and stable across renames',async()=>{
  const {f,owner,outsider,repo}=await setup();
  const created=await post(f,owner,'/teams',{name:'JOLO security',prefix:'jolo'});
  expect(created.status).toBe(303);
  const team=await repo.team(owner.id,created.headers.get('location').split('/').at(-1));
  expect(team.prefix).toBe('JOLO');
  const before=f.sqlite.query('SELECT count(*) n FROM teams').get().n;
  for(const prefix of ['jolo','PERSON1']) {
    const duplicate=await post(f,outsider,'/teams',{name:'Keep my team draft',prefix});
    expect(duplicate.status).toBe(409); expect(await duplicate.text()).toContain('Keep my team draft');
  }
  for(const prefix of ['X','3TEAM','MY-TEAM','x'.repeat(25),'CYPHÖ']) expect((await post(f,owner,'/teams',{name:'Invalid',prefix})).status).toBe(400);
  expect(f.sqlite.query('SELECT count(*) n FROM teams').get().n).toBe(before);
  expect((await post(f,owner,`/teams/${team.id}/rename`,{name:'New name',revision:'1'})).status).toBe(303);
  expect((await repo.team(owner.id,team.id)).prefix).toBe('JOLO');
  const results=await Promise.all([repo.createTeam(owner.id,'Race A','RACE'),repo.createTeam(outsider.id,'Race B','race')]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(f.sqlite.query("SELECT count(*) n FROM teams WHERE name LIKE 'Race %'").get().n).toBe(1);
  const createdTask=await post(f,owner,'/tasks',fields({team:team.id}));
  expect(createdTask.headers.get('location')).toEndWith('/JOLO-1');
  expect(await (await get(f,owner,createdTask.headers.get('location'))).text()).toContain('@codex fix #JOLO-1');
});

test('personal prefix assignment survives sign-in changes and concurrent name collisions',async()=>{
  const f=fixture(),auth=createRepository(f.db,f.now);
  const results=await Promise.all([
    auth.account({id:'one',name:'Same Name',email:'one@example.com'}),
    auth.account({id:'two',name:'Same Name',email:'two@example.com'}),
    auth.account({id:'one',name:'Same Name',email:'one@example.com'}),
  ]);
  expect(results[0].id).toBe(results[2].id);
  const before=f.sqlite.query('SELECT prefix,account_id FROM task_prefixes ORDER BY prefix').all();
  expect(before.map(p=>p.prefix)).toEqual(['SAMENAME','SAMENAME2']);
  await auth.account({id:'one',name:'Changed Name',email:'changed@example.com'});
  expect(f.sqlite.query('SELECT prefix,account_id FROM task_prefixes ORDER BY prefix').all()).toEqual(before);
  const repo=taskRepository(f.db,f.now);
  expect(await repo.createTeam(results[0].id,'A team','SAMENAME')).toBeNull();
  const automatic=await repo.createTeam(results[0].id,'Same Name');
  expect(automatic.prefix).toBe('SAMENAME3');
  f.sqlite.exec("CREATE TRIGGER reject_prefix_audit BEFORE INSERT ON task_audit BEGIN SELECT RAISE(ABORT,'test failure'); END");
  await expect(repo.createTeam(results[0].id,'Rollback','ROLLBACK')).rejects.toThrow();
  expect(f.sqlite.query("SELECT count(*) n FROM task_prefixes WHERE prefix='ROLLBACK'").get().n).toBe(0);
  expect(f.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
});
