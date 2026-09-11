import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import path from 'node:path';
import { rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { fixture } from '../../apps/access/test/fixture.js';
import { startEngine, tempHome, CLI_ENTRY, ROOT, openSession, waitFor, TERMINAL } from './helpers.js';

test('CLI task approval shares identity with desktop; native and hosted agents receive immutable task revisions', async () => {
  let web;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => web.app.fetch(request) });
  web = fixture({ ACCESS_ORIGIN: server.url.origin, ENVIRONMENT: 'development' });
  const home = tempHome(), env = { JOLO_CREDENTIALS: 'session', JOLO_ACCOUNT_ORIGIN: server.url.origin };
  let engine, desktop, child;
  const agents=path.join(home,'data/t/agents'); mkdirSync(agents,{recursive:true});
  for(const [id,transport] of [['codex','codex-app-server'],['claude','claude-stream'],['acp','acp']]) {
    const binary=path.join(home,`fake-${id}`);
    writeFileSync(binary,`#!/bin/sh\nexport FAKE_ACP_STATE='${home}/acp-state'\nexec '${process.execPath}' '${ROOT}/tests/fixtures/fake-${id}.js' "$@"\n`); chmodSync(binary,0o755);
    writeFileSync(path.join(agents,`${id}.json`),JSON.stringify({id,displayName:id,binary,transport,...(id==='acp'?{args:['--acp']}:{})}));
  }
  try {
    engine = await startEngine({ home, env, idleMs: 60_000 });
    desktop = await engine.connect({ clientKind: 'desktop' });
    expect((await desktop.call('account.status', {})).state).toBe('signed_out');
    /** @type {(value?: any) => void} */
    let resolvePending;
    const pending = new Promise(resolve => { resolvePending = resolve; });
    child = Bun.spawn([process.execPath, CLI_ENTRY, 'login', '--tasks', '--no-open', '--json', '--home', home, '--profile', 't'], { cwd: ROOT, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
    const stderr = new Response(child.stderr).text();
    let output = '';
    const readOutput = (async () => {
      const decoder = new TextDecoder();
      for await (const bytes of child.stdout) {
        output += decoder.decode(bytes, { stream: true });
        const first = output.split('\n').find(line => line.includes('"type":"account.pending"'));
        if (first && output.includes('\n')) resolvePending(JSON.parse(first));
      }
    })();
    const pendingStatus = await Promise.race([pending, Bun.sleep(10_000).then(() => { throw new Error('CLI did not start account sign-in'); })]);
    expect(pendingStatus.pending.verificationUri).toBe(`${server.url.origin}/device`);
    expect((await desktop.call('account.status', {})).pending.userCode).toBe(pendingStatus.pending.userCode);
    await web.login();
    const csrf = web.sqlite.query('SELECT csrf FROM sessions').get().csrf;
    const approved = await web.send('/device/approve', { method: 'POST', headers: { origin: server.url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, user_code: pendingStatus.pending.userCode, decision: 'approved' }) });
    expect(approved.status).toBe(200);
    web.advance(5000);
    expect(await child.exited).toBe(0);
    await readOutput;
    const signedIn = output.trim().split('\n').map(line => JSON.parse(line)).find(value => value.type === 'account.signed_in');
    expect(signedIn.account.email).toBe('dev@example.com');
    expect(signedIn.source).toBe('session');
    expect((await desktop.call('account.status', {})).account.id).toBe(signedIn.account.id);
    expect(output).not.toContain('access_token');
    expect(await stderr).not.toContain('fixture-github-token');
    expect(signedIn.device.scopes).toContain('tasks:read');
    const description='TASK_CONTEXT_SENTINEL: preserve drafts and verify browser origin.';
    const post=(pathname,body)=>web.send(pathname,{method:'POST',headers:{origin:server.url.origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...body})});
    const fields={title:'Fix task forms',description,project:'jolo',state:'todo',priority:'high',team:'',assignee:'',request_id:crypto.randomUUID()};
    const created=await post('/tasks',fields); expect(created.status).toBe(303);
    const taskPath=created.headers.get('location'), key=taskPath.split('/').at(-1);
    const listed=await desktop.call('task.list',{q:key}); expect(listed.tasks[0].key).toBe(key); expect(listed.tasks[0]).not.toHaveProperty('description');
    expect((await desktop.call('task.get',{key})).task.description).toBe(description);
    const {session}=await openSession(desktop,home);
    let firstRun;
    for(const agent of ['codex','claude','acp','jolo']) {
      const prompt=`@${agent} #${key} fix this problem`;
      const {run}=await desktop.call('run.start',{sessionId:session.id,requestId:`task-${agent}`,prompt});
      firstRun??=run;
      expect(run.taskReferences[0]).toMatchObject({key,revision:1}); expect(run.taskReferences[0]).not.toHaveProperty('description');
      /** @type {import('./helpers.js').RunSnapshot} */ let snapshot;
      await waitFor(async()=>{snapshot=await desktop.call('run.snapshot',{runId:run.id});return TERMINAL.includes(snapshot.run.state);},{timeoutMs:10000});
      expect(snapshot.run.state,snapshot.run.failure).toBe('completed');
      const user=snapshot.messages.find(m=>m.role==='user');
      expect((await desktop.call('artifact.read',{artifactId:user.artifactId,offset:0})).text).toBe(prompt);
      if(agent!=='jolo') {
        const assistant=snapshot.messages.filter(m=>m.role==='assistant'&&m.kind==='text').at(-1);
        expect((await desktop.call('artifact.read',{artifactId:assistant.artifactId,offset:0})).text).toContain(description);
      }
    }
    expect((await post(taskPath,{...fields,description:'New instructions',revision:'1'})).status).toBe(303);
    const retried=await desktop.call('run.start',{sessionId:session.id,requestId:'task-codex',prompt:`@codex #${key} fix this problem`});
    expect(retried.deduplicated).toBe(true); expect(retried.run.id).toBe(firstRun.id); expect(retried.run.taskReferences[0].revision).toBe(1);
    const cliRun=Bun.spawn([process.execPath,CLI_ENTRY,'run',`#${key} fix this problem`,'--json','--home',home,'--profile','t','--path',home],{cwd:ROOT,env:{...process.env,...env},stdout:'pipe',stderr:'pipe'});
    const cliOutput=new Response(cliRun.stdout).text(),cliError=new Response(cliRun.stderr).text();
    expect(await cliRun.exited,await cliError).toBe(0);
    expect(await cliOutput).toContain(key);
    const blocker=(await desktop.call('run.start',{sessionId:session.id,requestId:'blocker',prompt:'@codex sleep'})).run;
    await waitFor(async()=>['model','tools'].includes((await desktop.call('run.snapshot',{runId:blocker.id})).run.state));
    const queued=(await desktop.call('run.start',{sessionId:session.id,requestId:'queued-task',prompt:`@claude #${key} fix it`})).run;
    expect(queued.state).toBe('queued'); expect(queued.taskReferences[0].revision).toBe(2);
    expect((await post(taskPath,{...fields,description:'Changed after queueing',revision:'2'})).status).toBe(303);
    await desktop.call('run.cancel',{runId:blocker.id});
    /** @type {import('./helpers.js').RunSnapshot} */ let queuedSnapshot;
    await waitFor(async()=>{queuedSnapshot=await desktop.call('run.snapshot',{runId:queued.id});return TERMINAL.includes(queuedSnapshot.run.state);},{timeoutMs:10000});
    expect(queuedSnapshot.run.state).toBe('completed');
    const queuedReply=queuedSnapshot.messages.filter(m=>m.role==='assistant'&&m.kind==='text').at(-1);
    const queuedText=(await desktop.call('artifact.read',{artifactId:queuedReply.artifactId,offset:0})).text;
    expect(queuedText).toContain('New instructions'); expect(queuedText).not.toContain('Changed after queueing');
    expect((await post(taskPath+'/archive',{revision:'3'})).status).toBe(303);
    await expect(desktop.call('run.start',{sessionId:session.id,requestId:'archived',prompt:`#${key}`})).rejects.toMatchObject({code:'not_found'});
    const teamResponse=await post('/teams',{name:'Independent tickets'});
    const team=teamResponse.headers.get('location').split('/').at(-1);
    const teamCreated=await post('/tasks',{...fields,team,title:'Team ticket',description:'TEAM_SCOPED_CONTEXT',request_id:crypto.randomUUID()});
    const teamPath=teamCreated.headers.get('location');
    expect(teamPath).toEndWith('/JOLO-1');
    expect((await desktop.call('task.get',{key:'JOLO-1',team})).task.description).toBe('TEAM_SCOPED_CONTEXT');
    await expect(desktop.call('task.get',{key:'JOLO-1'})).rejects.toMatchObject({code:'conflict'});
    const linked=(await desktop.call('run.start',{sessionId:session.id,requestId:'scoped-team',prompt:`@codex fix ${server.url.origin}${teamPath}`})).run;
    expect(linked.taskReferences[0].team.id).toBe(team);
    expect(linked.taskReferences[0].url).toBe(server.url.origin+teamPath);
    /** @type {import('./helpers.js').RunSnapshot} */ let linkedSnapshot;
    await waitFor(async()=>{linkedSnapshot=await desktop.call('run.snapshot',{runId:linked.id});return TERMINAL.includes(linkedSnapshot.run.state);},{timeoutMs:10000});
    expect(linkedSnapshot.run.state).toBe('completed');
    const linkedReply=linkedSnapshot.messages.filter(m=>m.role==='assistant'&&m.kind==='text').at(-1);
    expect((await desktop.call('artifact.read',{artifactId:linkedReply.artifactId,offset:0})).text).toContain('TEAM_SCOPED_CONTEXT');
    const logout = Bun.spawn([process.execPath, CLI_ENTRY, 'logout', '--json', '--home', home, '--profile', 't'], { cwd: ROOT, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
    expect(await logout.exited).toBe(0);
    expect(JSON.parse(await new Response(logout.stdout).text()).state).toBe('signed_out');
    expect((await desktop.call('account.status', {})).state).toBe('signed_out');
    expect(web.sqlite.query('SELECT count(*) AS n FROM devices').get().n).toBe(0);
    await expect(desktop.call('task.list',{})).rejects.toMatchObject({code:'permission_denied'});
    await desktop.close(); await engine.stop();
    const db=new Database(engine.paths.databasePath,{readonly:true});
    try {
      const snapshot=JSON.parse(db.query('SELECT payload FROM run_task_references WHERE run_id=?').get(firstRun.id).payload);
      expect(snapshot.description).toBe(description); expect(snapshot.revision).toBe(1);
      const native=db.query("SELECT payload FROM conversation_items WHERE kind='user_message'").all().map(row=>JSON.parse(row.payload).text);
      expect(native.some(text=>text.includes(description))).toBe(true);
      expect(native.some(text=>text.includes('New instructions'))).toBe(true);
    } finally {db.close();}
    engine=await startEngine({home,env,idleMs:60000}); desktop=await engine.connect({clientKind:'desktop'});
    expect((await desktop.call('run.snapshot',{runId:firstRun.id})).run.taskReferences[0].revision).toBe(1);
    const recovered=await desktop.call('run.start',{sessionId:session.id,requestId:'task-codex',prompt:`@codex #${key} fix this problem`});
    expect(recovered.deduplicated).toBe(true); expect(recovered.run.id).toBe(firstRun.id);
  } finally {
    if (child?.exitCode === null) child.kill();
    await desktop?.close(); await engine?.stop(); server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 40_000);
