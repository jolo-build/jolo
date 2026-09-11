import { expect, test } from 'bun:test';
import { fixture } from './fixture.js';
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
  const task=f.sqlite.query('SELECT * FROM tasks WHERE account_id=?').get(owner.id),path=`/tasks/JOLO-${task.id}`;
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
  expect((await repo.audit(owner.id,team.id)).some(a=>a.subject===`JOLO-${task.id}`&&a.action==='task.created')).toBe(true);
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
