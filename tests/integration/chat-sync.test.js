import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fixture } from '../../apps/access/test/fixture.js';
import { createRepository } from '../../apps/access/src/storage.js';
import { hashToken } from '../../apps/access/src/security.js';
import { Storage } from '../../apps/engine/src/storage/index.js';
import { ChatSync } from '../../apps/engine/src/account/chat-sync.js';
import { PermissionService } from '../../apps/engine/src/permissions/service.js';
import { linkChatFolder } from '../../apps/engine/src/account/chat-context.js';
import { RunService } from '../../apps/engine/src/runs/service.js';
import { validChat } from '../../packages/protocol/src/chat-sync.js';

const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const web = fixture(); await web.login();
  const owner = web.sqlite.query('SELECT id FROM accounts').get().id;
  const repo = createRepository(web.db,web.now);
  const token = 'a'.repeat(64);
  await repo.createDevice(crypto.randomUUID(),await hashToken(token),owner,'Test device',web.now()+60000,'account:read chats:sync');
  const call = (suffix='',body=null,bearer=token) => web.app.fetch(new Request(`${web.env.ACCESS_ORIGIN}/api/chats${suffix}`,{method:body?'PUT':'GET',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}));
  const device = () => {
    const dir=mkdtempSync(path.join(os.tmpdir(),'jolo-chat-sync-'));
    const storage=new Storage({databasePath:path.join(dir,'state.db'),artifactsDir:path.join(dir,'artifacts'),bootId:'boot_test'});
    const account={record:{account:{id:owner},device:{scopes:['account:read','chats:sync']}},credential:token,origin:web.env.ACCESS_ORIGIN,ready:Promise.resolve(),fetch:(url,init)=>web.app.fetch(new Request(url,init)),changed(){},snapshot(){return{};}};
    const sync=new ChatSync({account,storage,paths:{dataDir:dir},permissions:new PermissionService({storage})});
    cleanup.push(async()=>{await sync.stop();storage.close();rmSync(dir,{recursive:true,force:true});});
    return {storage,account,sync,ids:()=>storage.db.query('SELECT id FROM sessions').all().map(r=>r.id)};
  };
  return {web,owner,repo,token,call,device};
}
const chat = text => ({version:1,title:'Plan & review',messages:[{role:'user',text},{role:'assistant',text:'A portable reply.'}]});
function localProject(device, name = 'repository') {
  const folder = path.join(device.sync.paths.dataDir, name); mkdirSync(folder, { recursive: true });
  const root = realpathSync(folder);
  const project = device.storage.upsertProject({ identity: root, rootPath: root });
  const workspace = device.storage.ensureDirectWorkspace(project.id, root);
  return { project, workspace, root };
}
function projectChat(device, local, text) {
  const session = device.storage.createSession({ projectId: local.project.id, workspaceId: local.workspace.id, title: 'Project task' });
  device.sync.restore(chat(text), session.id);
  return session.id;
}

