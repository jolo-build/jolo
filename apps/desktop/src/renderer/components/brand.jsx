import { Icon } from './icon.jsx';
/** Original Jolo artwork used in conversations. */
export function JoloMark({ className = "" }) {
  return <span className={`jolo-mark ${className}`} aria-hidden="true" />;
}

export function JoloLogo({ className = "" }) {
  return <span className={`jolo-wordmark ${className}`} role="img" aria-label="Jolo">jolo</span>;
}

// Brand artwork from Lobe Icons; bundled with its MIT license in assets/brand/agents.
const agentLogos = { claude: 'claude-color', codex: 'openai', grok: 'grok', gemini: 'gemini-color' };
export function AgentLogo({ agentId }) {
  const logo = agentLogos[agentId];
  if (!logo) return <span className="agent-logo-fallback" aria-hidden="true">{agentId.slice(0, 1).toUpperCase()}</span>;
  return logo.endsWith('-color')
    ? <img className="agent-logo" src={`./agents/${logo}.svg`} alt="" />
    : <span className="agent-logo agent-logo-mono" aria-hidden="true" style={{ maskImage: `url(./agents/${logo}.svg)` }} />;
}

export function ModelLogo({ model, agentId, preset }) {
  const name = String(model ?? '').split('/').at(-1).toLowerCase();
  const modelBrand = /^(gpt|o[134])(?:[- .]|$)/.test(name) ? 'codex'
    : /^(claude|opus|sonnet|haiku)(?:[- .\[]|$)/.test(name) ? 'claude'
    : /^gemini(?:[- .]|$)/.test(name) ? 'gemini'
    : /^grok(?:[- .]|$)/.test(name) ? 'grok' : null;
  const brand = modelBrand ?? (agentLogos[agentId] ? agentId : { openai: 'codex', anthropic: 'claude', google: 'gemini', gemini: 'gemini', xai: 'grok' }[preset]);
  return brand ? <AgentLogo agentId={brand} /> : <Icon name="think" size={16} />;
}
