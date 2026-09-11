// Automated desktop smoke run: real engine, fake provider, scripted renderer, screenshot, exit code.
import electronPath from "electron";
import { mockProvider } from "../../../tests/fixtures/mock-providers.js";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dir, "..");
const splits = process.argv.includes("--splits");
const chats = process.argv.includes('--chats');
if (chats) process.env.JOLO_CHATS_SMOKE = '1';
if (process.argv.includes('--reload')) process.env.JOLO_RELOAD_SMOKE = '1';
if (process.argv.includes('--panels')) process.env.JOLO_PANELS_SMOKE = '1';
const liveResults = process.argv.includes("--live-results");
const tasks = process.argv.includes('--tasks');
const loading = process.argv.includes("--loading");
const visualization = process.argv.includes('--visualization');
if (visualization) process.env.JOLO_VISUALIZATION_SMOKE = '1';
const workspaceBoard = process.argv.includes('--board');
if (workspaceBoard) process.env.JOLO_BOARD_SMOKE = '1';
if (process.argv.includes('--models')) process.env.JOLO_MODELS_SMOKE = '1';
if (process.argv.includes('--history')) process.env.JOLO_HISTORY_SMOKE = '1';
const browserChat = process.argv.includes('--browser-chat');
const realBrowserAgent = process.argv.includes('--real-browser-agent') ? process.argv[process.argv.indexOf('--real-browser-agent') + 1] : null;
if (realBrowserAgent && !['codex', 'claude', 'grok'].includes(realBrowserAgent)) throw new Error('--real-browser-agent requires codex, claude, or grok');
if (realBrowserAgent) process.env.JOLO_REAL_BROWSER_AGENT = realBrowserAgent;
if (browserChat) process.env.JOLO_BROWSER_CHAT_SMOKE = '1';
if (process.argv.includes('--attachments')) process.env.JOLO_ATTACHMENTS_SMOKE = '1';
const home = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "jolo-desktop-smoke-"));
const project = path.join(home, "repo");
mkdirSync(path.join(project, "src"), { recursive: true });
writeFileSync(path.join(project, "src/app.js"), "export const answer = 42;\n");
const notes = "# Smoke notes\n\n- first item\n- second item\n";
writeFileSync(path.join(project, "NOTES.md"), notes);
const notesHash = `sha256:${new Bun.CryptoHasher("sha256").update(notes).digest("hex")}`;
// A repository with one commit, so the worktree flow has a base to start from.
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@example.com", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@example.com" };
for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-q", "-m", "smoke fixture"]]) Bun.spawnSync(["git", ...args], { cwd: project, env: gitEnv });
// A stand-in for a vendor CLI, so the check does not depend on which agents this machine has installed.
const agentsDir = path.join(home, "data", "default", "agents");
mkdirSync(agentsDir, { recursive: true });
const fixtureAgent = path.join(home, "fixture-agent.sh");
writeFileSync(fixtureAgent, "#!/bin/sh\nprintf 'fixture agent ready\\n'\nprintf 'Do you want to proceed? (y/n) '\nread answer\nprintf '\\nanswered %s\\n' \"$answer\"\nexit 0\n");
chmodSync(fixtureAgent, 0o755);
// Claude Code's structured transport, played by a fixture that speaks its host protocol; no API is reached.
const claudeLauncher = path.join(home, "fake-claude");
writeFileSync(claudeLauncher, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "..", "..", "tests", "fixtures", "fake-claude.js")}" "$@"\n`);
chmodSync(claudeLauncher, 0o755);
writeFileSync(path.join(agentsDir, "claude.json"), JSON.stringify({ id: "claude", displayName: "Claude Code", binary: claudeLauncher, transport: "claude-stream", modelArgs: ["--model", "{model}"], effortArgs: ["--effort", "{effort}"] }));
// Codex's app-server and an ACP agent, likewise played by fixtures.
const codexLauncher = path.join(home, "fake-codex");
writeFileSync(codexLauncher, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "..", "..", "tests", "fixtures", "fake-codex.js")}" "$@"\n`);
chmodSync(codexLauncher, 0o755);
writeFileSync(path.join(agentsDir, "codex.json"), JSON.stringify({ id: "codex", displayName: "Codex", binary: codexLauncher, transport: "codex-app-server" }));
const acpLauncher = path.join(home, "fake-acp");
writeFileSync(acpLauncher, `#!/bin/sh\nFAKE_ACP_STATE=${JSON.stringify(path.join(home, "acp-state"))} exec "${process.execPath}" "${path.join(root, "..", "..", "tests", "fixtures", "fake-acp.js")}" "$@"\n`);
chmodSync(acpLauncher, 0o755);
writeFileSync(path.join(agentsDir, "grok.json"), JSON.stringify({ id: "grok", displayName: "Grok CLI", binary: acpLauncher, args: ["--acp"], transport: "acp", modelArgs: ["-m", "{model}"], effortArgs: ["--reasoning-effort", "{effort}"] }));
writeFileSync(path.join(agentsDir, "fixture.json"), JSON.stringify({
  id: "fixture", displayName: "Fixture Agent", description: "smoke double", binary: fixtureAgent, statusModel: "screen", idleMs: 800,
  rules: [{ id: "asks", state: "needs_input", priority: 1000, region: "bottom", regionLines: 6, contains: "(y/n)" }],
}));
// Explicit opt-in: use the installed agent and its existing login against a disposable local page.
if (realBrowserAgent) {
  const binary = Bun.which(realBrowserAgent);
  if (!binary) throw new Error(`${realBrowserAgent} is not installed`);
  writeFileSync(path.join(agentsDir, `${realBrowserAgent}.json`), JSON.stringify({ id: realBrowserAgent, displayName: realBrowserAgent, binary,
    transport: realBrowserAgent === 'codex' ? 'codex-app-server' : realBrowserAgent === 'claude' ? 'claude-stream' : 'acp',
    ...(realBrowserAgent === 'grok' ? { args: ['--permission-mode', 'default', 'agent', 'stdio'] } : {}) }));
}