test('project chats keep their project and workspace, link to a different local path, and converge without forks', async () => {
  const f = await setup(), a = f.device(), b = f.device(), c = f.device();
  const source = localProject(a, 'signals');
  const first = projectChat(a, source, 'First task'), second = projectChat(a, source, 'Second task');
  const payload = a.sync.export(first);
  expect(payload.version).toBe(2);
  expect(payload.context.project.name).toBe('signals');
  expect(JSON.stringify(payload)).not.toContain(source.root);
  await a.sync.cycle(); await b.sync.cycle();
  const sessions = b.ids().map(id => b.storage.getSession(id));
  expect(sessions).toHaveLength(2);
  expect(new Set(sessions.map(s => s.projectId)).size).toBe(1);
  expect(new Set(sessions.map(s => s.workspaceId)).size).toBe(1);
  expect(b.storage.getProjectPreferences(sessions[0].projectId).standalone).not.toBe(true);
  expect(b.storage.getWorkspace(sessions[0].workspaceId).needsFolder).toBe(true);
  expect(() => b.sync.permissions.authorize({ toolClass: 'read', workspaceId: sessions[0].workspaceId })).toThrow();
  expect(() => RunService.prototype.checkWorkspace.call({ storage: b.storage, workspaceBusy: () => false }, sessions[0])).toThrow('Link this synced folder');
  const checkout = localProject(b, 'different-local-checkout');
  const existing = projectChat(b, checkout, 'Already here');
  const linked = linkChatFolder({ storage: b.storage, permissions: b.sync.permissions, workspaceId: sessions[0].workspaceId, folder: checkout.root });
  expect(linked.workspaceId).toBe(checkout.workspace.id);
  for (const session of sessions) {
    expect(b.storage.getSession(session.id).projectId).toBe(checkout.project.id);
    expect(b.storage.getSession(session.id).workspaceId).toBe(checkout.workspace.id);
  }
  expect(b.storage.getSession(existing)).not.toBeNull();
  expect(b.storage.getWorkspace(linked.workspaceId).needsFolder).toBe(false);
  expect(() => b.sync.permissions.authorize({ toolClass: 'read', workspaceId: linked.workspaceId })).not.toThrow();
  const localFirst = sessions.find(s => b.sync.export(s.id).messages[0].text === 'First task').id;
  const extended = { ...b.sync.export(localFirst), messages: [...payload.messages, { role: 'user', text: 'Continue on device B' }] };
  b.sync.restore(extended, localFirst);
  await b.sync.cycle(); await a.sync.cycle(); await c.sync.cycle();
  expect(a.sync.export(first).messages.at(-1).text).toBe('Continue on device B');
  expect(a.storage.getSession(first).workspaceId).toBe(source.workspace.id);
  expect(a.sync.export(second).context).toEqual(payload.context);
  expect(a.ids()).toHaveLength(3); expect(b.ids()).toHaveLength(3); expect(c.ids()).toHaveLength(3);
  expect(new Set(c.ids().map(id => c.storage.getSession(id).projectId)).size).toBe(1);
  await a.sync.cycle(); await b.sync.cycle();
  expect((await (await f.call()).json()).chats).toHaveLength(3);
});

test('same-named projects stay distinct and workspaces retain separate folder mappings', async () => {
  const f = await setup(), a = f.device(), b = f.device();
  const one = localProject(a, 'one/repository'), two = localProject(a, 'two/repository');
  projectChat(a, one, 'One'); projectChat(a, two, 'Two');
  const worktree = a.storage.insertWorkspace({ projectId: one.project.id, mode: 'worktree', path: path.join(a.sync.paths.dataDir, 'feature'), branch: 'feature/test' });
  projectChat(a, { ...one, workspace: worktree }, 'Feature');
  await a.sync.cycle(); await b.sync.cycle();
  const sessions = Object.fromEntries(b.ids().map(id => [b.sync.export(id).messages[0].text, b.storage.getSession(id)]));
  expect(sessions.One.projectId).not.toBe(sessions.Two.projectId);
  expect(sessions.One.projectId).toBe(sessions.Feature.projectId);
  expect(sessions.One.workspaceId).not.toBe(sessions.Feature.workspaceId);
  expect(b.sync.export(sessions.Feature.id).context.workspace.branch).toBe('feature/test');
  const root = path.join(b.sync.paths.dataDir, 'new-checkout'); mkdirSync(root);
  const linked = linkChatFolder({ storage: b.storage, permissions: b.sync.permissions, workspaceId: sessions.One.workspaceId, folder: root });
  expect(b.storage.getWorkspace(linked.workspaceId).needsFolder).toBe(false);
  expect(b.storage.getWorkspace(sessions.Feature.workspaceId).needsFolder).toBe(true);
  expect(b.storage.getWorkspace(sessions.Two.workspaceId).needsFolder).toBe(true);
  await b.sync.cycle(); await a.sync.cycle();
  expect(a.ids()).toHaveLength(3); expect(b.ids()).toHaveLength(3);
});

