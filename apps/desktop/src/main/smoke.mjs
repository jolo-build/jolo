import { app, BrowserWindow, dialog, nativeTheme, shell } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runBrowserChatSmoke, runBrowserContentionSmoke } from './browser-chat-smoke.mjs';
/** Scripted end-to-end check used by `bun run smoke`; never active in normal launches. */
export async function runSmoke(window, bridge, browserHost, { ROOT, BUILD, log }) {
  const results = process.env.JOLO_SMOKE_RESULTS;
  const project = process.env.JOLO_SMOKE_PROJECT;
  const fixture = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>Jolo smoke page</title><h1 id=\"h\">Inline browser is alive</h1><button onclick=\"this.textContent='Clicked'\">Click</button>");
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureUrl = process.env.JOLO_SMOKE_BROWSER_URL || `http://127.0.0.1:${fixture.address().port}/`;
  const evaluate = (code) => window.webContents.executeJavaScript(code, true);
  // Exercise the dialog's Enter handler even when another app owns OS keyboard focus.
  const permissionEnter = async () => {
    const handled = await evaluate("(() => { const dialog = document.querySelector('.permission-modal[open]'); if (!dialog?.contains(document.activeElement)) return false; return !document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true})); })()");
    if (!handled) throw new Error('the permission dialog did not handle automated Enter');
  };
  const waitFor = async (code, label, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await evaluate(code)) return;
      if (Date.now() > deadline) {
        const state = await evaluate("JSON.stringify(window.__joloSmoke.state())").catch(() => "unavailable");
        throw new Error(`smoke timeout: ${label}; state=${String(state).slice(0, 1500)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const report = { measuredAt: new Date().toISOString(), electron: process.versions.electron, chrome: process.versions.chrome, checks: [] };
  await waitFor("Boolean(window.__joloSmoke)", "renderer hook");
  if (process.env.JOLO_CHATS_SMOKE === '1') {
    const { runStandaloneChatsSmoke } = await import('./standalone-chats-smoke.mjs');
    try { await runStandaloneChatsSmoke({ window, bridge, project, results, evaluate, waitFor, report }); }
    finally { fixture.close(); }
    return;
  }
  await evaluate(`window.__joloSmoke.openProject(${JSON.stringify(project)})`);
  await waitFor("window.__joloSmoke.state().projectId", "project opened");
  report.checks.push("renderer opened a project through the narrow bridge");
  if (process.env.JOLO_REAL_BROWSER_AGENT) {
    const { runRealBrowserAgentSmoke } = await import('./browser-chat-smoke.mjs');
    try {
      await runRealBrowserAgentSmoke({ window, bridge, browserHost, fixtureUrl, evaluate, waitFor, report, results, agentId: process.env.JOLO_REAL_BROWSER_AGENT });
      writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
    } finally { fixture.close(); }
    return;
  }
  if (process.env.JOLO_BOARD_SMOKE === '1') {
    const { runBoardSmoke } = await import('./board-smoke.mjs');
    try {
      await runBoardSmoke({ window, bridge, project, results, evaluate, waitFor, report });
      writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
    } finally { fixture.close(); }
    return;
  }
  if (process.env.JOLO_HISTORY_SMOKE === '1') {
    const { runHistorySmoke } = await import('./history-smoke.mjs');
    try {
      await runHistorySmoke({ window, bridge, results, evaluate, waitFor, report });
      writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
    } finally { fixture.close(); }
    return;
  }
  if (process.env.JOLO_BROWSER_CHAT_SMOKE === '1') {
    try {
      await runBrowserChatSmoke({ bridge, browserHost, fixtureUrl, evaluate, waitFor, report });
      await runBrowserContentionSmoke({ browserHost, project, evaluate, waitFor, report });
      writeFileSync(path.join(results, 'browser-chat.png'), (await window.webContents.capturePage()).toPNG());
      writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
    } finally { fixture.close(); }
    return;
  }
  if (process.env.JOLO_TASKS_SMOKE === '1') {
    const { runTasksSmoke } = await import('./tasks-smoke.mjs');
    try {
      await runTasksSmoke({ window, bridge, results, evaluate, waitFor, report });
      writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
    } finally { fixture.close(); }
    return;
  }
  if (process.env.JOLO_ATTACHMENTS_SMOKE === '1') {
    const { runAttachmentsSmoke } = await import('./attachments-smoke.mjs');
    try {
      await runAttachmentsSmoke({ window, bridge, results, evaluate, waitFor, report });
      writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
    } finally { fixture.close(); }
    return;
  }
  if (process.env.JOLO_LIVE_RESULTS_SMOKE === "1") {
    const { runLiveResultsSmoke } = await import('./live-results-smoke.mjs');
    try { await runLiveResultsSmoke({ window, bridge, results, evaluate, waitFor, report }); }
    finally { fixture.close(); }
    return;
  }
  const { runSidebarSmoke } = await import('./sidebar-smoke.mjs');
  await runSidebarSmoke({ window, results, project, evaluate, waitFor, report });
  await waitFor("window.__joloSmoke.state().projectId", 'project restored after sidebar reload');
  if (process.env.JOLO_SPLIT_SMOKE === "1") {
    const { runSplitSmoke } = await import("./split-smoke.mjs");
    try { await runSplitSmoke({ window, bridge, project, results, evaluate, waitFor, report }); }
    finally { fixture.close(); }
    return;
  }
  const { runSettingsSmoke } = await import('./settings-smoke.mjs');
  await runSettingsSmoke({ window, results, evaluate, waitFor, report });
  if (process.env.JOLO_MODELS_SMOKE === '1') {
    writeFileSync(path.join(results, 'smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
    fixture.close();
    return;
  }
  const assertSingleConversation = async () => {
    const counts = await evaluate('({ conversations: document.querySelectorAll(".conversation").length, composers: document.querySelectorAll(".composer").length, emptyStates: document.querySelectorAll(".empty-state").length })');
    if (counts.conversations !== 1 || counts.composers !== 1 || counts.emptyStates > 1) throw new Error(`duplicate workspace content: ${JSON.stringify(counts)}`);
  };
  await assertSingleConversation();
  await evaluate("window.__joloSmoke.send('smoke test prompt')");
  await waitFor("window.__joloSmoke.state().runState === 'completed'", "run completed");
  const text = await evaluate("window.__joloSmoke.state().assistantText");
  if (!text.includes("done: smoke test prompt")) throw new Error(`unexpected assistant text: ${text}`);
  report.checks.push("streamed a fake-provider run to completion with previews and committed text");
  await assertSingleConversation();
  if (await evaluate('document.querySelectorAll(".empty-state").length')) throw new Error("empty state survived a completed run");
  report.checks.push("workspace transitions keep exactly one conversation and composer, and remove the empty state");
  const chatSize = window.getSize();
  const settleLayout = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const setDraft = async (value) => {
    await evaluate(`(() => { const input = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await settleLayout();
  };
  try {
    for (const width of [chatSize[0], 800]) {
      window.setSize(width, chatSize[1]);
      await settleLayout();
      const aligned = await evaluate(`(() => {
        const message = document.querySelector('.message.assistant').getBoundingClientRect();
        const composer = document.querySelector('.composer').getBoundingClientRect();
        const conversation = document.querySelector('.conversation').getBoundingClientRect();
        return Math.abs(message.left - composer.left) <= 1 && Math.abs(message.right - composer.right) <= 1 && composer.top - conversation.bottom >= 12;
      })()`);
      if (!aligned) throw new Error(`composer and transcript alignment or separation failed at width ${width}`);
    }
    const emptyHeight = await evaluate("document.querySelector('.composer textarea').clientHeight");
    await setDraft(Array.from({ length: 30 }, (_, index) => `Draft line ${index + 1}`).join("\n"));
    const grows = await evaluate(`(() => { const input = document.querySelector('.composer textarea'); return input.clientHeight > ${emptyHeight} && input.clientHeight <= 160 && input.scrollHeight > input.clientHeight; })()`);
    if (!grows) throw new Error("draft did not grow to a bounded, scrollable textarea");
    await setDraft("");
    if (await evaluate("document.querySelector('.composer textarea').clientHeight") !== emptyHeight) throw new Error("cleared draft did not shrink");
    writeFileSync(path.join(results, "conversation-narrow.png"), (await window.webContents.capturePage()).toPNG());
    report.checks.push("transcript and composer edges stay aligned at wide and narrow widths; long drafts grow, scroll, and shrink when cleared");
  } finally { await setDraft(""); window.setSize(...chatSize); await settleLayout(); }
  if (process.env.JOLO_FAKE_SCRIPT) {
    await waitFor('document.querySelector(".md-embed .md h3")?.textContent === "Plan" && document.querySelector(".md-embed .md strong")?.textContent === "first"', "markdown fence rendered as markdown");
    await evaluate('document.querySelector(".md-embed-toggle").click()');
    await waitFor('document.querySelector(".md-embed pre code")?.textContent.startsWith("# Plan")', "markdown fence source view");
    await evaluate('document.querySelector(".md-embed-toggle").click()');
    report.checks.push("a markdown fence in the reply rendered as a document with its source one click away");

    // A mermaid fence is drawn, not printed: the same parser and layout the terminal client uses (§4.4).
    await waitFor('document.querySelectorAll(".md-diagram .mermaid-svg .mermaid-shape").length >= 4', "mermaid fence drawn as a diagram", 10_000);
    const diagram = await evaluate(`(() => {
      const svg = document.querySelector(".md-diagram .mermaid-svg");
      return {
        labels: [...svg.querySelectorAll("text")].map((node) => node.textContent),
        shapes: svg.querySelectorAll(".mermaid-shape").length,
        diamonds: svg.querySelectorAll("polygon.mermaid-shape").length,
        links: svg.querySelectorAll("path.mermaid-link").length,
        arrows: [...svg.querySelectorAll("path.mermaid-link")].filter((node) => node.getAttribute("marker-end")).length,
        overflows: svg.getBoundingClientRect().width > svg.parentElement.getBoundingClientRect().width + 1,
      };
    })()`);
    // "Save\nto disk" is one label over two lines: a break is a break, not two characters on screen.
    for (const word of ["Read", "Valid?", "Save", "to disk", "Reject", "yes", "no"]) if (!diagram.labels.includes(word)) throw new Error(`diagram is missing ${word}: ${JSON.stringify(diagram.labels)}`);
    if (diagram.diamonds !== 1) throw new Error(`a decision should be drawn as a diamond: ${JSON.stringify(diagram)}`);
    if (diagram.links !== 3 || diagram.arrows !== 3) throw new Error(`every link should be drawn with a head: ${JSON.stringify(diagram)}`);
    if (diagram.overflows) throw new Error("the diagram is wider than the pane it sits in");
    // The second fence is a sequence diagram: lifelines, messages, and a bracketed block.
    const sequence = await evaluate(`(() => {
      const svg = document.querySelectorAll(".md-diagram .mermaid-svg")[1];
      return {
        labels: [...svg.querySelectorAll("text")].map((node) => node.textContent),
        lifelines: svg.querySelectorAll(".mermaid-lifeline").length,
        messages: svg.querySelectorAll("line.mermaid-link").length,
        rails: svg.querySelectorAll(".mermaid-rail").length,
      };
    })()`);
    for (const word of ["User", "Jolo", "run task", "needs you", "loop retry", "again"]) if (!sequence.labels.includes(word)) throw new Error(`sequence diagram is missing ${word}: ${JSON.stringify(sequence.labels)}`);
    if (sequence.lifelines !== 2 || sequence.messages !== 3 || sequence.rails !== 1) throw new Error(`sequence diagram is not drawn as expected: ${JSON.stringify(sequence)}`);
    writeFileSync(path.join(results, "mermaid.png"), (await window.webContents.capturePage()).toPNG());
    // The same diagram in the other theme: it takes its colours from the app rather than baking them in.
    nativeTheme.themeSource = "dark";
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    writeFileSync(path.join(results, "mermaid-dark.png"), (await window.webContents.capturePage()).toPNG());
    nativeTheme.themeSource = "system";
    await evaluate('document.querySelector(".md-diagram .md-embed-toggle").click()');
    await waitFor('document.querySelector(".md-diagram pre code")?.textContent.startsWith("flowchart LR")', "mermaid source view");
    await evaluate('document.querySelector(".md-diagram .md-embed-toggle").click()');
    report.checks.push("mermaid fences in the reply were drawn as SVG diagrams, a flowchart and a sequence diagram, in both themes and with their source one click away");

    // What the task has cost, in front of the who-answers picker: a ring for how full the window is (§7.2).
    await waitFor("Boolean(document.querySelector('.usage-ring'))", "usage ring sits in the composer");
    const ring = await evaluate(`(() => {
      const button = document.querySelector(".usage-ring");
      const select = document.querySelector(".model-select");
      return {
        label: button.getAttribute("aria-label"),
        filled: Boolean(button.querySelector(".usage-fill")),
        beforeTheSelector: Boolean(select && button.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    })()`);
    if (!ring.beforeTheSelector) throw new Error("the usage ring should sit in front of the model selector");
    if (!ring.filled || !/Context \d+% full/.test(ring.label)) throw new Error(`the ring should show how full the window is: ${JSON.stringify(ring)}`);
    await evaluate('document.querySelector(".usage-ring").click()');
    await waitFor("Boolean(document.querySelector('.usage-panel'))", "usage panel opens on click");
    const panel = await evaluate('document.querySelector(".usage-panel").textContent');
    for (const word of ["Context", "Tokens in", "Tokens out", "Model turns"]) if (!panel.includes(word)) throw new Error(`usage panel is missing ${word}: ${panel}`);
    if (!/Context.*\bof\b.*%/.test(panel)) throw new Error(`usage panel should name the window it measured: ${panel}`);
    // The panel escapes the panes, which clip their contents, so it has to be whole and on top of them.
    const placed = await evaluate('(() => {' +
      'const node = document.querySelector(".usage-panel");' +
      'const box = node.getBoundingClientRect();' +
      'return {' +
        'onScreen: box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth,' +
        'rows: [...node.querySelectorAll("dl > div")].length,' +
        'clipped: node.scrollHeight > node.clientHeight + 1,' +
        'onTop: document.elementsFromPoint(box.left + box.width / 2, box.top + 10)[0] === node,' +
      '};' +
    '})()');
    if (!placed.onScreen || placed.rows !== 4 || placed.clipped || !placed.onTop) throw new Error(`the usage panel is not fully shown: ${JSON.stringify(placed)}`);
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    writeFileSync(path.join(results, "usage.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate('document.querySelector(".usage-ring").click()');
    await waitFor("!document.querySelector('.usage-panel')", "usage panel closes again");
    report.checks.push("the composer shows how full the model's context is as a ring in front of the answerer picker, and opens the task's token usage when clicked");
    await waitFor('document.querySelectorAll(".md-code .syntax-token.keyword").length >= 3', "Python syntax highlighting loaded");
    const source = text.match(/```python\n([\s\S]*?)\n```/)?.[1];
    if (await evaluate('document.querySelector(".md-code code").textContent') !== source) throw new Error("syntax highlighting changed the source text");
    const previousTheme = nativeTheme.themeSource;
    try {
      for (const theme of ["light", "dark"]) {
        nativeTheme.themeSource = theme;
        await waitFor(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"}`, `${theme} code theme`);
        const colors = await evaluate('Object.fromEntries(["keyword", "string", "comment", "function"].map(kind => [kind, getComputedStyle(document.querySelector(".md-code .syntax-token." + kind)).color]))');
        if (new Set(Object.values(colors)).size !== 4) throw new Error(`${theme} syntax colors are missing: ${JSON.stringify(colors)}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        writeFileSync(path.join(results, `code-${theme}.png`), (await window.webContents.capturePage()).toPNG());
        // Inspect the transition with a code block crossing the viewport edge.
        const fullSize = window.getSize();
        try {
          window.setSize(800, 560);
          await settleLayout();
          await evaluate("(() => { const scroller = document.querySelector('.conversation'); const block = document.querySelector('.md-code-block'); scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom + 100; })()");
          await settleLayout();
          writeFileSync(path.join(results, `composer-scroll-${theme}.png`), (await window.webContents.capturePage()).toPNG());
        } finally { window.setSize(...fullSize); await settleLayout(); }
      }
    } finally { nativeTheme.themeSource = previousTheme; }
    report.checks.push("Python code loaded its highlighting chunk, preserved the source, and displayed distinct syntax colors in both themes");
  }
  report.relay = bridge.relay.stats;
  if (process.env.JOLO_FAKE_SCRIPT) {
    await runBrowserChatSmoke({ bridge, browserHost, fixtureUrl, evaluate, waitFor, report });

    const before = await evaluate("window.__joloSmoke.state().runCount");
    await evaluate("window.__joloSmoke.send('run a command')");
    await waitFor("Boolean(window.__joloSmoke.state().pendingPermission)", "permission dialog", 20_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(path.join(results, "permission.png"), (await window.webContents.capturePage()).toPNG());
    const badge = () => (process.platform === "darwin" ? app.dock.getBadge() : String(app.getBadgeCount() || ""));
    const boardRow = async () => (await bridge.rawCall("board.list", {})).projects.find((row) => row.name === path.basename(project));
    const waiting = await boardRow();
    if (waiting?.attention !== "needs_you" || !waiting.pendingPermission) throw new Error(`board row while waiting: ${JSON.stringify(waiting)?.slice(0, 500)}`);
    for (const deadline = Date.now() + 5_000; badge() !== "1";) { if (Date.now() > deadline) throw new Error(`dock badge is "${badge()}", expected "1"`); await new Promise((r) => setTimeout(r, 50)); }
    if (!bridge.attention.notified.some((n) => n.kind === "approval" && n.permissionId === waiting.pendingPermission.permissionId)) throw new Error(`no approval notification: ${JSON.stringify(bridge.attention.notified)}`);
    report.checks.push("the board listed the project under needs-you with its pending request, the dock badge counted it, and a notification was raised");
    await evaluate("(() => { const select = document.querySelector('.permission-modal select'); select.value = 'allow_run'; select.dispatchEvent(new Event('change', {bubbles:true})); })()");
    await evaluate("document.querySelector('.permission-modal .primary').focus()");
    await permissionEnter();
    await waitFor(`window.__joloSmoke.state().runCount > ${before} && ['completed','failed','paused'].includes(window.__joloSmoke.state().runState)`, "command run finished", 30_000);
    const after = await evaluate("window.__joloSmoke.state()");
    if (after.runState !== "completed" || !after.toolText.includes("smoke-command-ok")) throw new Error(`command run ended ${after.runState}: ${after.toolText.slice(-600)}`);
    await waitFor("![...document.querySelectorAll('.notice-title')].some(node => node.textContent.includes('needs your approval'))", "resolved approval notice removed");
    report.checks.push("a command required approval, the dialog approved it for the task, and its live output reached the renderer");
    {
      // Every finished task raises news of some kind: a system notification when the window is away, or the
      // same words inside the app when it is here. Which one depends on the window, so both are accepted.
      const raised = bridge.attention.notified.filter((entry) => entry.kind === "run");
      if (!raised.length) throw new Error("a finished task raised no notification at all");
      if (!raised.every((entry) => entry.via === "app" || entry.via === "os")) throw new Error(`every notification says how it was delivered: ${JSON.stringify(raised.slice(-2))}`);
      report.checks.push(`a finished task raised news of itself (${raised.at(-1).via === "app" ? "in the app" : "as a system notification"})`);
    }
    for (const deadline = Date.now() + 5_000; badge() !== "";) { if (Date.now() > deadline) throw new Error(`dock badge is "${badge()}" after completion`); await new Promise((r) => setTimeout(r, 50)); }
    if (!bridge.attention.notified.some((n) => n.kind === "run" && n.title.endsWith("done"))) throw new Error(`no completion notification: ${JSON.stringify(bridge.attention.notified)}`);
    for (const name of ["website", "api-service", "design-system"]) {
      const directory = path.join(project, "..", name);
      mkdirSync(directory, { recursive: true });
      await bridge.rawCall("project.open", { path: directory });
    }
    await evaluate("window.__joloSmoke.showBoard()");
    await waitFor("window.__joloSmoke.state().view === 'board' && document.querySelectorAll('.board-row').length >= 1", "board view", 10_000);
    await waitFor("window.__joloSmoke.state().needsYou === 0 && /done|ready|stopped|idle/i.test(document.querySelector('.board-row .chip')?.textContent ?? '')", "board row refreshed after completion", 10_000);
    await waitFor("document.querySelectorAll('.board-row').length >= 4", "multiple board projects");
    const boardTheme = nativeTheme.themeSource;
    const boardWindowSize = window.getSize();
    try {
      for (const theme of ["light", "dark"]) {
        nativeTheme.themeSource = theme;
        await waitFor(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"}`, `${theme} board theme`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        writeFileSync(path.join(results, `board-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      }
      window.setSize(800, 860);
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (await evaluate("document.querySelector('.board').scrollWidth > document.querySelector('.board').clientWidth")) throw new Error("board overflows at narrow width");
      if (await evaluate("Boolean(document.querySelector('.board button button'))")) throw new Error("board contains nested buttons");
      writeFileSync(path.join(results, "board-narrow.png"), (await window.webContents.capturePage()).toPNG());
    } finally { window.setSize(...boardWindowSize); nativeTheme.themeSource = boardTheme; }
    report.checks.push("the workspace board renders multiple compact rows in both themes and fits a narrow window without nested buttons");
    await evaluate("[...document.querySelectorAll('.board-card')].find(card => card.dataset.workspaceId === window.__joloSmoke.state().workspaceId).querySelector('.board-expand').click()");
    await waitFor("Boolean(document.querySelector('.board-workspace-tasks .board-task'))", "workspace task list", 5_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const settled = await boardRow();
    if (!settled?.run?.note || settled.attention === "needs_you") throw new Error(`board row after completion: ${JSON.stringify(settled)?.slice(0, 500)}`);
    writeFileSync(path.join(results, "board.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate("window.__joloSmoke.showTask()");
    report.checks.push("the board expanded the workspace into its chats, and the badge cleared once nothing needed the user");

    await evaluate("window.__joloSmoke.openTerminal()");
    await waitFor("Boolean(window.__joloTerminal?.ready) && window.__joloSmoke.state().terminalText.length > 0", "terminal ready with a prompt", 15_000);
    const fonts = await evaluate(`(() => {
      const loaded = (family) => { const faces = [...document.fonts].filter((f) => f.family.replaceAll('"', "") === family); return faces.length > 0 && faces.some((f) => f.status === "loaded"); };
      return { ui: getComputedStyle(document.body).fontFamily, code: getComputedStyle(document.querySelector("code, pre") ?? document.body).fontFamily, terminal: window.__joloTerminal.fontFamily(), inter: loaded("Inter"), mono: loaded("JetBrains Mono"), nerd: loaded("JetBrainsMono Nerd Font Mono") };
    })()`);
    if (!fonts.ui.startsWith("Inter") || !fonts.inter) throw new Error(`interface font not applied: ${JSON.stringify(fonts)}`);
    if (!fonts.terminal.startsWith('"JetBrainsMono Nerd Font Mono"') || !fonts.nerd) throw new Error(`terminal font not applied: ${JSON.stringify(fonts)}`);
    report.checks.push("bundled fonts loaded: Inter for the interface and the JetBrains Mono Nerd Font for the terminal, before the terminal measured its grid");
    report.fonts = fonts;
    await evaluate("window.__joloTerminal.input('echo smoke-term-$((20+22))\\n')");
    await waitFor("window.__joloSmoke.state().terminalText.includes('smoke-term-42')", "terminal echo", 15_000);
    writeFileSync(path.join(results, "terminal.png"), (await window.webContents.capturePage()).toPNG());
    report.checks.push("the terminal pane opened an engine-owned shell, sent keystrokes, and rendered its output");

    const runsBeforeNotes = await evaluate("window.__joloSmoke.state().runCount");
    await evaluate("window.__joloSmoke.send('edit notes')");
    await waitFor(`window.__joloSmoke.state().runCount > ${runsBeforeNotes} && window.__joloSmoke.state().runState === 'completed' && window.__joloSmoke.state().changes > 0`, "notes edit finished", 30_000);
    // The diff of the edit is shown where the edit is: open its line in the task activity (§9.3).
    await evaluate(`(() => { const blocks = [...document.querySelectorAll("details.block.tool")]; const edit = blocks.findLast((block) => block.querySelector("summary")?.textContent.includes("replace_exact")); document.querySelector("details.activity-group").open = true; edit.open = true; edit.dispatchEvent(new Event("toggle")); })()`);
    await waitFor('Boolean(document.querySelector("details.block.tool[open] .tool-diff .diff-line.add"))', "the edit's own line shows its diff", 10_000);
    const inlineDiff = await evaluate(`(() => {
      const block = [...document.querySelectorAll("details.block.tool[open]")].find((node) => node.querySelector(".tool-diff"));
      return {
        head: block.querySelector(".tool-diff-head")?.textContent,
        added: [...block.querySelectorAll(".tool-diff .diff-line.add")].map((node) => node.textContent),
        meta: [...block.querySelectorAll(".tool-diff .diff-line.meta")].map((node) => node.textContent),
      };
    })()`);
    if (!inlineDiff.added.some((line) => line.includes("third"))) throw new Error(`the inline diff should show the added line: ${JSON.stringify(inlineDiff)}`);
    if (!inlineDiff.meta.some((line) => line.includes("NOTES.md"))) throw new Error(`the inline diff should name the file: ${JSON.stringify(inlineDiff)}`);
    if (!/1 file.*\+1/.test(inlineDiff.head ?? "")) throw new Error(`the inline diff should count what changed: ${JSON.stringify(inlineDiff.head)}`);
    await waitFor("Boolean(document.querySelector('.tool-diff .diff-line.add .syntax-token.bold'))", 'inline diff highlights Markdown syntax');
    // The group can fold again on a later re-render; open it once more right before the picture is taken.
    // Every group is opened (the edit may sit in a later turn than the first group), the edit's block is opened through
    // its toggle so React renders the diff, and the picture waits until that diff is actually in the document.
    await evaluate(`(() => { for (const group of document.querySelectorAll("details.activity-group")) group.open = true; const blocks = [...document.querySelectorAll("details.block.tool")]; const edit = blocks.findLast((block) => block.querySelector("summary")?.textContent.includes("replace_exact")); if (edit && !edit.open) { edit.open = true; edit.dispatchEvent(new Event("toggle")); } edit?.scrollIntoView({ block: "center" }); })()`);
    await waitFor(`Boolean(document.querySelector("details.block.tool[open] .tool-diff .diff-line.add"))`, "the diff is on screen before the picture");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    writeFileSync(path.join(results, "inline-diff.png"), (await window.webContents.capturePage()).toPNG());
    report.checks.push("an edit's own line in the task activity opens to the diff of what it changed, with the file named and the lines counted");

    await evaluate("window.__joloSmoke.showChanges()");
    await waitFor('document.querySelector(".file-modes [role=tab]:nth-child(2)")', "markdown file offers a preview", 10_000);
    await evaluate('document.querySelector(".file-modes [role=tab]:nth-child(2)").click()');
    await waitFor('document.querySelector(".md-preview .md h3")?.textContent === "Smoke notes" && document.querySelector(".md-preview .md strong")?.textContent === "third"', "markdown file preview rendered", 10_000);
    writeFileSync(path.join(results, "markdown-preview.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate('document.querySelector(".file-modes [role=tab]:nth-child(1)").click()');
    await waitFor('document.querySelector(".diff-line.add")?.textContent.includes("third")', "diff view returns", 10_000);
    report.checks.push("an edited markdown file previews as rendered markdown in the changes panel and switches back to its diff");

    // A hosted third-party agent: Jolo starts it, observes it, and leaves the answering to the user (§4.3).
    const catalog = (await bridge.rawCall("agent.catalog", {})).agents;
    if (!catalog.find((entry) => entry.id === "fixture")?.available) throw new Error(`fixture agent missing from the catalog: ${JSON.stringify(catalog.map((entry) => entry.id))}`);
    await evaluate("window.__joloSmoke.showAgents()");
    await waitFor("Boolean(document.querySelector('.agent-chooser .agent-option'))", "agent chooser listed installed agents");
    const hosted = await evaluate("window.__joloSmoke.startAgent('fixture')");
    await waitFor(`window.__joloSmoke.agents().some((agent) => agent.terminalId === ${JSON.stringify(hosted.terminalId)} && agent.status === "needs_input" && agent.statusSource === "screen")`, "hosted agent asks for the user", 20_000);
    await waitFor("document.querySelector('.agent-bar .chip.needs')?.textContent === 'Needs you'", "hosted agent status shown");
    await bridge.rawCall("terminal.input", { terminalId: hosted.terminalId, data: "y\n" });
    await waitFor(`window.__joloSmoke.agents().some((agent) => agent.terminalId === ${JSON.stringify(hosted.terminalId)} && agent.status === "done" && agent.statusSource === "process")`, "hosted agent finished", 20_000);
    writeFileSync(path.join(results, "agents.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate(`window.__joloSmoke.stopAgent(${JSON.stringify(hosted.terminalId)})`);
    await waitFor("window.__joloSmoke.agents().length === 0", "hosted agent cleared");
    report.checks.push("a third-party agent CLI ran inside the workspace, its request for the user was observed from its screen, and its exit was reported by the process");

    // Claude Code through its structured stream: chosen in the composer, answered as a task, permissions routed to Jolo's dialog.
    await evaluate("window.__joloSmoke.showTask()");
    if (!(await evaluate("window.__joloSmoke.hostedAgents()")).some((entry) => entry.id === "claude" && entry.available)) throw new Error("hosted Claude Code is missing from the composer picker");
    await evaluate("window.__joloSmoke.pickAnswerer('claude')");
    await waitFor("window.__joloSmoke.state().answerer === 'Claude Code'", "composer shows Claude Code as the answerer");
    await evaluate("window.__joloSmoke.send('run sleep 2; echo hosted-smoke-ok')");
    await waitFor("window.__joloSmoke.state().sessionAgentId === 'claude' && Boolean(window.__joloSmoke.state().pendingPermission)", "the hosted agent's command reached Jolo's permission dialog", 20_000);
    await waitFor("document.activeElement === document.querySelector('.permission-modal .primary')", 'Allow once is focused when the permission dialog opens');
    const heldEnterBlocked = await evaluate("(() => { const event = new KeyboardEvent('keydown', {key:'Enter', repeat:true, bubbles:true, cancelable:true}); document.activeElement.dispatchEvent(event); return event.defaultPrevented && Boolean(window.__joloSmoke.state().pendingPermission); })()");
    if (!heldEnterBlocked) throw new Error('holding Enter must not accept another permission');
    writeFileSync(path.join(results, "hosted-permission.png"), (await window.webContents.capturePage()).toPNG());
    await permissionEnter();
    await waitFor("!document.querySelector('.permission-modal[open]') && Boolean(document.querySelector('.composer .stop-progress'))", 'Enter approved the fixture command without manual input');
    const progressTheme = nativeTheme.themeSource;
    try {
      for (const theme of ['light', 'dark']) {
        nativeTheme.themeSource = theme;
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const progress = await evaluate(`(async () => {
          const button = document.querySelector('.composer .stop-button');
          const arc = button?.querySelector('.stop-progress-arc');
          const animation = arc?.getAnimations()[0];
          const before = animation?.currentTime;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const bounds = button.getBoundingClientRect();
          return {animated: animation?.playState === 'running' && animation.currentTime > before, label: button.getAttribute('aria-label'), rect: {x: Math.floor(bounds.x - 8), y: Math.floor(bounds.y - 8), width: Math.ceil(bounds.width + 16), height: Math.ceil(bounds.height + 16)}};
        })()`);
        if (!progress.animated || progress.label !== 'Stop task') throw new Error(`working indicator failed in ${theme}: ${JSON.stringify(progress)}`);
        writeFileSync(path.join(results, `composer-progress-${theme}.png`), (await window.webContents.capturePage(progress.rect)).toPNG());
      }
    } finally { nativeTheme.themeSource = progressTheme; }
    await waitFor("window.__joloSmoke.state().sessionAgentId === 'claude' && window.__joloSmoke.state().runState === 'completed'", "hosted turn completed", 30_000);
    const hostedState = await evaluate("window.__joloSmoke.state()");
    await waitFor("!document.querySelector('.composer .stop-progress') && Boolean(document.querySelector('.composer [aria-label=\"Send message\"]'))", 'working indicator returns to Send after the completed state renders');
    report.checks.push('Enter approves the default Allow once action, selected permission scopes still work, and held Enter is ignored; the stop control animates in both themes and returns to Send on completion');
    if (!hostedState.assistantText.includes("The command printed: hosted-smoke-ok")) throw new Error(`hosted reply missing: ${hostedState.assistantText.slice(-300)}`);
    if (!hostedState.toolText.includes('Bash {"command":"sleep 2; echo hosted-smoke-ok"}')) throw new Error(`hosted tool call missing: ${hostedState.toolText.slice(-300)}`);
    if ((await evaluate("document.querySelector('.task-header .task-agent')?.textContent")) !== "Claude Code") throw new Error("hosted task is not identified in the task header");
    const replyLabel = await evaluate("[...document.querySelectorAll('.message.assistant .message-label')].at(-1)?.textContent");
    if (replyLabel !== "Claude Code") throw new Error(`a hosted reply must carry the agent's name, not Jolo's: ${JSON.stringify(replyLabel)}`);
    if (!(await evaluate("document.querySelector('.composer textarea').placeholder")).startsWith("Ask Claude Code")) throw new Error("composer placeholder still addresses Jolo for a hosted task");
    writeFileSync(path.join(results, "hosted-agent.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate("window.__joloSmoke.pickAnswerer(null)");
    report.checks.push("Claude Code chosen in the composer answered as a task: its reply streamed into the conversation, its command ran only after Jolo's permission dialog, and the task is tagged as hosted");

    // Codex and ACP continue the same conversation; permissions still go through Jolo's dialog.
    const continuedSessionId = await evaluate("window.__joloSmoke.state().sessionId");
    for (const [agentId, label, prompt, toolLine] of [["codex", "Codex", "run echo codex-smoke-ok", "command echo codex-smoke-ok"], ["grok", "Grok CLI", "run echo acp-smoke-ok", "execute Execute `echo acp-smoke-ok` echo acp-smoke-ok"]]) {
      if (!(await evaluate("window.__joloSmoke.hostedAgents()")).some((entry) => entry.id === agentId && entry.available)) throw new Error(`hosted ${label} is missing from the composer picker`);
      await evaluate(`window.__joloSmoke.pickAnswerer(${JSON.stringify(agentId)})`);
      await waitFor(`window.__joloSmoke.state().answerer === ${JSON.stringify(label)}`, `composer shows ${label} as the answerer`);
      await evaluate(`window.__joloSmoke.send(${JSON.stringify(prompt)})`);
      await waitFor(`window.__joloSmoke.state().sessionAgentId === ${JSON.stringify(agentId)} && Boolean(window.__joloSmoke.state().pendingPermission)`, `${label}'s command reached Jolo's permission dialog`, 20_000);
      if (agentId === 'grok') {
        await evaluate("document.querySelector('[aria-label=\"Close context panel\"]')?.click()");
        const waiting = await evaluate('window.__joloSmoke.state()');
        await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(waiting.sessionId)})`);
        await waitFor(`window.__joloSmoke.state().pendingPermission === ${JSON.stringify(waiting.pendingPermission)} && Boolean(document.querySelector('.permission-modal[open]'))`, 'Grok approval restored after reopening the task');
        const otherPane = await evaluate("window.__joloSmoke.split('x')");
        await waitFor("window.__joloSmoke.panes().length === 2 && Boolean(window.__joloSmoke.state().projectId) && !document.querySelector('.permission-modal[open]')", 'another pane can be used while Grok waits');
        await waitFor("document.querySelector('.permission-notice button')?.getBoundingClientRect().height > 0", 'inactive pane offers a visible review action');
        writeFileSync(path.join(results, 'grok-approval-waiting.png'), (await window.webContents.capturePage()).toPNG());
        await evaluate("document.querySelector('.permission-notice button').click()");
        await waitFor(`window.__joloSmoke.state().pendingPermission === ${JSON.stringify(waiting.pendingPermission)} && document.querySelector('.permission-modal[open]')?.getBoundingClientRect().height > 0`, 'review action opens Grok approval');
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        if (!(await evaluate("document.querySelector('.permission-modal[open]')?.getBoundingClientRect().height > 0"))) throw new Error('Grok approval lost focus immediately after opening');
        writeFileSync(path.join(results, 'grok-approval-restored.png'), (await window.webContents.capturePage()).toPNG());
        await evaluate(`window.__joloSmoke.closePane(${JSON.stringify(otherPane)})`);
        report.checks.push('Grok approvals survive reopening a session and offer Review request in an inactive split pane');
      }
      await evaluate("document.querySelector('.permission-modal').focus()");
      await permissionEnter();
      await waitFor(`window.__joloSmoke.state().sessionAgentId === ${JSON.stringify(agentId)} && window.__joloSmoke.state().runState === 'completed'`, `${label} turn completed`, 30_000);
      const agentState = await evaluate("window.__joloSmoke.state()");
      if (agentState.sessionId !== continuedSessionId) throw new Error("changing the composer agent created a new session");
      if (!agentState.assistantText.includes(`The command printed: ${prompt.slice(9)}`)) throw new Error(`${label} reply missing: ${agentState.assistantText.slice(-300)}`);
      if (!agentState.toolText.includes(toolLine)) throw new Error(`${label} tool call missing: ${agentState.toolText.slice(-300)}`);
      await waitFor(`[...document.querySelectorAll('.message.assistant .message-label')].at(-1)?.textContent === ${JSON.stringify(label)}`, `${label}'s completed reply renders its name`);
      if (agentId === 'codex') {
        // Vendor tools and shells write directly, without Jolo's files.changed events.
        writeFileSync(path.join(project, 'src/app.js'), 'export const answer = 43;\n');
        writeFileSync(path.join(project, 'hosted-new.txt'), 'Created outside Jolo file tools.\n');
        await evaluate('window.__joloSmoke.showChanges()');
        await waitFor("[...document.querySelectorAll('.change-file')].some(node => node.textContent.includes('hosted-new.txt')) && [...document.querySelectorAll('.change-file')].some(node => node.textContent.includes('src/app.js'))", 'direct hosted edits appear in working changes');
        await evaluate("[...document.querySelectorAll('.change-file')].find(node => node.textContent.includes('hosted-new.txt')).click()");
        await waitFor("document.querySelector('.changes .diff-line.add')?.textContent.includes('Created outside')", 'new hosted file has a diff');
        if (await evaluate("Boolean(document.querySelector('.review-footer .subtle-danger'))")) throw new Error('a direct hosted edit has no Jolo undo record');
        await evaluate("document.querySelector('.review-footer .primary').click()");
        await waitFor("document.querySelector('.changes .panel-heading')?.textContent.includes('1 of 3 reviewed')", 'hosted file is marked reviewed');
        writeFileSync(path.join(project, 'hosted-new.txt'), 'Updated outside Jolo file tools.\n');
        await waitFor("document.querySelector('.changes .panel-heading')?.textContent.includes('0 of 3 reviewed')", 'external edits invalidate review');
        await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(agentState.sessionId)})`);
        await waitFor("[...document.querySelectorAll('.change-file')].some(node => node.textContent.includes('hosted-new.txt'))", 'working files survive reopening a hosted session');
        await evaluate("[...document.querySelectorAll('.change-file')].find(node => node.textContent.includes('hosted-new.txt')).click()");
        await waitFor("document.querySelector('.changes .diff-line.add')?.textContent.includes('Updated outside')", 'restored hosted file has the latest diff');
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        writeFileSync(path.join(results, 'hosted-working-changes.png'), (await window.webContents.capturePage()).toPNG());
        report.checks.push('direct Codex/shell edits and untracked files appear with current diffs, persist after reopening, and do not offer unsupported Revert');
        await evaluate("[...document.querySelectorAll('.change-file')].find(node => node.textContent.includes('src/app.js')).click()");
        await waitFor("document.querySelector('.changes .diff-line.add .syntax-token.number')?.textContent === '43' && document.querySelector('.changes .diff-line.remove .syntax-token.number')?.textContent === '42'", 'diff highlights syntax on both sides of the edit');
        const previousTheme = nativeTheme.themeSource;
        try {
          for (const theme of ['light', 'dark']) {
            nativeTheme.themeSource = theme;
            await waitFor(`matchMedia('(prefers-color-scheme: ${theme})').matches`, `diff uses ${theme} theme`);
            const style = await evaluate(`(() => {
              const added = document.querySelector('.changes .diff-line.add');
              const removed = document.querySelector('.changes .diff-line.remove');
              return { text: added.textContent, keyword: getComputedStyle(added.querySelector('.syntax-token.keyword')).color, plain: getComputedStyle(added.querySelector('code')).color, added: getComputedStyle(added).backgroundColor, removed: getComputedStyle(removed).backgroundColor };
            })()`);
            if (style.text !== '+export const answer = 43;' || style.keyword === style.plain || style.added === style.removed) throw new Error(`diff highlighting failed in ${theme}: ${JSON.stringify(style)}`);
            await evaluate("(() => { const diff = document.querySelector('.changes .diff'); diff.scrollTop = diff.scrollHeight; })()");
            await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            const rect = await evaluate("(() => { const r = document.querySelector('.inspector').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.floor(r.width), height: Math.floor(r.height) }; })()");
            writeFileSync(path.join(results, `diff-syntax-${theme}.png`), (await window.webContents.capturePage(rect)).toPNG());
          }
        } finally { nativeTheme.themeSource = previousTheme; }
        report.checks.push('inline and working diffs highlight file syntax in light and dark themes while preserving exact text and distinct edit backgrounds');
      }
      await evaluate("window.__joloSmoke.pickAnswerer(null)");
    }
    writeFileSync(path.join(results, "hosted-codex-acp.png"), (await window.webContents.capturePage()).toPNG());
    report.checks.push("Codex (app-server) and an ACP agent chosen in the composer each answered as a task, with their commands routed through Jolo's permission dialog");

    // Choosing which model each hosted agent runs, from the list that agent itself reports (§4.3).
    await evaluate("window.__joloSmoke.showSettings()");
    await waitFor("Boolean(document.querySelector('.settings-page'))", "settings opened for agent models", 10_000);
    await evaluate("document.querySelector('.settings-nav [data-section=agents]').click()");
    await waitFor("document.querySelectorAll('.agent-model-row').length >= 3", "settings offers a model for each hosted agent", 10_000);
    const rowFor = (agentId) => `[...document.querySelectorAll('.agent-model-row')].find((row) => row.querySelector('h2')?.textContent === ${JSON.stringify(agentId)})`;
    await waitFor(`${rowFor("Codex")}.querySelector('.agent-model-note')?.textContent.includes('2 models')`, "Codex models loaded automatically after reopening Settings", 20_000);
    await evaluate(`${rowFor("Codex")}.querySelector('.combobox button').click()`);
    await waitFor("Boolean(document.querySelector('.combobox-options'))", "model choices opened");
    const offered = await evaluate("[...document.querySelectorAll('.combobox-options [role=option]')].map(option => option.dataset.value)");
    if (!offered.includes("fake-large")) throw new Error(`the agent's own model list did not reach settings: ${JSON.stringify(offered)}`);
    const settingsTheme = nativeTheme.themeSource;
    try {
      for (const theme of ['light', 'dark']) {
        nativeTheme.themeSource = theme;
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        writeFileSync(path.join(results, `settings-model-options-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      }
    } finally { nativeTheme.themeSource = settingsTheme; }
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor("!document.querySelector('.combobox-options') && Boolean(document.querySelector('.settings-page'))", 'Escape closes the model list and keeps Settings open');
    await evaluate(`${rowFor("Codex")}.querySelector('input').focus()`);
    await window.webContents.insertText('fake-s');
    await waitFor("document.querySelectorAll('.combobox-options [role=option]').length === 1", 'model search filters the list');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await waitFor(`${rowFor("Codex")}.querySelector('input').value === 'fake-small' && !document.querySelector('.combobox-options')`, 'Enter selects the matching model');
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    writeFileSync(path.join(results, "agent-models.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate("[...document.querySelectorAll('.settings-savebar button')].find((button) => button.textContent === 'Save changes').click()");
    await waitFor("(window.__joloSmoke.hostedAgents().find((entry) => entry.id === 'codex') ?? {}).model === 'fake-small'", "the chosen model was saved and shows in the picker", 10_000);
    await evaluate("window.__joloSmoke.closeSettings()");
    report.checks.push("each hosted agent's model is chosen in settings from the list that agent itself reports, and the choice reaches the composer's picker");
    report.checks.push('model search, Enter selection, Escape dismissal, and saved choices work in the custom settings dropdown');

    await evaluate("window.__joloSmoke.closeTerminal()");
    await evaluate("window.__joloSmoke.newWorktreeTask('smoke/worktree')");
    await waitFor("window.__joloSmoke.state().workspaceMode === 'worktree' && window.__joloSmoke.state().branch === 'smoke/worktree'", "worktree task", 15_000);
    const runsBeforeWorktree = await evaluate("window.__joloSmoke.state().runCount");
    await evaluate("window.__joloSmoke.send('worktree task')");
    await waitFor(`window.__joloSmoke.state().runCount > ${runsBeforeWorktree} && ['completed','failed','paused'].includes(window.__joloSmoke.state().runState)`, "worktree run finished", 30_000);
    const projectRows = async () => (await bridge.rawCall("board.list", {})).projects.filter((row) => row.name === path.basename(project));
    const withWorktree = await projectRows();
    const worktreeRow = withWorktree.find((row) => row.workspace.mode === "worktree");
    if (withWorktree.length !== 2 || !worktreeRow || worktreeRow.git.branch !== "smoke/worktree" || !existsSync(worktreeRow.workspace.path) || worktreeRow.run?.state !== "completed") throw new Error(`worktree board rows: ${JSON.stringify(withWorktree.map((r) => [r.workspace, r.git, r.run?.state]))}`);
    await evaluate("window.__joloSmoke.showBoard()");
    await waitFor("document.querySelectorAll('.board-row').length >= 2 && document.querySelector('.worktree-tag')", "board shows the worktree row", 10_000);
    writeFileSync(path.join(results, "worktree.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate("window.__joloSmoke.showTask()");
    await evaluate("window.__joloSmoke.removeWorktree()");
    for (const deadline = Date.now() + 10_000; (await projectRows()).length !== 1;) { if (Date.now() > deadline) throw new Error("worktree row did not disappear"); await new Promise((r) => setTimeout(r, 100)); }
    if (existsSync(worktreeRow.workspace.path)) throw new Error("worktree directory still exists after removal");
    report.checks.push("a task ran in its own git worktree on a new branch, the board listed that checkout separately, and removal deleted the directory while keeping the branch");
  }
  {
    // Calling another agent into a task by name: the picker, then a turn that says who answered it (§4.3).
    // A fresh task, because the checkout the earlier one worked in has since been removed.
    await evaluate("window.__joloSmoke.showTask()");
    await evaluate("window.__joloSmoke.newTask()");
    await waitFor("window.__joloSmoke.state().runCount === 0", "a fresh task to call an agent into");
    await evaluate(`(() => { const input = document.querySelector('.composer textarea'); input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, "@co"); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor("Boolean(document.querySelector('.mention-list'))", "the mention picker opened");
    const offered = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.mention-list .mention-name')].map(node => node.textContent))`));
    if (!offered.includes("@codex")) throw new Error(`typing a name should offer the agents that match it: ${JSON.stringify(offered)}`);
    // Being in the document is not being on screen: the compose area clips what overflows it, so the list has
    // to be checked where the user would click it.
    const seen = JSON.parse(await evaluate(`(() => {
      const list = document.querySelector('.mention-list');
      const rect = list.getBoundingClientRect();
      const point = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + 12));
      return JSON.stringify({ onScreen: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth && rect.height > 0, hit: Boolean(point && list.contains(point)) });
    })()`));
    if (!seen.onScreen || !seen.hit) throw new Error(`the picker must be visible where the user would click it: ${JSON.stringify(seen)}`);
    await evaluate(`document.querySelector('.mention-list button').click()`);
    await waitFor(`document.querySelector('.composer textarea').value === "@codex "`, "picking a name completes it in the message");
    // A name in the middle of a message is ordinary text, so no picker.
    await evaluate(`(() => { const input = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, "ask @co"); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor("!document.querySelector('.mention-list')", "a name mid-sentence is just text");

    const runsBefore = await evaluate("window.__joloSmoke.state().runCount");
    await setDraft("@codex review what changed");
    await evaluate(`document.querySelector('.composer button[type=submit]').click()`);
    await waitFor(`window.__joloSmoke.state().runCount > ${runsBefore} && window.__joloSmoke.state().runState === 'completed'`, "the called-in agent answered", 30_000);
    // Completion and the artifact-backed transcript arrive on separate renderer updates.
    await waitFor("Boolean(document.querySelector('.message.assistant .message-label'))", 'the called-in reply rendered');
    const answered = JSON.parse(await evaluate(`JSON.stringify({ labels: [...document.querySelectorAll('.message.assistant .message-label')].map(node => node.textContent), user: [...document.querySelectorAll('.message.user')].map(node => node.innerText).at(-1), answerer: document.querySelector('.model-select')?.textContent })`));
    if (!answered.labels.at(-1)?.startsWith("Codex")) throw new Error(`the reply should name who was called in: ${JSON.stringify(answered.labels.slice(-2))}`);
    if (!answered.labels.at(-1)?.includes("called in for this message")) throw new Error(`the reply should say it was a one-off: ${JSON.stringify(answered.labels.at(-1))}`);
    if (!answered.user.includes("@codex review what changed")) throw new Error(`the transcript should keep what was typed: ${JSON.stringify(answered.user)}`);
    if (!/Jolo/.test(answered.answerer ?? "")) throw new Error(`the task should still be answered by Jolo afterwards: ${JSON.stringify(answered.answerer)}`);
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    writeFileSync(path.join(results, "mention.png"), (await window.webContents.capturePage()).toPNG());
    report.checks.push("typing @ offered the agents that can answer, and the message it named answered that one turn in the same conversation while the task stayed with Jolo");
  }
  {
    // A plan: two tasks written down, started on the user's word, carried out one at a time (§6.6).
    await evaluate("window.__joloSmoke.showPlans()");
    await waitFor("Boolean(document.querySelector('.plan-pane'))", "the plans panel opened");
    await evaluate(`document.querySelector('.plan-pane-head button').click()`);
    await waitFor("Boolean(document.querySelector('.plan-new'))", "the new-plan form opened");
    await evaluate(`(() => {
      const set = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value").set;
        setter.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set(document.querySelector('.plan-new input'), "tidy the notes");
      set(document.querySelector('.plan-new textarea'), ["look around: say what is here", "say it again: repeat the summary"].join(String.fromCharCode(10)));
    })()`);
    await waitFor(`document.querySelector('.plan-new .muted').textContent === "2 tasks"`, "both tasks were read from the form");
    await evaluate(`document.querySelector('.plan-new button.primary').click()`);
    await waitFor("document.querySelectorAll('.plan-task').length === 2", "the plan was written down");
    const written = await evaluate(`JSON.stringify({ marks: [...document.querySelectorAll('.plan-task .plan-mark')].map(node => node.textContent), state: document.querySelector('.plan-card')?.dataset.planState, start: document.querySelector('.plan-card header button.primary')?.textContent })`);
    const draft = JSON.parse(written);
    if (draft.state !== "draft" || draft.marks.join(",") !== "Waiting,Waiting" || draft.start !== "Start") throw new Error(`a written plan should wait to be started: ${written}`);

    // Bring the window forward first: news of a task belongs inside the app while the user is looking at it.
    try { window.show(); window.focus(); } catch { /* a window that cannot take focus falls back to the system */ }
    await evaluate(`document.querySelector('.plan-card header button.primary').click()`);
    await waitFor(`[...document.querySelectorAll('.plan-task .plan-mark')].filter(node => node.textContent === "Done").length === 2`, "both tasks finished", 25_000);
    const finished = await evaluate(`JSON.stringify({ state: document.querySelector('.plan-card').dataset.planState, count: document.querySelector('.plan-count').textContent, agents: [...document.querySelectorAll('.plan-task-agent')].map(node => node.textContent), opens: document.querySelectorAll('.plan-task-actions button').length })`);
    const after = JSON.parse(finished);
    if (after.state !== "done" || after.count !== "2 of 2") throw new Error(`the plan should read as finished: ${finished}`);
    {
      // Those tasks ran in sessions of their own while the pane showed something else, so the app said so.
      const notice = JSON.parse(await evaluate(`(() => {
        const first = document.querySelector('.notice');
        if (!first) return JSON.stringify({ count: 0 });
        const rect = first.getBoundingClientRect();
        const point = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
        return JSON.stringify({ count: document.querySelectorAll('.notice').length, titles: [...document.querySelectorAll('.notice-title')].map((node) => node.textContent), onScreen: rect.bottom <= innerHeight && rect.right <= innerWidth && rect.top >= 0, hit: Boolean(point && first.contains(point)) });
      })()`));
      if (!notice.count) throw new Error(`a task that finished off screen should leave a notice in the app; raised=${JSON.stringify(bridge.attention.notified.slice(-4))} focused=${window.isFocused()}`);
      if (!notice.onScreen || !notice.hit) throw new Error(`a notice must be visible where the user would click it: ${JSON.stringify(notice)}`);
      if (!notice.titles.some((title) => /: done$/.test(title))) throw new Error(`a finished task should be named among the notices: ${JSON.stringify(notice)}`);
      report.checks.push("a task finishing in a session the user was not watching left a notice in the app, on screen and clickable");
    }
    if (after.agents.join(",") !== "Jolo,Jolo") throw new Error(`each task should name who answered it: ${finished}`);
    if (after.opens < 2) throw new Error(`each finished task should open its own conversation: ${finished}`);
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    writeFileSync(path.join(results, "plan.png"), (await window.webContents.capturePage()).toPNG());
    report.checks.push("a plan of two tasks was written down, waited to be started, then ran one task at a time to completion with each task naming who answered it");
    await evaluate("window.__joloSmoke.showPlans()"); // leave the panel as the rest of the run found it
    await evaluate("window.__joloSmoke.showTask()");
    const { runQueueSmoke } = await import('./queue-smoke.mjs');
    await runQueueSmoke({ evaluate, waitFor, bridge, window, results });
    report.checks.push('Enter queues messages durably; Remove keeps the current turn running; double Enter interrupts and sends exactly once in the same chat');
  }
  const { runAttachmentsSmoke } = await import('./attachments-smoke.mjs');
  await runAttachmentsSmoke({ window, bridge, results, evaluate, waitFor, report });
  mkdirSync(results, { recursive: true });
  writeFileSync(path.join(results, "desktop.png"), (await window.webContents.capturePage()).toPNG());
  writeFileSync(path.join(results, "smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.JOLO_SMOKE_HOLD_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.JOLO_SMOKE_HOLD_MS))); // benchmark sampling window
  fixture.close();
}
