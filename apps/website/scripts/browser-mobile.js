import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

export async function checkMobile(window) {
  const contents = window.webContents;
  const evaluate = async expression => {
    try { return await contents.executeJavaScript(expression); }
    catch (error) { throw new Error(`Mobile browser expression failed: ${expression}`, { cause: error }); }
  };
  const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const fit = async label => {
    await settle();
    const metrics = await evaluate(`(() => ({width:innerWidth,page:document.documentElement.scrollWidth,preview:document.querySelector('.workspace-example').getBoundingClientRect().width,available:document.querySelector('#panel-desktop').clientWidth}))()`);
    assert(metrics.page <= metrics.width && metrics.preview <= metrics.available + 1, `${label}: ${JSON.stringify(metrics)}`);
  };
  for (const width of [320, 375, 430, 768]) {
    window.setContentSize(width, 844);
    await evaluate('window.scrollTo({top:0,behavior:"instant"})');
    await fit('Mobile home');
    await evaluate('document.querySelector(".mobile-navigation summary").click()');
    await settle();
    const menu = await evaluate(`(() => {const links=[...document.querySelectorAll('.mobile-navigation nav a')];return links.map(a=>{const r=a.getBoundingClientRect();return {height:r.height,left:r.left,right:r.right,label:a.textContent};});})()`);
    assert.equal(menu.length, 5);
    assert(menu.every(link => link.height >= 44 && link.left >= 0 && link.right <= width), 'Every mobile navigation link must be reachable');
    writeFileSync(`/tmp/jolo-website-menu-${width}.png`, (await contents.capturePage()).toPNG());
    await evaluate(`document.querySelector('.mobile-navigation a[href="#workspace"]').click()`);
    assert.equal(await evaluate('document.querySelector(".mobile-navigation").open'), false);
    await evaluate('document.querySelector("#workspace").scrollIntoView({behavior:"instant"})');
    await fit('Mobile product preview');
    if (width <= 800) {
      await evaluate('document.querySelector(".mobile-preview-tasks").click()');
      assert(await evaluate('document.querySelector(".app-sidebar").getBoundingClientRect().width > 0'));
      await evaluate('document.querySelectorAll(".example-task")[1].click()');
      assert.equal(await evaluate('document.querySelector(".app-bar-title").textContent'), 'Add comments to web tasks');
      assert.equal(await evaluate('document.querySelector(".app-sidebar").getBoundingClientRect().width'), 0);
      await evaluate('document.querySelector(".app-bar-end [popovertarget]").click()');
      await settle();
      await evaluate('document.querySelector(".preview-panel-menu button").click()');
      await fit('Mobile changes panel');
      assert(await evaluate('document.querySelector(".app-context").getBoundingClientRect().width <= document.querySelector("#panel-desktop").clientWidth'));
      await evaluate('document.querySelector(".app-context header button").click()');
      assert(await evaluate('document.querySelector(".app-conversation").getBoundingClientRect().width > 0'));
    }
    writeFileSync(`/tmp/jolo-website-preview-${width}.png`, (await contents.capturePage()).toPNG());
    await evaluate('document.querySelector("#tab-terminal").click()');
    await fit('Mobile terminal');
    await evaluate('document.querySelector("#tab-desktop").click()');
    await evaluate('document.querySelector("#orchestrator").scrollIntoView({behavior:"instant"})');
    await fit('Mobile plans');
    writeFileSync(`/tmp/jolo-website-plans-${width}.png`, (await contents.capturePage()).toPNG());
    await evaluate('document.querySelector("#get-jolo").scrollIntoView({behavior:"instant"})');
    await fit('Mobile downloads');
    const downloads = await evaluate(`[...document.querySelectorAll('.desktop-download,.install-command button')].map(a=>({height:a.getBoundingClientRect().height,width:a.getBoundingClientRect().width}))`);
    assert(downloads.every(r => r.height >= 44 && r.width >= 44));
    writeFileSync(`/tmp/jolo-website-downloads-${width}.png`, (await contents.capturePage()).toPNG());
  }
  console.log('Website mobile checks passed: 320–768px, navigation, tasks, panels, terminal, plans and downloads.');
}