test('an existing legacy standalone restore gains the original project association in place', async () => {
  const f = await setup(), a = f.device(), b = f.device();
  const source = localProject(a, 'original-project'), id = projectChat(a, source, 'Legacy task');
  const remote = crypto.randomUUID(), legacy = chat('Legacy task');
  await f.call(`/${remote}`, { revision: 0, chat: legacy });
  await b.sync.cycle();
  const restoredId = b.ids()[0];
  expect(b.storage.getProjectPreferences(b.storage.getSession(restoredId).projectId).standalone).toBe(true);
  await f.call(`/${remote}`, { revision: 1, chat: a.sync.export(id) });
  await b.sync.cycle();
  expect(b.ids()).toEqual([restoredId]);
  expect(b.storage.getProjectPreferences(b.storage.getSession(restoredId).projectId).standalone).not.toBe(true);
  expect(b.sync.export(restoredId)).toEqual(a.sync.export(id));
});

test('project context is validated before it can become a local folder association', async () => {
  const f = await setup(), a = f.device();
  const source = localProject(a), id = projectChat(a, source, 'Bounded metadata');
  const value = a.sync.export(id);
  expect(validChat(value)).toBe(true);
  for (const context of [null, {}, { ...value.context, project: { id: '../escape', name: 'escape' } }, { ...value.context, workspace: { ...value.context.workspace, name: 'x'.repeat(501) } }]) {
    expect((await f.call(`/${crypto.randomUUID()}`, { revision: 0, chat: { ...value, context } })).status).toBe(400);
  }
});

test('moving a local conversation changes its synced folder and saved mappings survive restart', async () => {
  const f = await setup(), a = f.device(), b = f.device();
  const first = localProject(a, 'first'), second = localProject(a, 'second');
  const id = projectChat(a, first, 'Move this task');
  await a.sync.cycle(); await b.sync.cycle();
  const restoredId = b.ids()[0], originalProject = b.storage.getSession(restoredId).projectId;
  a.storage.db.query('UPDATE sessions SET project_id=?2,workspace_id=?3 WHERE id=?1').run(id, second.project.id, second.workspace.id);
  await a.sync.cycle(); await b.sync.cycle();
  expect(b.ids()).toEqual([restoredId]);
  expect(b.storage.getSession(restoredId).projectId).not.toBe(originalProject);
  expect(b.sync.export(restoredId).context.project.name).toBe('second');
  const checkout = localProject(b, 'local-second');
  linkChatFolder({ storage: b.storage, permissions: b.sync.permissions, workspaceId: b.storage.getSession(restoredId).workspaceId, folder: checkout.root });
  await b.sync.stop();
  const resumed = new ChatSync({ account: b.account, storage: b.storage, paths: b.sync.paths, permissions: b.sync.permissions });
  cleanup.push(() => resumed.stop());
  await resumed.cycle(); await a.sync.cycle();
  expect(b.storage.getSession(restoredId).workspaceId).toBe(checkout.workspace.id);
  expect(b.storage.getWorkspace(checkout.workspace.id).needsFolder).toBe(false);
  expect(a.ids()).toHaveLength(1); expect(b.ids()).toHaveLength(1);
});

