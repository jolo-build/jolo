import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fixture } from '../../apps/access/test/fixture.js';
import { createRepository } from '../../apps/access/src/storage.js';
import { hashToken } from '../../apps/access/src/security.js';
import { Storage } from '../../apps/engine/src/storage/index.js';
import { ChatSync } from '../../apps/engine/src/account/chat-sync.js';
import { PermissionService } from '../../apps/engine/src/permissions/service.js';

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
