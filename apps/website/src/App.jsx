import React, { useEffect, useState } from 'react';
import releases from '../../../deploy/cli-releases.json';

function Icon({ name, size = 20, ...props }) {
  const paths = {
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    diagonal: 'M6 18 18 6M6 6h12v12',
    terminal: 'm4 6 6 6-6 6m9 0h7',
    panels: 'M3 4h18v16H3ZM9 4v16',
    branch: 'M6 7v10m12-10a6 6 0 0 1-6 6H6',
    browser: 'M3 4h18v16H3Zm0 5h18M6 6.5h.01M9 6.5h.01',
    check: 'm5 12 4 4L19 6',
    plus: 'M12 5v14M5 12h14',
    file: 'M5 3h9l5 5v13H5Zm9 0v6h5',
    code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18',
    chevron: 'm8 10 4 4 4-4',
    copy: 'M8 8h12v12H8ZM4 16V4h12',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] || paths.code} /></svg>;
}

function Brand({ footer = false }) {
  return <a className={`brand${footer ? ' brand-footer' : ''}`} href="#top" aria-label="Jolo home"><span>jolo</span></a>;
}

function Workspace() {
  return <div className="workspace-example">
    <div className="app-bar"><div className="app-title"><span>Jolo</span></div><span className="app-project"><Icon name="branch" size={15} /> studio / refine-settings</span><span className="app-bar-end"><Icon name="panels" size={16} /><Icon name="browser" size={16} /></span></div>
    <div className="app-body">
      <aside className="app-sidebar" aria-label="Example tasks">
        <div className="example-new"><Icon name="plus" size={16} /> New task</div>
        <div className="sidebar-label">STUDIO <span>3</span></div>
        <div className="example-task selected"><span>Refine the settings page</span><small><Icon name="check" size={12} /> Ready for review</small></div>
        <div className="example-task"><span>Add keyboard shortcuts</span><small>Waiting for approval</small></div>
        <div className="example-task"><span>Explore the codebase</span><small>Completed</small></div>
        <div className="sidebar-bottom"><span className="project-letter">s</span><div>studio<small>Local workspace</small></div></div>
      </aside>
      <div className="app-conversation">
        <div className="conversation-heading"><span>Refine the settings page</span><Icon name="panels" size={15} /></div>
        <div className="conversation-content">
          <div className="user-message">Give the settings page a little more breathing room. Keep the existing components.</div>
          <div className="agent-heading"><span className="agent-mark">J</span><strong>Jolo</strong><span>Completed</span></div>
          <div className="activity"><Icon name="check" size={14} /> Explored · edited · verified</div>
          <p>The settings now have a clearer rhythm. I adjusted the spacing and kept the changes in the existing stylesheet.</p>
          <div className="review-line"><Icon name="file" size={16} /><span>1 file changed</span><span className="diff-count">+12 <span>−4</span></span></div>
          <div className="check-line"><Icon name="check" size={15} /><span>Layout checks passed</span></div>
        </div>
        <div className="example-composer"><span>Ask a follow-up…</span><div><span>Jolo <Icon name="chevron" size={12} /></span><span className="send-example"><Icon name="arrow" size={15} /></span></div></div>
        <div className="app-tools"><span><Icon name="check" size={14} /> Checks</span><span><Icon name="terminal" size={14} /> Terminal</span><span><Icon name="branch" size={14} /> Plans</span></div>
      </div>
      <aside className="app-changes" aria-label="Example change review"><div className="changes-heading">Changes <span>1</span></div><div className="diff-filename"><Icon name="file" size={14} /> settings.css</div><div className="diff-example"><div className="diff-neutral"><span>21</span><code>.settings-section {'{'}</code></div><div className="diff-removed"><span>22</span><code>− padding: 16px;</code></div><div className="diff-added"><span>22</span><code>+ padding: 24px;</code></div><div className="diff-added"><span>23</span><code>+ gap: 16px;</code></div><div className="diff-neutral"><span>24</span><code>{'}'}</code></div></div><div className="changes-note"><Icon name="check" size={15} /><p>Every edit has a diff.<br /><span>Review it in context.</span></p></div></aside>
    </div>
    <div className="app-status"><span><Icon name="branch" size={12} /> refine-settings</span><span>Ready for review</span></div>
  </div>;
}

