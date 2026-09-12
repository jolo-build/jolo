import React, { useEffect, useId, useRef, useState } from 'react';
import releases from '../../../deploy/cli-releases.json';

function Icon({ name, size = 18, ...props }) {
  const paths = {
    arrow: 'M5 12h14m-6-6 6 6-6 6', close: 'm6 6 12 12M6 18 18 6', board: 'M5 5h5v14H5ZM14 5h5v14h-5Z', sidebarRight: 'M3 4h18v16H3ZM15 4v16', plans: 'm4 8 2 2 3-3M4 17l2 2 3-3M13 9h7M13 18h7', checks: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3', changes: 'M7 20V5m0 0-3 3m3-3 3 3M17 4v15m0 0 3-3m-3 3-3-3', diagonal: 'M6 18 18 6M6 6h12v12',
    terminal: 'm4 6 6 6-6 6m9 0h7', panels: 'M3 4h18v16H3ZM9 4v16',
    branch: 'M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9', browser: 'M3 4h18v16H3Zm0 5h18',
    check: 'm5 12 4 4L19 6', plus: 'M12 5v14M5 12h14', file: 'M5 3h9l5 5v13H5Zm9 0v6h5',
    code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18', chevron: 'm8 10 4 4 4-4',
    copy: 'M8 8h12v12H8ZM4 16V4h12', folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 1 1 19 0Z',
    compose: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M9 15l1-5L19 1l4 4-9 9Z',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] || paths.code} /></svg>;
}
function Brand({ footer = false }) { return <a className={`brand${footer ? ' brand-footer' : ''}`} href="#top" aria-label="Jolo home">jolo</a>; }
function NavigationLinks() {
  return <><a href="#workspace">Product</a><a href="#orchestrator">Orchestrator</a><a href="https://docs.jolo.build">Documentation</a><a href="https://access.jolo.build">Access <Icon name="diagonal" size={13} /></a><a className="nav-cta" href="#get-jolo">Get Jolo <Icon name="arrow" size={14} /></a></>;
}
function SiteHeader() {
  const mobileMenu = useRef(null);
  return <header className="site-header section-width"><Brand /><nav className="desktop-navigation" aria-label="Main navigation"><NavigationLinks /></nav><details className="mobile-navigation" ref={mobileMenu} onKeyDown={event => {
    if (event.key === 'Escape') { mobileMenu.current.open = false; mobileMenu.current.querySelector('summary').focus(); }
  }}><summary>Menu <Icon name="chevron" size={16} /></summary><nav aria-label="Mobile navigation" onClick={event => {
    if (event.target instanceof Element && event.target.closest('a')) mobileMenu.current.open = false;
  }}><NavigationLinks /></nav></details></header>;
}
const exampleTasks = ['Refine workspace navigation', 'Add comments to web tasks', 'Polish the settings page', 'Set up inline browser control'];
const exampleFolders = [['jolo', '7', '~/work/jolo', 'main'], ['orbis', '3', '~/work/orbis', 'fix/navigation'], ['studio', '2', '~/work/studio', 'main']];
const previewPanels = [['changes','Changes','changes'],['browser','Browser','browser'],['files','Files','file'],['terminal','Terminal','terminal'],['plans','Plans','plans'],['checks','Checks','checks']];
const taskDetails = [
  ['Codex · gpt-6-astra', 'refine-navigation', 'Worktree'],
  ['Claude Code · Opus', 'task-comments', 'Worktree'],
  ['Codex · gpt-6-astra', 'main', 'Local'],
  ['Claude Code · Opus', 'inline-browser', 'Worktree'],
];
function PreviewPanels({ selected, onSelect }) {
  const id = useId(), trigger = useRef(null), menu = useRef(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const element = menu.current;
    const changed = () => { const shown = element.matches(':popover-open'); setOpen(shown); if (shown) element.querySelector('button')?.focus(); };
    const close = () => element.hidePopover();
    element.addEventListener('toggle', changed); window.addEventListener('resize', close); window.addEventListener('scroll', close, true);
    return () => { element.removeEventListener('toggle', changed); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, []);
  const dismiss = () => { menu.current.hidePopover(); trigger.current.focus(); };
  return <><button type="button" ref={trigger} popoverTarget={id} aria-expanded={open} aria-haspopup="menu" className={selected ? 'is-active' : ''} onClick={() => {
    const rect = trigger.current.getBoundingClientRect(); menu.current.style.top = `${rect.bottom + 6}px`; menu.current.style.left = `${Math.max(8, Math.min(innerWidth - 220, rect.right - 212))}px`;
  }}><Icon name="sidebarRight" size={15} /> Panels <Icon name="chevron" size={12} /></button>
    <div id={id} ref={menu} popover="auto" className="preview-panel-menu" role="menu" aria-label="Example panels" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); dismiss(); return; }
      if (event.key === 'Tab') { menu.current.hidePopover(); return; }
      const items = [...event.currentTarget.querySelectorAll('button')], index = items.findIndex(item => item === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : -1;
      if (next >= 0) { event.preventDefault(); items[next].focus(); }
    }}>{previewPanels.map(([value,label,icon]) => <button type="button" key={value} role="menuitemradio" aria-checked={selected === value} onClick={() => { onSelect(value); dismiss(); }}><Icon name={icon} size={16} /><span>{label}</span>{selected === value && <Icon name="check" size={14} />}</button>)}{selected && <button type="button" role="menuitem" onClick={() => { onSelect(null); dismiss(); }}><Icon name="close" size={16} /> Hide panel</button>}</div></>;
}
function PreviewContext({ panel, onClose }) {
  return <aside className="app-context" aria-label={`Example ${panel}`}><header><span>{previewPanels.find(([id]) => id === panel)?.[1]}</span><button type="button" aria-label="Close example panel" onClick={onClose}><Icon name="close" size={15} /></button></header>
    {panel === 'changes' && <><div className="diff-filename"><Icon name="file" size={14} /> sidebar.css <small>+24 −8</small></div><div className="diff-example"><div><span>21</span><code>.task-row {'{'}</code></div><div className="diff-removed"><span>22</span><code>− padding: 16px;</code></div><div className="diff-added"><span>22</span><code>+ padding: 8px 10px;</code></div><div className="diff-added"><span>23</span><code>+ gap: 10px;</code></div><div><span>24</span><code>{'}'}</code></div></div></>}
    {panel === 'browser' && <><div className="preview-url">localhost:3000</div><div className="context-copy"><span className="app-wordmark">jolo</span><h3>Your work, in view.</h3><p>Preview the interface while your conversation stays beside it.</p></div></>}
    {panel === 'files' && <div className="context-copy preview-files">{['src','components','sidebar.jsx','sidebar.css'].map((name,i) => <div key={name}><Icon name={i < 2 ? 'folder' : 'file'} size={15} />{name}</div>)}</div>}
    {panel === 'terminal' && <div className="preview-shell"><p>~/work/jolo</p><p>$ bun test sidebar</p><p className="preview-pass">✓ Task rows stay aligned<br />✓ Latest agent is shown<br />✓ Worktree branch is preserved</p><p>3 passed · 0 failed</p><p>$ <span className="terminal-cursor" /></p></div>}
    {panel === 'plans' && <div className="context-copy"><h3>Refine navigation</h3><p>One task at a time.</p>{['Align the project rows','Show task context','Verify the sidebar'].map((title,i) => <div className="context-plan" key={title}>{i === 1 ? <span className="working-ring" /> : <Icon name={i === 0 ? 'check' : 'plans'} size={15} />}<span>{title}<small>{i === 0 ? 'Done · Codex' : i === 1 ? 'Working · Claude Code' : 'Pending · Codex'}</small></span></div>)}</div>}
    {panel === 'checks' && <div className="context-copy"><span className="preview-pass"><Icon name="checks" size={22} /> Checks passed</span><p>Sidebar tests<br />Type checking<br />Production build</p></div>}
  </aside>;
}
function Workspace() {
  const [screen, setScreen] = useState('chat'), [task, setTask] = useState(exampleTasks[0]), [panel, setPanel] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [openFolders, setOpenFolders] = useState(['jolo']);
  const openTask = title => { setTask(title); setScreen('chat'); setSidebarOpen(false); setPanel(null); };
  const toggleFolder = name => setOpenFolders(openFolders.includes(name) ? openFolders.filter(f => f !== name) : [...openFolders,name]);
  const tasksFor = name => name === 'jolo' ? exampleTasks : [name === 'orbis' ? 'Refine the project sidebar' : 'Explore the codebase'];
  const taskRow = (title,index) => <button type="button" className={`example-task ${task === title ? 'selected' : ''}`} key={title} onClick={() => openTask(title)} aria-current={task === title ? 'true' : undefined}>
    <span className="example-status" aria-label={title === exampleTasks[0] ? 'Working' : 'Done'}>{title === exampleTasks[0] ? <span className="working-ring" /> : <Icon name="check" size={14} />}</span><span className="example-task-copy"><span className="example-task-title">{title}</span><small>{taskDetails[index][0]}</small><small className="example-task-branch"><Icon name="branch" size={11} /><span>{taskDetails[index][1]}</span><span>{taskDetails[index][2]}</span></small></span>
  </button>;
  return <div className="workspace-example">
    <div className="app-bar"><div className="app-brand-area"><span className="app-wordmark">jolo</span><Icon name="panels" size={15} /><button className="mobile-preview-tasks" type="button" aria-expanded={sidebarOpen && screen === 'chat'} aria-label="Show example tasks" onClick={() => { setSidebarOpen(!sidebarOpen); setScreen('chat'); setPanel(null); }}><Icon name="panels" size={16} /> Tasks</button></div><Icon name="chat" size={14} /><span className="app-bar-title">{screen === 'board' ? 'Workspaces' : task}</span><div className="app-bar-end"><button type="button" onClick={() => { setScreen(screen === 'board' ? 'chat' : 'board'); setSidebarOpen(false); }} aria-pressed={screen === 'board'}><Icon name="board" size={14} /> Board</button><PreviewPanels selected={panel} onSelect={value => { setPanel(value); setScreen('chat'); setSidebarOpen(false); }} /></div></div>
    {screen === 'board' ? <div className="preview-board">
      <div className="preview-board-heading"><div><h3>Workspaces</h3><p><span className="activity-dot" /> 1 working <span>·</span> 1 new result</p></div><button className="preview-new-chat" type="button" onClick={() => openTask('New chat')}><Icon name="compose" size={15} /> New chat</button></div>
      <div className="preview-section-label"><span>Folders <span>3</span></span><span>Recent activity</span></div>
      {exampleFolders.map(([name,count,path,branch]) => <div className="preview-folder" key={name}>
        <button type="button" className="preview-folder-heading" aria-expanded={openFolders.includes(name)} onClick={() => toggleFolder(name)}><Icon name="chevron" size={14} className={openFolders.includes(name) ? '' : 'collapsed'} /><Icon name="folder" /><strong>{name}</strong><span>{count}</span><span className="preview-path">{path}</span><code><Icon name="branch" size={13} />{branch}</code></button>
        {openFolders.includes(name) && <div className="preview-folder-tasks">{tasksFor(name).map((title,index) => <button type="button" className={`preview-task ${name === 'jolo' && index === 0 ? 'is-working' : ''}`} key={title} onClick={() => openTask(title)}>{index === 0 && name === 'jolo' ? <span className="working-ring" /> : <Icon name="check" size={15} />}<span>{title}</span><small>{index === 0 && name === 'jolo' ? 'Working' : 'Done'}</small></button>)}{name === 'jolo' && <span className="preview-older">3 older tasks</span>}</div>}
      </div>)}
      <div className="preview-section-label preview-chats-label"><span>Chats</span><span>Outside workspaces</span></div><button className="preview-chat-row" type="button" onClick={() => openTask('Plan the next release')}><Icon name="chat" size={18} /><span>Plan the next release</span><small>Yesterday</small></button>
    </div> : <div className={`app-body ${panel ? 'has-panel' : ''} ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <aside className="app-sidebar" aria-label="Example tasks"><button className="example-new" type="button" onClick={() => openTask('New chat')}><Icon name="compose" size={16} /> New chat</button><div className="sidebar-label">Projects</div>
        {exampleFolders.map(([name]) => <div key={name}><button type="button" className="sidebar-folder" aria-expanded={openFolders.includes(name)} onClick={() => toggleFolder(name)}><Icon name={openFolders.includes(name) ? 'chevron' : 'folder'} size={16} /><span>{name}</span>{name === 'jolo' && <span className="activity-dot" />}</button>{openFolders.includes(name) && <div className="sidebar-task-tree">{tasksFor(name).slice(0,3).map(taskRow)}</div>}</div>)}
        <div className="sidebar-label">Chats</div><button className={`example-chat ${task === 'Plan the next release' ? 'selected' : ''}`} type="button" onClick={() => openTask('Plan the next release')}><Icon name="check" size={14} /><span>Plan the next release<small>Claude Code · Opus</small></span></button>
      </aside>
      <div className="app-conversation"><div className="conversation-heading"><Icon name="branch" size={13} /> refine-navigation <span>·</span> Worktree</div><div className="conversation-content"><div className="user-message">{task === 'New chat' || task === 'Plan the next release' ? 'Help me plan what to work on next.' : 'Make the workspace easier to navigate. Keep everything compact and consistent.'}</div><div className="agent-heading">Codex</div><p>I’m aligning the project and task rows. Each conversation will show its progress, latest model, and branch so you can pick up where you left off.</p><div className="activity"><span className="working-ring" /> Task activity <span>· 4 actions</span><span className="activity-rule" /></div><button type="button" className="review-line" onClick={() => setPanel('changes')}><Icon name="changes" size={15} /><span>Changes ready to inspect</span><span className="diff-count">+24 <span>−8</span></span></button></div><div className="example-composer"><span>Ask Codex to build, fix, or explore…</span><div><span><Icon name="plus" size={14} /> Codex <Icon name="chevron" size={12} /></span><span className="send-example"><Icon name="arrow" size={15} /></span></div></div></div>
      {panel && <PreviewContext panel={panel} onClose={() => setPanel(null)} />}
    </div>}
  </div>;
}
function ProductPreview() {
  const [view, setView] = useState('desktop');
  function onKeyDown(event) {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'desktop' : event.key === 'End' ? 'terminal' : view === 'desktop' ? 'terminal' : 'desktop';
    setView(next); event.currentTarget.parentElement.querySelector(`#tab-${next}`).focus();
  }
  return <section className="product-preview section-width" id="workspace" aria-label="Explore the Jolo workspace"><div className="preview-toolbar"><span>A little more room to focus.</span><div className="preview-tabs" role="tablist" aria-label="Product examples">{[['desktop','panels','Desktop'],['terminal','terminal','Terminal']].map(([id,icon,label]) => <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={view === id} aria-controls={`panel-${id}`} tabIndex={view === id ? 0 : -1} onClick={() => setView(id)} onKeyDown={onKeyDown}><Icon name={icon} size={15} />{label}</button>)}</div></div><div className="preview-stage"><div id="panel-desktop" role="tabpanel" aria-labelledby="tab-desktop" tabIndex={0} hidden={view !== 'desktop'}><Workspace /></div><div id="panel-terminal" role="tabpanel" aria-labelledby="tab-terminal" tabIndex={0} hidden={view !== 'terminal'}><Terminal /></div></div><div className="preview-caption"><span>Explore the sidebar or open a panel.</span><span>Interactive example · no real tasks</span></div></section>;
}
function Terminal() {
  return <div className="terminal-example"><div className="terminal-bar"><Icon name="terminal" size={17} /><span>Jolo / Terminal</span><span>~/studio</span></div><div className="terminal-content"><p><span className="terminal-muted">~/studio</span> <span className="terminal-prompt">❯</span> jolo</p><p className="terminal-welcome">Jolo<span>Your workspace, from the command line.</span></p><p><span className="terminal-prompt">❯</span> Explain how this project is organized.</p><p className="terminal-muted">Read package.json · listed apps/ · searched packages/</p><p>The project has three main parts:</p><div className="terminal-tree"><div><span>apps/</span> <span>Application entry points</span></div><div><span>packages/</span> <span>Shared components and tools</span></div><div><span>tests/</span> <span>Checks for expected behavior</span></div></div><p className="terminal-muted">No files changed.</p><div className="terminal-input"><span>❯</span><span>Ask Jolo to build, fix, or explore…</span><span className="terminal-cursor" /></div><div className="terminal-hint">Enter to send <span>Esc to stop</span> <span>/sessions to pick up a task</span></div></div></div>;
}

const planExamples = [
  { title: 'Build a feature', goal: 'Add saved searches to the dashboard.', steps: [['Implement saved searches', 'Codex', 'Done'], ['Review the changes', 'Claude Code', 'Working'], ['Run the regression checks', 'Codex', 'Pending']] },
  { title: 'Fix a bug', goal: 'Find and fix a sign-in redirect loop.', steps: [['Reproduce the redirect loop', 'Claude Code', 'Done'], ['Fix the callback handling', 'Codex', 'Working'], ['Check the sign-in flow', 'Claude Code', 'Pending']] },
  { title: 'Prepare a release', goal: 'Get the next desktop release ready.', steps: [['Review the release changes', 'Claude Code', 'Done'], ['Run packaging checks', 'Codex', 'Working'], ['Draft the release notes', 'Claude Code', 'Pending']] },
];
function OrchestratorExamples() {
  const [selected, setSelected] = useState(0);
  const example = planExamples[selected];
  return <section className="orchestrator section-width" id="orchestrator" aria-labelledby="orchestrator-title">
    <div className="section-intro"><span className="eyebrow">Built-in orchestrator</span><h2 id="orchestrator-title">Different agents. One plan.</h2><p>Break work into ordered tasks and choose the agent for each step. Jolo runs them one at a time in the same workspace, so the next task starts with the files left by the previous one.</p></div>
    <div className="orchestrator-example">
      <div className="plan-examples" role="group" aria-label="Orchestrator examples">{planExamples.map((item, index) => <button type="button" key={item.title} aria-pressed={selected === index} onClick={() => setSelected(index)}>{item.title}</button>)}</div>
      <div className="example-plan" aria-live="polite"><div className="example-plan-heading"><Icon name="branch" /><div><small>Example plan</small><h3>{example.goal}</h3></div><span className="plan-progress">1 of 3 done</span></div><ol>{example.steps.map(([title, agent, status], index) => <li key={`${selected}-${title}`} className={status === 'Working' ? 'plan-step-active' : ''}><span className="plan-step-number">{status === 'Done' ? <Icon name="check" size={15} /> : index + 1}</span><div><strong>{title}</strong><small>{agent}</small></div><span className="plan-step-state">{status === 'Working' && <span className="working-ring" />}{status}</span></li>)}</ol></div>
      <p className="example-disclaimer">Illustrative plans · select an example to explore</p>
    </div>
    <div className="orchestrator-details"><p><strong>You set the direction.</strong> Review the tasks, assign agents, and start the plan when you’re ready.</p><p><strong>You stay in control.</strong> Plans pause for approvals. Retry a stopped task or assign a different agent.</p></div>
  </section>;
}
function DesktopExamples() {
  return <section className="desktop-examples section-width" aria-labelledby="desktop-examples-title"><div className="section-intro"><span className="eyebrow">Jolo Desktop in practice</span><h2 id="desktop-examples-title">Start with a real task.</h2><p>Open a folder, start a conversation, and keep the work in view.</p></div><div className="desktop-example-grid">{[
    ['compose', 'Build a feature', 'Add a saved-search filter to this dashboard. Follow the existing components and add tests.', 'Follow the conversation, inspect changed files, and ask for the next revision.'],
    ['browser', 'Check the browser flow', 'Open the app in the inline browser and check the sign-in form at desktop and mobile sizes.', 'Keep the browser beside your chat while the agent navigates and checks the page.'],
    ['code', 'Review a change', 'Review my uncommitted changes. Explain any bugs and suggest focused fixes.', 'Read the review alongside the diff, then continue in the same task.'],
  ].map(([icon, title, prompt, detail]) => <article className="desktop-example-card" key={title}><Icon name={icon} size={20} /><h3>{title}</h3><blockquote>{prompt}</blockquote><p>{detail}</p></article>)}</div></section>;
}

function GettingStarted() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [version, setVersion] = useState(releases.latest);
  const automated = version !== releases.latest;
  const [desktop, setDesktop] = useState(null);
  const [desktopError, setDesktopError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let refreshing = false;
    async function refresh() {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      /** @type {RequestInit} */
      const options = { signal: controller.signal, cache: 'no-store' };
      await Promise.allSettled([
        fetch('/releases/latest.txt', options).then(async response => {
          if (!response.ok) return;
          const latest = (await response.text()).trim();
          if (!controller.signal.aborted && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(latest)) setVersion(latest);
        }),
        fetch('/releases/desktop.json', options).then(async response => {
          if (!response.ok) throw new Error('Downloads unavailable');
          const release = await response.json();
          if (!Array.isArray(release.downloads)) throw new Error('Invalid desktop release');
          if (!controller.signal.aborted) { setDesktop(release); setDesktopError(false); }
        }).catch(() => { if (!controller.signal.aborted) setDesktopError(true); }),
      ]);
      refreshing = false;
    }
    void refresh();
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const command = `curl -fsSL ${releases.origin}/install.sh | bash`;
  async function copyCommand() {
    try { await navigator.clipboard.writeText(command); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); setCopied(false); }
  }
  return <section className="getting-started section-width" id="get-jolo">
    <header className="install-heading"><div><span className="eyebrow">Get Jolo</span><h2>At home on your desktop. Or in your terminal.</h2></div><p>Desktop or terminal.<br />Install each separately.</p></header>
    <div className="source-card desktop-install">
      <div className="source-card-top"><Icon name="panels" size={20} /><h3>Jolo Desktop</h3><span className="install-format">.dmg</span></div>
      <p>Your chats, browser, and changes in one app. Open the disk image and drag Jolo into Applications.</p>
      <div className="desktop-downloads">
        {desktop?.downloads?.length ? desktop.downloads.map(download => <a className="desktop-download" key={download.arch} href={download.url}><span>Download for {download.arch === 'arm64' ? 'Apple Silicon' : 'Intel Mac'}</span><Icon name="arrow" size={16} /></a>)
          : <p role="status" className="desktop-availability">{desktopError ? 'Desktop downloads are temporarily unavailable.' : desktop === null ? 'Checking desktop downloads…' : 'The first desktop DMG release is coming soon.'}</p>}
      </div>
      <div className="source-card-bottom"><span>macOS · Apple Silicon · Intel</span>{desktop?.version && <span>v{desktop.version}</span>}</div>
      {desktop?.downloads?.length > 0 && <div className="release-links">{desktop.downloads.map(download => <a key={download.arch} href={download.checksum}>{download.arch === 'arm64' ? 'Apple Silicon' : 'Intel'} SHA-256</a>)}</div>}
    </div>
    <div className="source-card cli-install">
      <div className="source-card-top"><Icon name="terminal" size={20} /><h3>Jolo CLI</h3><span className="install-format">bash</span></div>
      <p>Install the CLI in your terminal. Includes its own runtime, verifies the download, and installs to <code>~/.local</code>.</p>
      <div className="install-command"><pre><code>{command}</code></pre><button type="button" aria-label={copied ? 'Install command copied' : 'Copy install command'} onClick={copyCommand}><Icon name={copied ? 'check' : 'copy'} size={18} /></button></div>
      <div className="source-card-bottom"><span>{automated ? 'macOS · Linux · ARM64 · x64' : 'macOS · Apple Silicon'}</span><span role="status" aria-live="polite">{copyError ? 'Select the command to copy.' : copied ? '[copied]' : 'No sudo needed'}</span></div>
      <div className="release-links"><a href="/install.sh">Read the script <Icon name="diagonal" size={13} /></a><a href={`/releases/${version}/jolo-cli-darwin-arm64.tar.gz`}>CLI archive <Icon name="arrow" size={13} /></a><a href={`/releases/${version}/jolo-cli-darwin-arm64.tar.gz.sha256`}>SHA-256</a>{automated && <a href={`https://github.com/jolo-build/jolo/releases/tag/v${version}`}>All CLI downloads <Icon name="arrow" size={13} /></a>}</div>
      <p className="release-note">v{version} · Follow the installer’s PATH instructions, then run <code>jolo</code> from your project.</p>
    </div>
  </section>;
}

