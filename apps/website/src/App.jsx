import React, { useEffect, useState } from 'react';
import releases from '../../../deploy/cli-releases.json';

function Icon({ name, size = 18, ...props }) {
  const paths = {
    arrow: 'M5 12h14m-6-6 6 6-6 6', diagonal: 'M6 18 18 6M6 6h12v12',
    terminal: 'm4 6 6 6-6 6m9 0h7', panels: 'M3 4h18v16H3ZM9 4v16',
    branch: 'M6 7v10m12-10a6 6 0 0 1-6 6H6', browser: 'M3 4h18v16H3Zm0 5h18',
    check: 'm5 12 4 4L19 6', plus: 'M12 5v14M5 12h14', file: 'M5 3h9l5 5v13H5Zm9 0v6h5',
    code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18', chevron: 'm8 10 4 4 4-4',
    copy: 'M8 8h12v12H8ZM4 16V4h12', folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 1 1 19 0Z',
    compose: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M9 15l1-5L19 1l4 4-9 9Z',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] || paths.code} /></svg>;
}
function Brand({ footer = false }) { return <a className={`brand${footer ? ' brand-footer' : ''}`} href="#top" aria-label="Jolo home">jolo</a>; }
const exampleTasks = ['Refine workspace navigation', 'Add comments to web tasks', 'Polish the settings page', 'Set up inline browser control'];
const exampleFolders = [['jolo', '7', '~/work/jolo', 'main'], ['orbis', '3', '~/work/orbis', 'fix/navigation'], ['studio', '2', '~/work/studio', 'main']];
function Workspace() {
  const [screen, setScreen] = useState('board');
  const [task, setTask] = useState(exampleTasks[0]);
  const [openFolders, setOpenFolders] = useState(['jolo']);
  const openTask = title => { setTask(title); setScreen('chat'); };
  return <div className="workspace-example">
    <div className="app-bar"><span className="app-wordmark">jolo</span><span className="app-breadcrumb">/</span><span>{screen === 'board' ? 'Workspaces' : task}</span><div className="app-bar-end"><button type="button" onClick={() => setScreen('board')} aria-pressed={screen === 'board'}><Icon name="panels" size={14} /> Board</button><span className="example-avatar">E</span></div></div>
    {screen === 'board' ? <div className="preview-board">
      <div className="preview-board-heading"><div><h3>Workspaces</h3><p><span className="activity-dot" /> 1 working <span>·</span> 1 new result</p></div><button className="preview-new-chat" type="button" onClick={() => openTask('New chat')}><Icon name="compose" size={15} /> New chat</button></div>
      <div className="preview-section-label"><span>Folders <span>3</span></span><span>Recent activity</span></div>
      {exampleFolders.map(([name,count,path,branch]) => <div className="preview-folder" key={name}>
        <button type="button" className="preview-folder-heading" aria-expanded={openFolders.includes(name)} onClick={() => setOpenFolders(openFolders.includes(name) ? openFolders.filter(f => f !== name) : [...openFolders,name])}><Icon name="chevron" size={14} className={openFolders.includes(name) ? '' : 'collapsed'} /><Icon name="folder" className={name === 'jolo' ? 'working-folder' : ''} /><strong>{name}</strong><span>{count}</span><span className="preview-path">{path}</span><code><Icon name="branch" size={13} />{branch}</code></button>
        {openFolders.includes(name) && <div className="preview-folder-tasks">{(name === 'jolo' ? exampleTasks : [name === 'orbis' ? 'Refine the project sidebar' : 'Explore the codebase']).map((title,index) => <button type="button" className={`preview-task ${name === 'jolo' && index === 0 ? 'is-working' : ''}`} key={title} onClick={() => openTask(title)}>{index === 0 && name === 'jolo' ? <span className="working-ring" /> : <span className="done-ring"><Icon name="check" size={11} /></span>}<span>{title}</span><small>{index === 0 && name === 'jolo' ? 'Working' : index === 1 ? '14h' : 'Yesterday'}</small></button>)}{name === 'jolo' && <span className="preview-older">3 older tasks</span>}</div>}
      </div>)}
      <div className="preview-section-label preview-chats-label"><span>Chats</span><span>Outside workspaces</span></div><button className="preview-chat-row" type="button" onClick={() => openTask('Plan the next release')}><Icon name="chat" size={18} /><span>Plan the next release</span><small>Yesterday</small></button>
    </div> : <div className="app-body">
      <aside className="app-sidebar" aria-label="Example tasks"><button className="example-new" type="button" onClick={() => openTask('New chat')}><Icon name="compose" size={16} /> New chat</button><div className="sidebar-label">Workspaces <span>3</span></div><div className="sidebar-folder"><Icon name="chevron" size={12} /><Icon name="folder" size={16} /><strong>jolo</strong><span>7</span></div><div className="sidebar-task-tree">{exampleTasks.slice(0,3).map(title => <button type="button" className={`example-task ${task === title ? 'selected' : ''}`} key={title} onClick={() => openTask(title)}>{title}<small>{title === exampleTasks[0] ? 'Working' : 'Done'} · Codex</small></button>)}</div>{exampleFolders.slice(1).map(([name,count]) => <div className="sidebar-folder" key={name}><Icon name="chevron" size={12} className="collapsed" /><Icon name="folder" size={16} /><strong>{name}</strong><span>{count}</span></div>)}<div className="sidebar-label">Recents</div><button className="example-task" type="button" onClick={() => openTask('Plan the next release')}>Plan the next release</button></aside>
      <div className="app-conversation"><div className="conversation-heading"><span className="activity-dot" />Working <span>·</span> Codex</div><div className="conversation-content"><div className="user-message">{task === 'New chat' ? 'Help me plan what to work on next.' : 'Make the workspace easier to navigate. Keep everything compact and consistent.'}</div><div className="agent-heading"><span className="agent-mark">jolo</span></div><p>I’m refining the folder list and task rows, with a clearer view of what’s working and what’s ready.</p><div className="activity"><span className="working-ring" /> Working <span>· 4 actions</span><span className="activity-rule" /></div><div className="review-line"><Icon name="file" size={15} /><span>Changes ready to inspect</span><span className="diff-count">+24 <span>−8</span></span></div></div><div className="example-composer"><span>Ask a follow-up…</span><div><span>Codex <Icon name="chevron" size={12} /></span><span className="send-example"><Icon name="arrow" size={15} /></span></div></div></div>
      <aside className="app-changes" aria-label="Example change review"><div className="changes-heading">Changes <span>1</span></div><div className="diff-filename"><Icon name="file" size={14} /> workspace.css</div><div className="diff-example"><div className="diff-neutral"><span>21</span><code>.workspace-row {'{'}</code></div><div className="diff-removed"><span>22</span><code>− padding: 16px;</code></div><div className="diff-added"><span>22</span><code>+ padding: 10px;</code></div><div className="diff-added"><span>23</span><code>+ gap: 8px;</code></div><div className="diff-neutral"><span>24</span><code>{'}'}</code></div></div></aside>
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
  return <section className="product-preview section-width" id="workspace" aria-label="Explore the Jolo workspace"><div className="preview-toolbar"><span>A little more room to focus.</span><div className="preview-tabs" role="tablist" aria-label="Product examples">{[['desktop','panels','Desktop'],['terminal','terminal','Terminal']].map(([id,icon,label]) => <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={view === id} aria-controls={`panel-${id}`} tabIndex={view === id ? 0 : -1} onClick={() => setView(id)} onKeyDown={onKeyDown}><Icon name={icon} size={15} />{label}</button>)}</div></div><div className="preview-stage"><div id="panel-desktop" role="tabpanel" aria-labelledby="tab-desktop" tabIndex={0} hidden={view !== 'desktop'}><Workspace /></div><div id="panel-terminal" role="tabpanel" aria-labelledby="tab-terminal" tabIndex={0} hidden={view !== 'terminal'}><Terminal /></div></div><div className="preview-caption"><span>Explore a folder or open a task.</span><span>Interactive example · no real tasks</span></div></section>;
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
    fetch('/releases/latest.txt', { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const latest = (await response.text()).trim();
      if (!controller.signal.aborted && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(latest)) setVersion(latest);
    }).catch(() => {});
    fetch('/releases/desktop.json', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Downloads unavailable');
      const release = await response.json();
      if (!Array.isArray(release.downloads)) throw new Error('Invalid desktop release');
      if (!controller.signal.aborted) setDesktop(release);
    }).catch(() => { if (!controller.signal.aborted) setDesktopError(true); });
    return () => controller.abort();
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
    <header className="site-header section-width"><Brand /><nav aria-label="Main navigation"><a href="#workspace">Product</a><a href="#orchestrator">Orchestrator</a><a href="https://access.jolo.build">Access <Icon name="diagonal" size={13} /></a><a className="nav-cta" href="#get-jolo">Get Jolo <Icon name="arrow" size={14} /></a></nav></header>
    <main id="main"><section className="hero section-width"><div className="hero-meta"><span className="activity-dot" /><span>Your workspace for coding agents</span><span className="development-label">In development</span></div><h1>Your agents.<br /><span>One workspace.</span></h1><p className="hero-description">Conversations, code, and the browser. Together.<br />Stay with the task, from the first prompt to the final diff.</p><div className="hero-actions"><a className="button button-dark" href="#get-jolo">Get Jolo <Icon name="arrow" size={16} /></a><a className="button button-outline" href="https://access.jolo.build">Open Access <Icon name="diagonal" size={15} /></a></div><p className="hero-note">On your desktop. In your terminal. Connected through Access.</p></section>
    <ProductPreview />
    <DesktopExamples />
    <OrchestratorExamples />
    <section className="workflow section-width" id="workflow"><div className="section-intro"><span className="eyebrow">Made for the way you work</span><h2>Less switching. More doing.</h2><p>Everything you need stays close to the conversation.</p></div><div className="feature-grid">{[
      ['folder','A place for every task','Keep folders, tasks, and standalone chats organized. Open two conversations side by side when you need them.'],
      ['browser','A browser beside your code','Let your agent navigate, interact, and check its work in the inline browser. Stay in the same workspace.'],
      ['code','Changes you can follow','See edits, check results, and review the diff in context. Pick up the conversation with your next instruction.']
    ].map(([icon,title,text]) => <article className="feature" key={title}><span className="feature-icon"><Icon name={icon} size={21} /></span><h3>{title}</h3><p>{text}</p></article>)}</div></section>
    <section className="continuity section-width"><div className="continuity-copy"><span className="eyebrow">Jolo Access</span><h2>Keep your work<br />connected.</h2><p>A shared place for tasks, teams, and updates. Connect your desktop or CLI and carry the details with you.</p><a className="text-link" href="https://access.jolo.build">Open Access <Icon name="arrow" size={16} /></a></div><div className="board-example" aria-label="Illustrative Access task list"><div className="board-title"><strong>Tasks</strong><span>Personal workspace</span></div>{[['JOLO-24','Refine workspace navigation','In progress'],['JOLO-23','Add comments to web tasks','Done'],['JOLO-22','Plan the next release','Todo']].map(([id,title,status]) => <div className="board-row" key={id}><span className={status === 'In progress' ? 'working-ring' : 'done-ring'}>{status === 'Done' && <Icon name="check" size={11} />}</span><div><small>{id}</small><strong>{title}</strong></div><span className={`board-state ${status === 'In progress' ? 'state-working' : ''}`}>{status}</span></div>)}<div className="board-caption">Illustrative example</div></div></section>
    <GettingStarted /></main><footer className="site-footer section-width"><Brand footer /><p>Your agents. Your workspace.</p><a href="https://github.com/jolo-build/jolo">GitHub <Icon name="diagonal" size={13} /></a><a href="#top">Back to top <Icon name="arrow" size={13} /></a></footer></>;
}