function Terminal() {
  return <div className="terminal-example"><div className="terminal-bar"><Icon name="terminal" size={17} /><span>Jolo / Terminal</span><span>~/studio</span></div><div className="terminal-content"><p><span className="terminal-muted">~/studio</span> <span className="terminal-prompt">❯</span> jolo</p><p className="terminal-welcome">Jolo<span>Your workspace, from the command line.</span></p><p><span className="terminal-prompt">❯</span> Explain how this project is organized.</p><p className="terminal-muted">Read package.json · listed apps/ · searched packages/</p><p>The project has three main parts:</p><div className="terminal-tree"><div><span>apps/</span> <span>Application entry points</span></div><div><span>packages/</span> <span>Shared components and tools</span></div><div><span>tests/</span> <span>Checks for expected behavior</span></div></div><p className="terminal-muted">No files changed.</p><div className="terminal-input"><span>❯</span><span>Ask Jolo to build, fix, or explore…</span><span className="terminal-cursor" /></div><div className="terminal-hint">Enter to send <span>Esc to stop</span> <span>/sessions to pick up a task</span></div></div></div>;
}

function ProductPreview() {
  const [view, setView] = useState('terminal');
  function onKeyDown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'terminal' : event.key === 'End' ? 'desktop' : view === 'desktop' ? 'terminal' : 'desktop';
    setView(next);
    event.currentTarget.parentElement.querySelector(`#tab-${next}`).focus();
  }
  return <section className="product-preview section-width" id="workspace" aria-label="Explore the Jolo workspace"><div className="preview-toolbar"><span className="eyebrow">01 / workspace</span><div className="preview-tabs" role="tablist" aria-label="Product examples">{[['terminal', 'terminal', 'Terminal'], ['desktop', 'panels', 'Desktop']].map(([id, icon, label]) => <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={view === id} aria-controls={`panel-${id}`} tabIndex={view === id ? 0 : -1} onClick={() => setView(id)} onKeyDown={onKeyDown}><Icon name={icon} size={15} />{label}</button>)}</div></div><div className="preview-stage"><div id="panel-terminal" role="tabpanel" aria-labelledby="tab-terminal" tabIndex={0} hidden={view !== 'terminal'}><Terminal /></div><div id="panel-desktop" role="tabpanel" aria-labelledby="tab-desktop" tabIndex={0} hidden={view !== 'desktop'}><Workspace /></div></div><div className="preview-caption"><span>One engine. Two ways to work.</span><span>Illustrative examples</span></div></section>;
}

const features = [
  { number: '01', icon: 'panels', title: 'A space for each task.', text: 'Split the workspace into panes. Give a task its own Git worktree, branch, and files. Keep separate conversations in view.' },
  { number: '02', icon: 'browser', title: 'The browser, right here.', text: 'Open a page alongside the conversation. Your agent can navigate, interact, and capture what it sees.' },
  { number: '03', icon: 'code', title: 'Every change, in view.', text: 'Inspect inline diffs, check command results, and revert individual files. Follow the work as it happens.' },
];