export default function App() {
  return <><a href="#main" className="skip-link">Skip to content</a><div id="top" />
    <SiteHeader />
    <main id="main"><section className="hero section-width"><div className="hero-meta"><span className="activity-dot" /><span>Your workspace for coding agents</span><span className="development-label">In development</span></div><h1><span className="hero-title-line">Your agents.</span><span className="hero-title-line">One workspace.</span></h1><p className="hero-description">Conversations, code, and the browser. Together.<br />Stay with the task, from the first prompt to the final diff.</p><div className="hero-actions"><a className="button button-dark" href="#get-jolo">Get Jolo <Icon name="arrow" size={16} /></a><a className="button button-outline" href="https://access.jolo.build">Open Access <Icon name="diagonal" size={15} /></a></div><p className="hero-note">On your desktop. In your terminal. Connected through Access.</p></section>
    <ProductPreview />
    <DesktopExamples />
    <OrchestratorExamples />
    <section className="workflow section-width" id="workflow"><div className="section-intro"><span className="eyebrow">Made for the way you work</span><h2>Less switching. More doing.</h2><p>Everything you need stays close to the conversation.</p></div><div className="feature-grid">{[
      ['folder','A place for every task','Keep folders, tasks, and standalone chats organized. Open two conversations side by side when you need them.'],
      ['browser','A browser beside your code','Let your agent navigate, interact, and check its work in the inline browser. Stay in the same workspace.'],
      ['code','Changes you can follow','See edits, check results, and review the diff in context. Pick up the conversation with your next instruction.']
    ].map(([icon,title,text]) => <article className="feature" key={title}><span className="feature-icon"><Icon name={icon} size={21} /></span><h3>{title}</h3><p>{text}</p></article>)}</div></section>
    <section className="continuity section-width"><div className="continuity-copy"><span className="eyebrow">Jolo Access</span><h2>Keep your work<br />connected.</h2><p>A shared place for tasks, teams, and updates. Connect your desktop or CLI and carry the details with you.</p><a className="text-link" href="https://access.jolo.build">Open Access <Icon name="arrow" size={16} /></a></div><div className="board-example" aria-label="Illustrative Access task list"><div className="board-title"><strong>Tasks</strong><span>Personal workspace</span></div>{[['JOLO-3','Refine workspace navigation','In progress'],['JOLO-2','Add comments to web tasks','Done'],['JOLO-1','Plan the next release','Todo']].map(([id,title,status]) => <div className="board-row" key={id}><span className={status === 'In progress' ? 'working-ring' : 'done-ring'}>{status === 'Done' && <Icon name="check" size={11} />}</span><div><small>{id}</small><strong>{title}</strong></div><span className={`board-state ${status === 'In progress' ? 'state-working' : ''}`}>{status}</span></div>)}<div className="board-caption">Illustrative example</div></div></section>
    <GettingStarted /></main><footer className="site-footer section-width"><Brand footer /><p>Your agents. Your workspace.</p><a href="https://docs.jolo.build">Documentation <Icon name="diagonal" size={13} /></a><a href="https://github.com/jolo-build/jolo">GitHub <Icon name="diagonal" size={13} /></a><a href="#top">Back to top <Icon name="arrow" size={13} /></a></footer></>;
}
