import assert from 'node:assert/strict';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { checkLoading } from './browser-loading.js';
import { checkComments } from './browser-comments.js';

app.setPath('userData', process.env.JOLO_ACCESS_TEST_HOME);
let phase = 'starting Electron';
const timeout = setTimeout(() => { console.error(`Browser form check timed out: ${phase}`); app.exit(1); }, 60_000);
let window;
async function checkForms() {
 try {
  const origin = process.env.JOLO_ACCESS_TEST_ORIGIN;
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'jolo-access-browser-smoke' } });
  const contents = window.webContents;
  contents.setBackgroundThrottling(false);
  phase = 'checking initial asset loading';
  await checkLoading(window, origin);
  const text = () => contents.executeJavaScript('document.body.textContent');
  const settle = () => contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const fit = async (label, controls = []) => {
    await settle();
    const metrics = await contents.executeJavaScript(`(() => {
      const root=document.documentElement, content=document.querySelector('.task-content');
      const selectors=${JSON.stringify(['#color-theme', ...controls])};
      return { width:innerWidth,height:innerHeight,pageWidth:root.scrollWidth,pageHeight:root.scrollHeight,
        contentOverflow:content ? Math.max(0,content.scrollHeight-content.clientHeight) : 0, contentWidthOverflow:content ? Math.max(0,content.scrollWidth-content.clientWidth) : 0,
        controls:selectors.map(selector=>{const element=document.querySelector(selector),r=element?.getBoundingClientRect();return {selector,visible:Boolean(r&&r.width&&r.height&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth)};}) };
    })()`);
    assert(metrics.pageWidth<=metrics.width&&metrics.pageHeight<=metrics.height, `${label}: page exceeds viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.contentWidthOverflow<=1,`${label}: content exceeds available width: ${JSON.stringify(metrics)}`);
    if(metrics.width>700) assert(metrics.contentOverflow<=1,`${label}: workspace should fit without page-content scrolling: ${JSON.stringify(metrics)}`);
    assert(metrics.controls.every(control=>control.visible),`${label}: controls left the viewport: ${JSON.stringify(metrics)}`);
  };
  const submit = async selector => {
    phase = `submitting ${selector}`;
    const loaded = once(contents, 'did-finish-load');
    await contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await loaded;
  };
  const checkAccessLayout = async (label, controls = []) => {
    phase = `checking ${label} layout`;
    for (const [width,height] of [[1280,720],[1024,768],[1280,560],[390,844]]) {
      window.setContentSize(width,height);
      await fit(label, controls);
      if ((width===1280&&height===720)||width===390) writeFileSync(`/tmp/jolo-access-${label}${width===390?'-mobile':''}.png`,(await contents.capturePage()).toPNG());
    }
    window.setContentSize(1280,720);
  };
  window.setContentSize(1280,720);
  const chooseTheme = value => contents.executeJavaScript(`(() => {
    const picker=document.getElementById('color-theme');picker.value=${JSON.stringify(value)};picker.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  const background = () => contents.executeJavaScript('getComputedStyle(document.documentElement).backgroundColor');
  nativeTheme.themeSource='dark';
  await window.loadURL(origin+'/');
  assert.equal(await background(),'rgb(25, 26, 28)','System follows dark OS preference');
  await chooseTheme('light');
  assert.equal(await background(),'rgb(252, 252, 251)','Light overrides dark OS preference');
  await window.loadURL(origin+'/device');
  assert.equal(await background(),'rgb(252, 252, 251)','Explicit theme survives navigation');
  await chooseTheme('dark');nativeTheme.themeSource='light';
  await settle();
  assert.equal(await background(),'rgb(25, 26, 28)','Dark overrides light OS preference');
  await chooseTheme('system');await settle();
  assert.equal(await background(),'rgb(252, 252, 251)','System restores the OS preference');
  nativeTheme.themeSource='dark';await settle();
  assert.equal(await background(),'rgb(25, 26, 28)','System follows live OS changes');
  await chooseTheme(process.env.JOLO_ACCESS_TEST_THEME ?? 'light');
  phase = 'loading approval page';
  await window.loadURL(origin + '/__fixture/session');
  phase = 'reading approval page';
  await fit('approval', ['button[value=approved]','button[value=denied]']);
  assert.match(await text(), /Only approve a sign-in you started/);
  await submit('button[value="approved"]');
  assert.match(await text(), /forbidden/, 'The old no-referrer policy must reproduce Origin: null rejection');
  await window.loadURL(origin + '/__fixture/approve');
  assert.match(await text(), /Task access: this Jolo profile can read tasks/);
  await checkAccessLayout('approval', ['button[value=approved]','button[value=denied]']);
  await submit('button[value="approved"]');
  assert.match(await text(), /Device approved\./, 'Native browser approval must succeed');
  await checkAccessLayout('approved', ['.access-panel-actions a[href="/devices"]']);
  await window.loadURL(origin + '/__fixture/decline');
  await submit('button[value="denied"]');
  assert.match(await text(), /Sign-in declined\./);
  await checkAccessLayout('declined', ['.access-panel-actions a[href="/devices"]']);
  await window.loadURL(origin + '/devices');
  assert.match(await text(), /Browser smoke device/);
  await checkAccessLayout('devices', ['form[action="/devices/revoke"] button','.task-heading .button']);
  await contents.executeJavaScript(`(() => {const list=document.querySelector('.device-list'),row=list.firstElementChild;for(let n=0;n<30;n++) list.append(row.cloneNode(true));})()`);
  await checkAccessLayout('devices-long', ['.task-nav','.task-heading .button']);
  assert(await contents.executeJavaScript('document.querySelector(".device-list").scrollHeight > document.querySelector(".device-list").clientHeight'));
  await window.loadURL(origin + '/devices');
  await submit('form[action="/devices/revoke"] button');
  assert.match(await text(), /No devices connected yet/);
  await checkAccessLayout('devices-empty', ['.task-heading .button']);
  await window.loadURL(origin + '/device');
  await checkAccessLayout('device-entry', ['[name=user_code]','form[action="/device"] button']);
  assert.equal(await contents.executeJavaScript('document.querySelector(".task-nav [aria-current=page]").textContent'),'Account');
  await window.loadURL(origin + '/device?user_code=invalid');
  await checkAccessLayout('device-invalid', ['[name=user_code]','form[action="/device"] button']);
  const fill = values => contents.executeJavaScript(`Object.entries(${JSON.stringify(values)}).forEach(([name,value]) => { document.querySelector('[name="'+name+'"]').value=value; })`);
  await window.loadURL(origin + '/teams');
  await fit('teams', ['form[action="/teams"] button']);
  await fill({name:'Jolo Core',prefix:'CYPHO'}); await submit('form[action="/teams"] button');
  assert.match(await text(), /TEAM · owner/);
  const team = new URL(contents.getURL()).pathname.split('/').at(-1);
  await fit('team detail', ['form[action$="/invite"] button']);
  assert.match(await text(), /Send invitation/);
  await fill({email:'invitee@example.com',role:'member'});await submit('form[action$="/invite"] button');
  assert.match(await text(), /Email sent/);
  await fit('team invitation delivery', ['form[action$="/invite"] button']);
  await window.loadURL(origin + '/labels?team='+team);
  await fit('labels', ['form[method=post][action="/labels"] button']);
  await fill({name:'Bug',color:'red'}); await submit('form[method="post"][action="/labels"] button');
  assert.equal(await contents.executeJavaScript('document.querySelectorAll(".label-grid article").length'), 1);
  await window.loadURL(origin + '/tasks/new?team='+team);
  await fit('new task', ['button[form=task-edit]','[name=title]','[name=description]','[name=state]']);
  await fill({title:'Keep my draft',description:'A draft before switching workspaces.'});
  for (const scope of ['', team]) {
    assert.equal(await contents.executeJavaScript('getComputedStyle(document.querySelector(".workspace-picker button")).display'), 'none');
    const switched = once(contents, 'did-finish-load');
    await contents.executeJavaScript(`(() => { const select=document.querySelector('.workspace-picker select'); select.value=${JSON.stringify(scope)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await switched;
    assert.equal(await contents.executeJavaScript('document.querySelector("#task-edit [name=team]").value'), scope);
    assert.equal(await contents.executeJavaScript('document.querySelector("[name=title]").value'), 'Keep my draft');
    assert.equal(await contents.executeJavaScript('document.querySelector("[name=description]").value'), 'A draft before switching workspaces.');
  }
  await fill({title:'Preserve task drafts after sign-in',description:'When sign-in expires, preserve the task description and selected labels.\n\nVerify the browser flow and add a regression check.\n\n**Ready to ship**',project:'Jolo',priority:'high'});
  await contents.executeJavaScript('document.querySelector("[data-mode=preview]").click()');
  assert.equal(await contents.executeJavaScript('document.querySelector("[data-markdown-preview] strong").textContent'), 'Ready to ship');
  await contents.executeJavaScript('document.querySelector("[data-mode=write]").click()');
  assert.equal(await contents.executeJavaScript('document.querySelector("[name=description]").hidden'), false);
  await contents.executeJavaScript('document.querySelector("[name=label]").checked=true');
  await submit('button[form="task-edit"]');
  assert.match(await text(), /CYPHO-1/);
  assert.match(await text(), /@codex fix #CYPHO-1/);
  assert.equal(await contents.executeJavaScript('document.querySelector(".task-description strong").textContent'), 'Ready to ship');
  const taskPath=new URL(contents.getURL()).pathname;
  assert.equal(await contents.executeJavaScript('document.querySelector("#task-edit")'),null,'Creating a task should open its detail view');
  await submit(`a[href="${taskPath}/edit"]`);
  await fill({title:'This unsaved title should be discarded'});
  await submit(`.task-actions a[href="${taskPath}"]`);
  assert.match(await text(), /Preserve task drafts after sign-in/);
  assert.doesNotMatch(await text(), /This unsaved title should be discarded/);
  await submit(`a[href="${taskPath}/edit"]`);
  await fill({state:'in_progress'}); await submit('button[form="task-edit"]');
  assert.match(await text(), /Revision 2/);
  assert.equal(await contents.executeJavaScript('document.querySelector("#task-edit")'),null,'Saving a task should return to its detail view');
  assert.match(await contents.executeJavaScript('document.querySelector(".task-summary").textContent'),/In progress/);
  phase = 'checking task comments and fixed scrolling';
  await checkComments(window, origin, taskPath);
  await checkAccessLayout('task-view', [`a[href="${taskPath}/edit"]`,'form[action$="/archive"] button']);
  await contents.executeJavaScript('document.querySelector(".task-description").textContent += "\\nLong description".repeat(150)');
  await checkAccessLayout('task-view-long', [`a[href="${taskPath}/edit"]`,'form[action$="/archive"] button']);
  await submit(`form[action="${taskPath}/archive"] button`);
  assert.match(await text(), /This task is archived/);
  await submit(`form[action="${taskPath}/restore"] button`);
  await window.loadURL(origin + '/tasks?team='+team);
  assert.match(await text(), /Preserve task drafts/); assert.match(await text(), /In progress/);
  await contents.executeJavaScript('document.querySelector(".task-more-filters summary").click()');
  await fit('expanded filters', ['[name=state]','.task-filter-options button']);
  await fill({state:'done'}); await submit('.task-filter-options button');
  assert.match(await text(), /No tasks match this view/);
  assert.match(await text(), /Filters \(1\)/);
  await window.loadURL(origin + '/tasks?team='+team);
  window.setContentSize(1440,900);
  await fit('task list', ['.task-nav','.task-heading .button']);
  writeFileSync('/tmp/jolo-tasks-browser.png',(await contents.capturePage()).toPNG());
  // Lists grow inside their panels while the viewport and actions stay put.
  await contents.executeJavaScript(`(() => {const list=document.querySelector('.task-list'),row=list.firstElementChild;for(let n=0;n<40;n++) list.append(row.cloneNode(true));})()`);
  await fit('long task list', ['.task-nav','.task-heading .button']);
  assert(await contents.executeJavaScript('document.querySelector(".task-list").scrollHeight > document.querySelector(".task-list").clientHeight'));
  for(const [width,height] of [[1280,720],[1024,768],[1280,560],[390,844]]) {
    window.setContentSize(width,height);
    for(const route of ['/tasks/new?team='+team,taskPath,taskPath+'/edit','/teams','/teams/'+team,'/labels?team='+team]) {
      await window.loadURL(origin+route);
      await fit(route, route===taskPath ? [`a[href="${taskPath}/edit"]`] : route.startsWith('/tasks') ? ['button[form=task-edit]','.task-actions a'] : ['.task-nav']);
      if(width===1280&&height===720) {const name=route.startsWith('/tasks/new')?'new-task':route===taskPath?'task-view':route===taskPath+'/edit'?'task-editor':route==='/teams'?'teams':route.startsWith('/teams/')?'team-detail':'labels';writeFileSync('/tmp/jolo-access-'+name+'.png',(await contents.capturePage()).toPNG());if(name==='new-task'){await chooseTheme('dark');await settle();writeFileSync('/tmp/jolo-access-new-task-dark.png',(await contents.capturePage()).toPNG());await chooseTheme('light');}}
    }
  }
  await window.loadURL(origin + '/tasks?team='+team);
  window.setContentSize(390,844);
  await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await contents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'),true,'Task page must fit a phone');
  writeFileSync('/tmp/jolo-tasks-mobile.png',(await contents.capturePage()).toPNG());
  await window.loadURL(origin + '/account');
  await checkAccessLayout('account', ['.task-nav']);
  await fit('account actions', ['form[action="/logout"] button','.access-panel-actions a[href="/devices"]']);
  assert.equal(await contents.executeJavaScript('document.querySelector(".task-nav [aria-current=page]").textContent'),'Account');
  await submit('form[action="/logout"] button');
  assert.match(await text(), /Continue with GitHub/);
  assert.match(await text(), /Continue with Google/);
  await checkAccessLayout('sign-in', ['a[href="/login"]', 'a[href="/login/google"]']);
  // A route, the label its screenshots are filed under, and the controls that must stay in view.
  for (const [route,label,controls] of /** @type {[string, string, string[]][]} */ ([
    ['/?error=email','sign-in-email',['a[href="/login"]']],
    ['/?error=signin','sign-in-error',['a[href="/login"]']],
    ['/__fixture/unavailable','sign-in-unavailable',['.task-nav']],
    ['/device','device-signed-out',['[name=user_code]','form[action="/device"] button']],
    ['/missing','not-found',['.access-panel a[href="/"]']],
    ['/__fixture/rate-limited','rate-limited',['.access-panel a[href="/"]']],
  ])) {
    await window.loadURL(origin+route);
    await checkAccessLayout(label, controls);
  }
  clearTimeout(timeout);
  window.destroy(); app.exit(0);
 } catch (error) {
  console.error(phase, window?.webContents.getURL(), error.message);
  console.error(await window?.webContents.executeJavaScript('document.body.innerText').catch(() => ''));
  clearTimeout(timeout);
  window?.destroy(); app.exit(1);
 }
}
// Electron emits ready after evaluating its ESM entrypoint; do not top-level
// await whenReady(), which would prevent that evaluation from finishing.
app.whenReady().then(checkForms);