function GettingStarted() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [version, setVersion] = useState(releases.latest);
  const automated = version !== releases.latest;
  useEffect(() => {
    const controller = new AbortController();
    fetch('/releases/latest.txt', { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const latest = (await response.text()).trim();
      if (!controller.signal.aborted && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(latest)) setVersion(latest);
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  const command = `curl -fsSL ${releases.origin}/install.sh | bash`;
  async function copyCommand() {
    try { await navigator.clipboard.writeText(command); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); setCopied(false); }
  }
  return <section className="getting-started section-width" id="get-jolo"><div><span className="eyebrow">04 / get jolo</span><h2>Start with<br />a prompt.</h2><p>{automated ? "The CLI is ready for macOS and Linux, on ARM64 and x64." : "The first CLI release is ready for macOS on Apple Silicon."}</p><p className="release-note">Early release · v{version}<br />{automated ? "Desktop downloads are still in development." : "Desktop and Linux downloads are still in development."}</p></div><div className="source-card"><div className="source-card-top"><Icon name="terminal" size={20} /><span>Install from your terminal.</span></div><p>Includes its own runtime. Installs to <code>~/.local</code> and verifies the download. No sudo needed.</p><div className="install-command"><pre><code>{command}</code></pre><button type="button" aria-label={copied ? 'Install command copied' : 'Copy install command'} onClick={copyCommand}><Icon name={copied ? 'check' : 'copy'} size={18} /></button></div><div className="source-card-bottom"><span>{automated ? "macOS · Linux · ARM64 · x64" : "macOS · Apple Silicon"}</span><span role="status" aria-live="polite">{copyError ? 'Select the command to copy.' : copied ? '[copied]' : 'Run in your terminal'}</span></div><div className="release-links"><a href="/install.sh">Read the script <Icon name="diagonal" size={13} /></a><a href={`/releases/${version}/jolo-cli-darwin-arm64.tar.gz`} download>{automated ? "macOS ARM64 archive" : "Download archive"} <Icon name="arrow" size={13} /></a><a href={`/releases/${version}/jolo-cli-darwin-arm64.tar.gz.sha256`}>SHA-256</a>{automated && <a href={`https://github.com/jolo-build/jolo/releases/tag/v${version}`}>All downloads <Icon name="arrow" size={13} /></a>}</div><p className="release-note">Follow the installer’s PATH instructions, then run <code>jolo</code> from your project. Run the installer again to upgrade.</p></div></section>;
}

export default function App() {
  return <>
    <a href="#main" className="skip-link">Skip to content</a>
    <div id="top" />
    <header className="site-header section-width"><Brand /><nav aria-label="Main navigation"><a href="#workspace"><span aria-hidden="true">/</span>workspace</a><a href="#workflow"><span aria-hidden="true">/</span>workflow</a><a className="nav-cta" href="#get-jolo">get jolo <Icon name="diagonal" size={16} /></a></nav></header>
    <main id="main">
      <section className="hero section-width"><div className="hero-title"><div className="hero-meta"><p className="eyebrow"><span className="prompt-symbol" aria-hidden="true">$</span> a workspace for coding agents</p><span className="development-label">[in development]</span></div><h1>Your agents.<br /><span>One workspace.</span><span className="text-cursor" aria-hidden="true" /></h1></div><div className="hero-description"><p>Coding agents, browser, and terminal. Together.<br className="hero-line-break" /> From the first prompt to the final diff.</p><div className="hero-actions"><a className="button button-dark" href="#workspace">Explore workspace <Icon name="arrow" size={18} /></a><span className="hero-platforms">macOS / Linux<span>desktop + terminal</span></span></div></div></section>
      <ProductPreview />
      <section className="workflow section-width" id="workflow"><div className="section-intro"><span className="eyebrow">02 / workflow</span><h2>Stay with the task.</h2><p>Keep the conversation, tools, and changes together.</p></div><div className="feature-grid">{features.map(feature => <article className="feature" key={feature.number}><div className="feature-heading"><span>{feature.number}</span><Icon name={feature.icon} size={22} /></div><h3>{feature.title}</h3><p>{feature.text}</p></article>)}</div></section>
      <section className="continuity section-width"><div className="continuity-copy"><span className="eyebrow">03 / continuity</span><h2>Know where<br />things stand.</h2><p>See what needs an answer, what’s running, and what finished while you were away.</p><p>Saved conversations and a note on where each task stopped help you pick up the thread.</p></div><div className="board-example" aria-label="Illustrative work board"><div className="board-title"><span>work board</span><span>3 projects</span></div><div className="board-row"><span className="board-initial">s</span><div><strong>studio</strong><span>Refine the settings page</span></div><span className="board-state state-review">review</span></div><div className="board-row"><span className="board-initial">a</span><div><strong>api</strong><span>Add request validation</span></div><span className="board-state state-waiting">needs you</span></div><div className="board-row"><span className="board-initial">d</span><div><strong>docs</strong><span>Update the setup guide</span></div><span className="board-state">running</span></div><div className="board-caption">Illustrative examples</div></div></section>
      <GettingStarted />
    </main>
    <footer className="site-footer section-width"><Brand footer /><p>your agents. your workspace.</p><a href="#top">back to top <Icon name="diagonal" size={15} /></a></footer>
  </>;
}
