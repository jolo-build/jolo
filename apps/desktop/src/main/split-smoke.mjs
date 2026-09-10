// Isolated desktop integration checks. Invoked only by smoke.js --splits.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nativeTheme } from "electron";
import { runPromptFocusSmoke } from './prompt-focus-smoke.mjs';
import { runTaskDragSmoke } from './task-drag-smoke.mjs';

export async function runSplitSmoke({ window, bridge, project, results, evaluate, waitFor, report }) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const panes = () => evaluate("window.__joloSmoke.panes()");
  const selector = (id) => `[data-pane-id="${id}"]`;
  // A lone pane has no bar of its own, because the window header already names its project and task; its split
  // controls live in that header instead. Look in the pane first, then fall back to the header.
  const click = (id, label) => evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(`${selector(id)} [aria-label="${label}"]`)}) ?? document.querySelector(${JSON.stringify(`.header [aria-label="${label}"]`)});
    if (!button) throw new Error(${JSON.stringify(`no "${label}" control for pane ${"${id}"}`)});
    button.focus(); button.click();
  })()`);
  const focus = async (id) => { await evaluate(`window.__joloSmoke.focusPane(${JSON.stringify(id)})`); await waitFor(`window.__joloSmoke.layout().active === ${JSON.stringify(id)}`, "pane focused"); };
  const draft = (id) => evaluate(`document.querySelector(${JSON.stringify(`${selector(id)} textarea`)}).value`);
  const type = async (id, text) => {
    await evaluate(`document.querySelector(${JSON.stringify(`${selector(id)} textarea`)}).focus()`);
    await window.webContents.insertText(text);
    await waitFor(`document.querySelector(${JSON.stringify(`${selector(id)} textarea`)}).value === ${JSON.stringify(text)}`, "draft typed");
  };
  const first = (await panes())[0].id;
  await evaluate("window.__joloSmoke.send('alpha conversation')");
  await waitFor("window.__joloSmoke.state().runState === 'completed'", "first run");
  const firstSession = (await panes())[0].sessionId;
  await type(first, "keep this original draft");
  const scrollRange = await evaluate(`(() => {const el = document.querySelector(${JSON.stringify(`${selector(first)} .conversation`)}); return el.scrollHeight - el.clientHeight;})()`);
  assert(scrollRange > 160, "scroll fixture needs a transcript longer than the viewport");
  await evaluate(`document.querySelector(${JSON.stringify(`${selector(first)} .conversation`)}).scrollTop = 80`);
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await click(first, "Split right");
  await waitFor("window.__joloSmoke.panes().length === 2 && window.__joloSmoke.state().projectId", "split ready");
  const second = (await panes())[1].id;
  assert((await panes())[0].projectId === (await panes())[1].projectId && !(await panes())[1].sessionId, "split must start a separate draft in the same project");
  assert(await draft(first) === "keep this original draft", "split discarded the first draft");
  assert(await evaluate(`document.querySelector(${JSON.stringify(`${selector(first)} .conversation`)}).scrollTop`) === 80, "splitting reset the original scroll position");
  await evaluate("window.__joloSmoke.send('beta conversation')");
  await waitFor("window.__joloSmoke.state().runState === 'completed'", "second run");
  const two = await panes();
  assert(two[0].sessionId === firstSession && two[1].sessionId !== firstSession, "pane session identities mixed");
  assert(two[0].assistantText.includes("alpha conversation") && !two[0].assistantText.includes("beta conversation") && two[1].assistantText.includes("beta conversation"), "messages crossed pane boundaries");
  assert(await evaluate(`document.querySelector(${JSON.stringify(`${selector(first)} .conversation`)}).scrollTop`) === 80, "another pane's stream scrolled the original conversation");
  await type(second, "keep the second draft");
  report.checks.push("same-project panes keep separate sessions, streamed messages, drafts, and scroll positions");

  await click(second, "Split below");
  await waitFor("window.__joloSmoke.panes().length === 3 && window.__joloSmoke.state().projectId", "nested split ready");
  const third = (await panes())[2].id;
  const other = path.join(path.dirname(project), "other-project");
  mkdirSync(other, { recursive: true });
  await bridge.rawCall("project.open", { path: other });
  await evaluate("window.__joloSmoke.showBoard()"); // refresh shared project picker data
  await evaluate("window.__joloSmoke.showTask()");
  await click(third, "Choose project and task");
  await waitFor("Boolean(document.querySelector('.pane-picker[open]'))", "project picker");
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const pickerBounds = await evaluate("(() => {const r = document.querySelector('.pane-picker').getBoundingClientRect(); return {x: Math.round(r.left), y: Math.round(r.top), height: Math.round(r.height)};})()");
  const inside = { x: pickerBounds.x + 8, y: pickerBounds.y + 8 };
  const outside = { x: pickerBounds.x - 12, y: pickerBounds.y + Math.round(pickerBounds.height / 2) };
  const mouseClick = async (point, release = point) => {
    window.webContents.sendInputEvent({ type: "mouseMove", ...point });
    window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseMove", ...release });
    window.webContents.sendInputEvent({ type: "mouseUp", ...release, button: "left", clickCount: 1 });
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  };
  await mouseClick(inside);
  assert(await evaluate("Boolean(document.querySelector('.pane-picker[open]'))"), "clicking dialog padding dismissed the picker");
  await mouseClick(inside, outside);
  assert(await evaluate("Boolean(document.querySelector('.pane-picker[open]'))"), "dragging from the dialog to the backdrop dismissed the picker");
  await mouseClick(outside);
  await waitFor("!document.querySelector('.pane-picker[open]')", "backdrop dismissed picker");
  assert((await panes()).length === 3 && await draft(first) === "keep this original draft", "backdrop dismissal changed the workspace");
  report.checks.push("project picker closes on an outside click, while inside padding clicks and drags leave it open");
  await click(third, "Choose project and task");
  await waitFor("Boolean(document.querySelector('.pane-picker[open]'))", "project picker reopened");
  await evaluate("[...document.querySelectorAll('.picker-columns nav button')].find(button => button.textContent === 'other-project').click()");
  await waitFor("document.querySelector('.picker-new') && !document.querySelector('.picker-new').disabled", "other project tasks loaded");
  await evaluate("document.querySelector('.picker-new').click()");
  await waitFor("!document.querySelector('.pane-picker[open]') && window.__joloSmoke.state().projectId !== window.__joloSmoke.panes()[0].projectId", "other project chosen");
  await evaluate("window.__joloSmoke.send('gamma other project')");
  await waitFor("window.__joloSmoke.state().runState === 'completed'", "third run");
  const three = await panes();
  assert(three[2].projectId !== three[0].projectId && three[2].assistantText.includes("gamma other project"), "different project routing failed");
  await type(third, "keep the third draft");
  report.checks.push("nested horizontal and vertical splits support different projects through the project/task picker");
  await runPromptFocusSmoke({ window, evaluate, waitFor, report });
  await runTaskDragSmoke({ window, evaluate, waitFor, report, results, first, second, third });

  await evaluate("window.__joloSmoke.showSettings()");
  await waitFor("Boolean(document.querySelector('.settings-page'))", 'Settings opened over the split workspace');
  assert(await evaluate("(() => { const settings = document.querySelector('.settings-page').getBoundingClientRect(), workspace = document.querySelector('.workspace-body').getBoundingClientRect(); return Math.abs(settings.width - workspace.width) < 1 && document.querySelector('.pane-canvas').inert; })()"), 'Settings must span the workspace independently of the selected pane');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor("!document.querySelector('.settings-page')", 'Settings returned to the split workspace');
  assert(await draft(first) === 'keep this original draft' && await draft(second) === 'keep the second draft' && await draft(third) === 'keep the third draft', 'Settings discarded a pane draft');
  assert((await panes()).length === 3, 'Settings changed the split layout');
  report.checks.push('Settings spans the full workspace and restores all three panes and their drafts on exit');

  // The live DOM nodes must survive resizing, focusing, and maximizing.
  await evaluate("window.__paneNodes = [...document.querySelectorAll('.pane-slot textarea')]");
  await evaluate("document.querySelector('.pane-divider.vertical').focus()");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
  await waitFor("document.querySelector('.pane-divider.vertical').getAttribute('aria-valuenow') === '55'", "keyboard divider resizing");
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const divider = await evaluate("(() => {const r = document.querySelector('.pane-divider.vertical').getBoundingClientRect();return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/4)}})()");
  window.webContents.sendInputEvent({ type: "mouseMove", ...divider });
  window.webContents.sendInputEvent({ type: "mouseDown", ...divider, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseMove", x: divider.x - 50, y: divider.y });
  window.webContents.sendInputEvent({ type: "mouseUp", x: divider.x - 50, y: divider.y, button: "left", clickCount: 1 });
  await waitFor("document.querySelector('.pane-divider.vertical').getAttribute('aria-valuenow') !== '55'", "drag divider resizing");
  await click(second, "Maximize pane");
  await waitFor("document.querySelectorAll('.pane-slot:not([hidden])').length === 1", "maximized");
  await click(second, "Restore panes");
  await waitFor("document.querySelectorAll('.pane-slot:not([hidden])').length === 3", "restored");
  const identities = await evaluate("[...document.querySelectorAll('.pane-slot textarea')].every((node, index) => node === window.__paneNodes[index])");
  assert(identities, "layout changes remounted a composer");
  assert(await draft(first) === "keep this original draft" && await draft(second) === "keep the second draft" && await draft(third) === "keep the third draft", "resize or maximize lost a draft");
  report.checks.push("drag and keyboard resizing, maximize/restore, and focus preserve mounted composers and drafts");

  // Tool panels must fit the split's height, not the whole window's height.
  const toolBounds = async (pane) => evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(selector(pane))});
    const bounds = (selector) => {
      const el = root.querySelector(selector); const r = el?.getBoundingClientRect();
      return r ? {top: r.top, bottom: r.bottom, height: r.height, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight} : null;
    };
    return {pane: bounds('.pane-body'), main: bounds('.main'), header: bounds('.task-header'), conversation: bounds('.conversation'), composer: bounds('.compose-dock'), tools: bounds('.task-tools'), bar: bounds('.tools-bar'), content: bounds('.task-tools > div:not([hidden]):not(.tools-bar)'), chooser: bounds('.agent-chooser'), terminal: bounds('.task-tools > div:not([hidden]) .terminal')};
  })()`);
  const assertToolBounds = (b, label) => {
    assert(b.header.bottom <= b.composer.top + 1, `${label}: header overlaps composer: ${JSON.stringify(b)}`);
    assert(b.composer.bottom <= b.tools.top + 1, `${label}: tools overlap composer: ${JSON.stringify(b)}`);
    assert(b.conversation.height >= 30, `${label}: tools collapsed the conversation: ${JSON.stringify(b)}`);
    assert(b.main.bottom <= b.tools.top + 1 && b.tools.bottom <= b.pane.bottom + 1, `${label}: tools escape their pane: ${JSON.stringify(b)}`);
    assert(b.content.top >= b.bar.bottom - 1 && b.content.bottom <= b.tools.bottom + 1, `${label}: tool content escapes its panel: ${JSON.stringify(b)}`);
    if (b.terminal) assert(b.terminal.bottom <= b.tools.bottom + 1, `${label}: terminal escapes its panel`);
  };
  const originalSize = window.getSize();
  await focus(second);
  await evaluate("window.__joloSmoke.showAgents()");
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(`${selector(second)} .agent-option`)}))`, "agent chooser loaded");
  report.toolLayouts = [];
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme;
    window.setSize(1180, 860);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const bounds = await toolBounds(second);
    assertToolBounds(bounds, `${theme} split agent chooser`);
    assert(bounds.chooser.scrollHeight > bounds.chooser.clientHeight, "agent fixture must exercise internal scrolling");
    const scrolled = await evaluate(`(() => {const el = document.querySelector(${JSON.stringify(`${selector(second)} .agent-chooser`)}); el.scrollTop = el.scrollHeight; return el.scrollTop > 0;})()`);
    assert(scrolled, "agent choices are not scrollable in a short split");
    report.toolLayouts.push({theme, ...bounds});
    writeFileSync(path.join(results, `split-tools-${theme}.png`), (await window.webContents.capturePage()).toPNG());
  }
  nativeTheme.themeSource = "system";
  const hosted = await evaluate("window.__joloSmoke.startAgent('fixture')");
  const agentHook = `window.__joloTerminals?.get(${JSON.stringify(`${second}:${hosted.terminalId}`)})`;
  await waitFor(`Boolean(${agentHook}?.ready)`, "split hosted agent ready", 20_000);
  assertToolBounds(await toolBounds(second), "split hosted agent terminal");
  await evaluate("window.__joloSmoke.stopAgent(" + JSON.stringify(hosted.terminalId) + ")");
  await click(second, "Collapse tools");
  await evaluate(`document.querySelector(${JSON.stringify(`${selector(second)} .tools-bar [aria-controls="${second}-checks-panel"]`)}).click()`);
  assertToolBounds(await toolBounds(second), "split checks");
  await click(second, "Collapse tools");
  window.setSize(...originalSize);
  report.checks.push("expanded Agents and Checks stay below the composer in short splits; the chooser scrolls in both themes and hosted terminals fit their panel");

  // Each pane owns its shell: one terminal must never report another pane's screen.
  const openShell = async (pane, marker) => {
    await focus(pane);
    const failure = await evaluate("(() => { try { window.__joloSmoke.openTerminal(); return null; } catch (error) { return String(error?.message ?? error); } })()");
    if (failure) throw new Error(`opening a terminal in ${pane} failed: ${failure}`);
    const hook = `window.__joloTerminals?.get(${JSON.stringify(pane)})`;
    await waitFor(`Boolean(${hook}?.ready)`, `${pane} terminal ready`, 20_000);
    await evaluate(`${hook}.input('echo ${marker}\\n')`);
    await waitFor(`window.__joloSmoke.panes().find((entry) => entry.id === ${JSON.stringify(pane)}).terminalText.includes(${JSON.stringify(marker)})`, `${marker} echoed`, 20_000);
  };
  await openShell(first, "pane-one-shell");
  await openShell(second, "pane-two-shell");
  assertToolBounds(await toolBounds(second), "split terminal");
  const shells = await panes();
  assert(shells[0].terminalText.includes("pane-one-shell") && !shells[0].terminalText.includes("pane-two-shell"), "a pane reported another pane's terminal");
  assert(shells[1].terminalText.includes("pane-two-shell"), "the second pane lost its own terminal");
  await focus(first);
  await evaluate("window.__joloSmoke.closeTerminal()");
  await waitFor(`window.__joloSmoke.panes().find((entry) => entry.id === ${JSON.stringify(second)}).terminalText.includes("pane-two-shell")`, "sibling terminal survives a close", 10_000);
  await focus(second);
  await evaluate("window.__joloSmoke.closeTerminal()");
  report.checks.push("split panes each own a terminal; closing one leaves the other's shell readable");

  window.setSize(1440, 940);
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme;
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFileSync(path.join(results, `splits-${theme}.png`), (await window.webContents.capturePage()).toPNG());
  }
  nativeTheme.themeSource = "system";

  // Opening an existing task is supported too; both copies receive the same session's events.
  await focus(third);
  await evaluate(`window.__joloSmoke.openTarget(${JSON.stringify(project)}, ${JSON.stringify(firstSession)})`);
  await waitFor("window.__joloSmoke.state().assistantText.includes('alpha conversation')", "same session loaded");
  await evaluate("window.__joloSmoke.send('shared followup')");
  await waitFor("window.__joloSmoke.panes().filter(pane => pane.sessionId === " + JSON.stringify(firstSession) + ").every(pane => pane.runCount === 2 && pane.runState === 'completed' && pane.assistantText.includes('shared followup'))", "same session live updates");
  assert(!(await panes())[1].assistantText.includes("shared followup"), "shared-session event leaked to a different session");
  await click(third, "Close pane");
  await waitFor("window.__joloSmoke.panes().length === 2", "pane closed");
  assert(await draft(first) === "keep this original draft" && await draft(second) === "keep the second draft", "closing a sibling lost drafts");
  await focus(second);
  await evaluate("window.__joloSmoke.send('continues after pane closes')");
  await waitFor("window.__joloSmoke.state().runCount === 2 && !['completed', 'failed', 'cancelled', 'paused'].includes(window.__joloSmoke.state().runState)", "run started");
  const ongoing = await evaluate("window.__joloSmoke.state().lastRunId");
  await click(second, "Close pane");
  await waitFor("window.__joloSmoke.panes().length === 1", "last sibling closed");
  const deadline = Date.now() + 10000;
  while ((await bridge.rawCall("run.snapshot", { runId: ongoing })).run.state !== "completed") {
    if (Date.now() > deadline) throw new Error("closing a pane interrupted its run");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  report.checks.push("same-session views stay synchronized; closing a pane preserves siblings and lets accepted runs finish");
  assert((await panes())[0].error === null, "renderer error during split tests");
  writeFileSync(path.join(results, "smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
}
