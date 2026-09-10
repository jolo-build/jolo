import assert from 'node:assert/strict';
import { shell } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runTasksSmoke({window,bridge,evaluate,waitFor,results,report}) {
  const open=shell.openExternal; let approval;
  shell.openExternal=async url=>{approval=url;};
  try {
    await evaluate("document.querySelector('.settings-link').click()");
    await waitFor("Boolean(document.querySelector('.settings-nav [data-section=account]'))",'account navigation');
    await evaluate("document.querySelector('.settings-nav [data-section=account]').click()");
    await waitFor("document.querySelector('.account-settings')?.textContent.includes('Sign in to Jolo')",'signed out');
    const click=label=>evaluate(`[...document.querySelectorAll('.account-settings button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
    const approve=async()=>{
      await waitFor("Boolean(document.querySelector('.account-device-code'))",'device approval code');
      const pending=await bridge.rawCall('account.status',{});
      assert.equal(new URL(approval).origin,process.env.JOLO_ACCOUNT_ORIGIN);
      const response=await fetch(process.env.JOLO_ACCOUNT_ORIGIN+'/__fixture/approve',{method:'POST',body:pending.pending.userCode});
      assert.equal(response.status,200);
      try { await waitFor("document.querySelector('.account-settings')?.textContent.includes('Signed in')",'sign in approved',15000); } catch(error) { throw new Error(error.message + ' account=' + JSON.stringify(await bridge.rawCall('account.status',{})) + ' UI=' + await evaluate("document.querySelector('.account-settings')?.textContent")); }
    };
    await click('Sign in to Jolo'); await approve();
    assert.equal((await bridge.rawCall('account.status',{})).device.scopes.includes('tasks:read'),false);
    await click('Connect tasks'); await approve();
    assert.equal((await bridge.rawCall('account.status',{})).device.scopes.includes('tasks:read'),true);
    await evaluate("document.querySelector('[aria-label=\"Back to workspace\"]').click()");
    await waitFor("Boolean(document.querySelector('.composer textarea'))",'composer');
    await evaluate(`(() => {const input=document.querySelector('.composer textarea');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'@codex #JOLO-');input.setSelectionRange(13,13);input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor("document.querySelector('[aria-label=\"Reference a web task\"]')?.textContent.includes('Repair task form')",'task suggestions');
    await evaluate("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
    await waitFor("document.querySelector('.composer textarea')?.value === '@codex #JOLO-1 '",'task selected without submitting');
    await evaluate("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
    await waitFor("window.__joloSmoke.state().runState === 'completed'",'task run completed');
    await waitFor("document.querySelector('.message-task-references')?.textContent.includes('Repair task form')",'attached task chip');
    assert.match(await evaluate('window.__joloSmoke.state().assistantText'),/TASK_DESKTOP_CONTEXT/);
    assert.match(await evaluate("document.querySelector('.message.user .message-text').textContent"),/^@codex #JOLO-1/);
    writeFileSync(path.join(results,'tasks-desktop.png'),(await window.webContents.capturePage()).toPNG());
    report.checks.push('Desktop sign-in, explicit task reapproval, keyboard task selection, agent context, and sent task links pass through the real engine and fixture Access service');
  } finally {shell.openExternal=open;}
}