const modelFixture = mockProvider('openai-responses');
const providerDir = path.join(home, 'data', 'default', 'providers');
mkdirSync(providerDir, { recursive: true });
writeFileSync(path.join(providerDir, 'smoke-model.json'), JSON.stringify({ id: 'smoke-model', displayName: 'Smoke Model', protocol: 'openai-responses', baseUrl: modelFixture.baseUrl, auth: { kind: 'none' }, listing: 'openai', defaults: { contextWindowTokens: 64000, maxOutputTokens: 4096 } }));
const results = path.join(root, "smoke-results");
mkdirSync(results, { recursive: true });
const browserFixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response("<!doctype html><title>Jolo smoke page</title><h1>Inline browser is alive</h1><button onclick=\"this.textContent='Clicked'\">Click</button>", { headers: { 'content-type': 'text/html' } }) });
process.env.JOLO_SMOKE_BROWSER_URL = browserFixture.url.href;
const script = [
  { text: ["step 0\n", "done: smoke test prompt\n\n```md\n# Plan\n\n- **first** step\n```\n\n```mermaid\nflowchart LR\n  A[Read] --> B{Valid?}\n  B -->|yes| C[\"Save\\nto disk\"]\n  B -->|no| D[Reject]\n```\n\n```mermaid\nsequenceDiagram\n  participant U as User\n  participant J as Jolo\n  U->>J: run task\n  J-->>U: needs you\n  loop retry\n    U->>J: again\n  end\n```\n\n```python\n# GitHub search helper\nimport requests\n\nclass GitHubSearcher:\n    def search(self, query):\n        url = \"https://api.github.com\"\n        return requests.get(url, params={\"q\": query})\n```\n"] },
  { toolCalls: [{ name: 'browser_open', arguments: {} }] },
  { toolCalls: [{ name: 'browser_navigate', arguments: { url: browserFixture.url.href } }] },
  { toolCalls: [{ name: "browser_snapshot", arguments: {} }] },
  { toolCalls: [{ name: "browser_click", arguments: { ref: "e3" } }, { name: "browser_screenshot", arguments: {} }] },
  { toolCalls: [{ name: "browser_network", arguments: { maxEntries: 20 } }] },
  { text: ["Clicked the button.\n"] },
  { toolCalls: [{ name: "run_command", arguments: { argv: ["echo", "smoke-command-ok"] } }] },
  { text: ["Ran the command.\n"] },
  { toolCalls: [{ name: "replace_exact", arguments: { path: "NOTES.md", expectedHash: notesHash, oldText: "- second item", newText: "- second item\n- **third** item" } }] },
  { text: ["Notes updated.\n"] },
];
const visualizationPath = path.join(realpathSync(project), 'preview.html');
if (visualization) writeFileSync(visualizationPath, `<div style="padding:20px"><h2>Interactive preview</h2><p>Local visualization fixture.</p><button id="increment" onclick="document.querySelector('#count').textContent=String(++window.count)">Increment</button><output id="count">0</output></div><script>window.count=0;</script>`);
const visualizationReply = `Here is the preview.\n\nvisualize${JSON.stringify({path:visualizationPath,mode:'wide',title:'Interactive preview'})}\n\nAnd a missing file:\n\nvisualize${JSON.stringify({path:path.join(realpathSync(project),'missing-preview.html')})}`;
const scriptPath = path.join(home, "script.json");
writeFileSync(scriptPath, JSON.stringify(visualization ? [{ text: [visualizationReply] }] : workspaceBoard ? [{ text: Array.from({ length: 1000 }, () => 'Working on the folder.\n') }] : browserChat ? script.slice(1, 7) : liveResults ? [{ text: [...Array.from({ length: 60 }, (_, index) => `Paragraph ${index}: checking the live conversation and its final reply.\n\n`), 'LIVE_FINAL_REPLY\n'] }] : script));
const appIndex = process.argv.indexOf("--app");
if (appIndex !== -1 && !process.argv[appIndex + 1]) throw new Error("--app requires the packaged desktop executable path");
// Electron's types describe the API its own runtime exposes; required from Bun, the package exports the
// path to the Electron executable instead.
const command = appIndex === -1 ? [/** @type {string} */ (/** @type {unknown} */ (electronPath)), path.join(root, "src/main/index.js")] : [path.resolve(process.argv[appIndex + 1])];
let taskServer;
if(tasks) {
  const { testDatabase }=await import('../../access/test/database.js');
  const { createAccessApp }=await import('../../access/src/worker.js');
  const { createRepository }=await import('../../access/src/storage.js');
  const { cookie,hashToken,randomToken,SESSION_SECONDS }=await import('../../access/src/security.js');
  const { db,sqlite }=testDatabase(); let time=Date.now(),web;
  const fixtureStartedAt=Date.now();
  const now=()=>time+Date.now()-fixtureStartedAt;
  const auth=createRepository(db,now), sessionToken=randomToken(), csrf=randomToken();
  const account=await auth.account({id:'desktop-fixture',name:'Desktop fixture',email:'desktop@example.com'});
  await auth.saveSession(await hashToken(sessionToken),account.id,csrf,time+SESSION_SECONDS*1000);
  taskServer=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    if(new URL(request.url).pathname==='/__fixture/approve') {

      const response=await web.send('/device/approve',{method:'POST',headers:{origin:taskServer.url.origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,user_code:await request.text(),decision:'approved'})});
      time+=5000; return response;
    }
    return web.app.fetch(request);
  }});
  const app=createAccessApp({ACCESS_ORIGIN:taskServer.url.origin,ENVIRONMENT:'development',ACCESS_DB:db,GITHUB_CLIENT_ID:'fixture',GITHUB_CLIENT_SECRET:'fixture'},{now,fetch:()=>{throw new Error('No GitHub calls in smoke');}});
  web={app,send:(pathname,options)=>app.fetch(new Request(taskServer.url.origin+pathname,{...options,headers:{...options.headers,cookie:cookie('session',sessionToken,SESSION_SECONDS,false).split(';')[0]}}))};
  const { taskRepository }=await import('../../access/src/tasks/repository.js');
  await taskRepository(db,now).createTask(account.id,{title:'Repair task form',description:'TASK_DESKTOP_CONTEXT: preserve the draft.',project:'Jolo',state:'todo',priority:'normal',labels:[],requestID:crypto.randomUUID()});
  process.env.JOLO_ACCOUNT_ORIGIN=taskServer.url.origin;
  process.env.JOLO_CREDENTIALS='session';
}
const child = Bun.spawn(command, {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, JOLO_BUN: process.execPath, JOLO_HOME: home, JOLO_DESKTOP_SMOKE: "1", JOLO_TASKS_SMOKE: tasks ? "1" : "", JOLO_LOADING_SMOKE: loading ? "1" : "", JOLO_LIVE_RESULTS_SMOKE: liveResults ? "1" : "", JOLO_SPLIT_SMOKE: splits ? "1" : "", JOLO_SMOKE_PROJECT: project, JOLO_SMOKE_RESULTS: results, JOLO_IDLE_MS: "1500", JOLO_FAKE_STEPS: splits ? "600" : "3", JOLO_FAKE_DELAY_MS: splits ? "1" : "20", JOLO_FAKE_SCRIPT: splits || chats ? "" : scriptPath },
});
const code = await child.exited;
browserFixture.stop(true);
modelFixture.stop();
taskServer?.stop(true);
if (code === 0) console.log(readFileSync(path.join(results, "smoke.json"), "utf8"));
process.exit(code);
