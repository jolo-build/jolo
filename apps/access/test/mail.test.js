import { expect, test } from 'bun:test';
import { fixture } from './fixture.js';
import { taskRepository } from '../src/tasks/repository.js';
import { deliverMail, invitationEmail, mailConfigured } from '../src/mail.js';

async function setup(fetchImpl = async () => Response.json({id:'message-1'})) {
  const calls=[];
  const mailFetch=async (...args)=>{calls.push(args);return fetchImpl(...args);};
  const f=fixture({RESEND_API_KEY:'re_fixture',MAIL_FROM:'Jolo <noreply@notifications.jolo.build>'},{mailFetch});
  await f.login();
  const owner=f.sqlite.query('SELECT * FROM accounts').get();
  const csrf=f.sqlite.query('SELECT csrf FROM sessions').get().csrf;
  const repo=taskRepository(f.db,f.now),team=await repo.createTeam(owner.id,'Core');
  const payload=invitationEmail(f.env,{team,inviter:owner,recipient:'new@example.com',role:'member'});
  const queue=()=>repo.invite(owner.id,team.id,'new@example.com','member',payload);
  const deliver=()=>deliverMail(f.env,{now:f.now,fetchImpl:mailFetch});
  const row=()=>f.sqlite.query('SELECT * FROM mail_outbox').get();
  return {f,repo,team,owner,payload,queue,deliver,row,calls,csrf};
}

test('invitation form sends via Resend and duplicate submissions do not send again',async()=>{
  const {f,team,csrf,calls,row}=await setup();
  const post=()=>f.send(`/teams/${team.id}/invite`,{method:'POST',headers:{origin:f.env.ACCESS_ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,email:'new@example.com',role:'member'})});
  expect((await post()).status).toBe(303);
  expect(row().state).toBe('sent');expect(calls).toHaveLength(1);
  const [url,init]=calls[0];expect(url).toBe('https://api.resend.com/emails');
  expect(init.headers.Authorization).toBe('Bearer re_fixture');
  expect(JSON.parse(init.body).text).toContain('https://access.jolo.build/teams');
  expect(JSON.parse(init.body).to).toEqual(['new@example.com']);
  expect((await post()).status).toBe(409);expect(calls).toHaveLength(1);
  expect(await (await f.send(`/teams/${team.id}`)).text()).toContain('Email sent');
});

test('retry preserves payload and idempotency key; concurrent dispatch claims only once',async()=>{
  let attempt=0;
  const {f,queue,deliver,row,calls}=await setup(async()=>++attempt===1?new Response('',{status:429}):Response.json({id:'retry-success'}));
  await queue(); await Promise.all([deliver(),deliver()]);
  expect(calls).toHaveLength(1);expect(row().state).toBe('pending');
  await deliver();expect(calls).toHaveLength(1);
  f.advance(30_000);await Promise.all([deliver(),deliver()]);
  expect(row().state).toBe('sent');expect(row().attempts).toBe(2);
  expect(calls[0][1].body).toBe(calls[1][1].body);
  expect(calls[0][1].headers['Idempotency-Key']).toBe(calls[1][1].headers['Idempotency-Key']);
});

test('revoked invitations and messages outside the idempotency window are never sent',async()=>{
  const s=await setup();const invitation=await s.queue();
  await s.repo.revokeInvitation(s.owner.id,s.team.id,invitation.id);await s.deliver();
  expect(s.row().state).toBe('cancelled');expect(s.calls).toHaveLength(0);
  const expired=await setup();await expired.queue();expired.f.advance(23*3600_000);await expired.deliver();
  expect(expired.row().state).toBe('failed');expect(expired.calls).toHaveLength(0);
});

test('permanent provider failures store only bounded error codes',async()=>{
  const {queue,deliver,row,calls}=await setup(async()=>new Response('secret provider details',{status:403}));
  await queue();await deliver();await deliver();
  expect(calls).toHaveLength(1);expect(row().state).toBe('failed');expect(row().last_error).toBe('http_403');
  expect(JSON.stringify(row())).not.toContain('secret provider details');
});

test('outbox insert failure rolls back the invitation and audit; unauthorized invites queue nothing',async()=>{
  const {f,queue,repo,team,payload}=await setup();
  expect(await repo.invite('outsider',team.id,'new@example.com','member',payload)).toBeNull();
  expect(f.sqlite.query('SELECT count(*) n FROM mail_outbox').get().n).toBe(0);
  f.sqlite.exec("CREATE TRIGGER fail_mail BEFORE INSERT ON mail_outbox BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  await expect(queue()).rejects.toThrow();
  expect(f.sqlite.query('SELECT count(*) n FROM team_invitations').get().n).toBe(0);
  expect(f.sqlite.query("SELECT count(*) n FROM task_audit WHERE action='invitation.created'").get().n).toBe(0);
});

test('missing mail configuration does not call an email provider',async()=>{
  expect(mailConfigured({RESEND_API_KEY:'test',MAIL_FROM:'notifications.jolo.build'})).toBe(false);
  expect(mailConfigured({RESEND_API_KEY:'test',MAIL_FROM:'a@b.com\nBCC: bad@example.com'})).toBe(false);
  const f=fixture();await deliverMail(f.env,{fetchImpl:()=>{throw new Error('must not send');}});
  expect(invitationEmail(f.env,{})).toBeNull();
});