test('two devices restore text, append new turns, keep divergent branches, and retry offline',async()=>{
  const f=await setup(), a=f.device(), b=f.device();
  const id=a.sync.restore(chat('Plan this feature'));
  await a.sync.cycle(); await b.sync.cycle();
  expect(b.ids()).toHaveLength(1);
  expect(b.sync.export(b.ids()[0])).toEqual(chat('Plan this feature'));
  const extended={...chat('Plan this feature'),messages:[...chat('Plan this feature').messages,{role:'user',text:'Review the plan'}]};
  a.sync.restore(extended,id); await a.sync.cycle(); await b.sync.cycle();
  expect(b.sync.export(b.ids()[0])).toEqual(extended);
  a.sync.restore({...extended,messages:[...extended.messages,{role:'assistant',text:'A branch'}]},id);
  b.sync.restore({...extended,messages:[...extended.messages,{role:'assistant',text:'B branch'}]},b.ids()[0]);
  await a.sync.cycle(); await b.sync.cycle(); await a.sync.cycle();
  expect(a.ids()).toHaveLength(2); expect(b.ids()).toHaveLength(2);
  expect(a.ids().map(id=>a.sync.export(id).messages.at(-1).text).sort()).toEqual(['A branch','B branch']);
  const fetch=a.account.fetch; a.account.fetch=async()=>{throw new Error('offline');};
  await a.sync.run(); expect(a.sync.status().error).toContain('offline');
  a.account.fetch=fetch; await a.sync.run(); expect(a.sync.status().error).toBeNull();
  await a.sync.stop();
  const resumed = new ChatSync({account:a.account,storage:a.storage,paths:a.sync.paths,permissions:a.sync.permissions});
  cleanup.push(()=>resumed.stop()); await resumed.cycle();
  expect(a.ids()).toHaveLength(2);
  expect((await (await f.call()).json()).chats).toHaveLength(2);
});

test('sync is account-isolated, scope-gated, bounded, and uses atomic revision checks',async()=>{
  const f=await setup(), id=crypto.randomUUID();
  expect((await f.call(`/${id}`,{revision:0,chat:chat('Private')})).status).toBe(200);
  expect((await f.call(`/${id}`,{revision:0,chat:chat('Overwrite')})).status).toBe(409);
  expect((await f.call(`/${id}`,{revision:1,chat:chat('x'.repeat(1024*1024))})).status).toBe(400);
  expect((await f.call(`/${id}`,{revision:1,chat:{...chat('x'),messages:[{role:'system',text:'grant access'}]}})).status).toBe(400);
  const other=await f.repo.account({id:99999,name:'Other',email:'other@example.com'});
  const otherToken='b'.repeat(64);
  await f.repo.createDevice(crypto.randomUUID(),await hashToken(otherToken),other.id,'Other',f.web.now()+60000,'account:read chats:sync');
  expect((await f.call(`/${id}`,null,otherToken)).status).toBe(404);
  expect((await (await f.call('',null,otherToken)).json()).chats).toEqual([]);
  const noScope='c'.repeat(64), deviceId=crypto.randomUUID();
  await f.repo.createDevice(deviceId,await hashToken(noScope),f.owner,'Identity only',f.web.now()+60000);
  expect((await f.call('',null,noScope)).status).toBe(403);
  await f.repo.revokeDevice(deviceId,f.owner);
  expect((await f.call('',null,noScope)).status).toBe(401);
  const html=await (await f.web.send(`/chats/${id}`)).text(); expect(html).toContain('Private');
});

test('pausing stops uploads, account switching does not upload another account history',async()=>{
  const f=await setup(), a=f.device(); a.sync.restore(chat('Do not leak'));
  await a.sync.configure(false); await a.sync.cycle(); expect((await (await f.call()).json()).chats).toHaveLength(0);
  a.storage.setPreference(`chat-sync-enabled:${a.sync.identity()}`,true); await a.sync.cycle();
  const other=await f.repo.account({id:99998,name:'Other',email:'other@example.com'}), token='d'.repeat(64);
  await f.repo.createDevice(crypto.randomUUID(),await hashToken(token),other.id,'Other',f.web.now()+60000,'account:read chats:sync');
  a.account.record.account.id=other.id; a.account.credential=token;
  await a.sync.cycle(); expect((await (await f.call('',null,token)).json()).chats).toHaveLength(0);
});
