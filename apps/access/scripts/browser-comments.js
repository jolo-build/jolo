import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';

export async function checkComments(window, origin, taskPath) {
  const contents = window.webContents;
  const evaluate = expression => contents.executeJavaScript(expression);
  const submit = async selector => {
    const loaded = once(contents, 'did-finish-load');
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await loaded;
  };
  const write = text => evaluate(`document.getElementById('comment-body').value=${JSON.stringify(text)}`);
  await write('I reproduced the issue.\nKeeping the task header visible helps while reviewing a long discussion.');
  await submit('#comment-composer button');
  await window.loadURL(origin + taskPath);
  assert.match(await evaluate('document.querySelector(".comment-body").textContent'), /I reproduced the issue/);
  await evaluate('document.querySelector(".comment-edit summary").click(); document.querySelector(".comment-edit textarea").value="The fix is ready to review."');
  await submit('.comment-edit button');
  assert.equal(await evaluate('document.querySelector(".comment-body").textContent'), 'The fix is ready to review.');
  assert.equal(await evaluate('document.querySelector(".comment-edited").textContent'), 'edited');
  await evaluate('document.querySelector(".comment-delete summary").click()');
  await submit('.comment-delete button');
  assert.equal(await evaluate('document.querySelectorAll(".task-comment").length'), 0);
  await write('The updated behavior is ready to review.\nThe comment box stays available while you scroll through earlier updates.');
  await submit('#comment-composer button');
  await evaluate(`(() => {
    const list=document.querySelector('.task-comments'), first=document.querySelector('.task-comment');
    for(let i=0;i<35;i++) {const row=first.cloneNode(true);row.id='scroll-fixture-'+i;row.querySelector('.comment-body').textContent='Update '+(i+1)+': '+row.querySelector('.comment-body').textContent;list.append(row);}
  })()`);
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  for (const [width,height] of [[1280,720],[1024,768],[1280,560],[768,1024],[390,844],[320,740]]) {
    window.setContentSize(width,height);
    await settle();
    const metrics = () => evaluate(`(() => {
      const scroll=document.querySelector('.task-conversation');
      const bounds=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}};
      return {width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight,
        header:bounds('.task-heading'),composer:bounds('#comment-composer'),send:bounds('#comment-composer button'),
        details:bounds(innerWidth<=700?'.task-mobile-details':'.task-summary'),scrollTop:scroll.scrollTop,scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight};
    })()`);
    await evaluate('document.querySelector(".task-conversation").scrollTop=0');
    await settle();
    const before=await metrics();
    await evaluate('document.querySelector(".task-conversation").scrollTop=document.querySelector(".task-conversation").scrollHeight');
    await settle();
    const after=await metrics();
    assert(after.scrollTop>0 && after.scrollHeight>after.clientHeight, 'Discussion must scroll within its own panel');
    assert(after.pageWidth<=after.width && after.pageHeight<=after.height, 'The page must stay within the viewport');
    for(const key of ['header','composer','send','details']) {
      assert.deepEqual(after[key],before[key], `${width}x${height}: ${key} must stay in place while comments scroll`);
      assert(after[key].top>=0 && after[key].bottom<=after.height && after[key].left>=0 && after[key].right<=after.width, `${width}x${height}: ${key} must remain visible`);
    }
    if(width===390) {
      await evaluate('document.querySelector(".task-mobile-details").open=true'); await settle();
      const expanded=await metrics();
      assert(expanded.send.bottom<=expanded.height && expanded.clientHeight>60, 'Expanded mobile details must keep the composer and discussion usable');
      await evaluate('document.querySelector(".task-mobile-details").open=false');
    }
    if(width===1280&&height===720||width===390) {
      for(const theme of ['light','dark']) {
        await evaluate(`(() => {const picker=document.getElementById('color-theme');picker.value='${theme}';picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await settle();
        writeFileSync(`/tmp/jolo-task-comments-${theme}${width===390?'-mobile':''}.png`,(await contents.capturePage()).toPNG());
      }
    }
  }
  await evaluate("const picker=document.getElementById('color-theme');picker.value='light';picker.dispatchEvent(new Event('change',{bubbles:true}))");
  window.setContentSize(1280,720);
  await window.loadURL(origin + taskPath);
  assert.equal(await evaluate('document.querySelectorAll(".task-comment").length'), 1, 'Only the real submitted comment persists after reload');
  console.log('Task comments passed: create, reload, edit, delete, fixed header/composer/details, long scroll, mobile details, and both themes.');
}
