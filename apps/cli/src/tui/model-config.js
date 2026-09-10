import { AgentModelPatchSchema, modelFromFields, ProviderOverridesSchema } from "@jolo/protocol";

export function parseModelCommand(text) {
  const match = text.trim().match(/^\/model(?:\s+(.+))?$/i);
  return match ? { target: match[1]?.trim() ?? null } : null;
}

export function modelTargets(agents, presets) {
  return [{ id: "jolo", displayName: "Jolo provider" }, ...(presets ? presets.map(p => ({ ...p, id: `provider:${p.id}`, preset: p.id })) : []), ...agents.filter((agent) => agent.supportsModel || agent.supportsEffort || (agent.transport && agent.transport !== "pty"))];
}

export function selectedAgent(target) {
  if (target.id === "jolo" || target.preset) return null;
  if (target.available === false) throw new Error(`${target.displayName} is not installed or is unavailable on the engine's PATH.`);
  if (target.transport === "pty") throw new Error("This agent only supports a separate terminal, not chat prompts.");
  return target.id;
}

export function modelForm(target, settings) {
  if (target.id !== "jolo" && !target.preset) {
    const current = settings.agents?.[target.id] ?? target;
    return { model: current.model ?? "", effort: current.effort ?? "" };
  }
  const ref = settings.model;
  const legacy = settings.provider?.name === 'openai' ? settings.provider : null;
  const name = target.preset ?? ref?.preset ?? legacy?.name ?? (settings.demoProviderEnabled ? 'fake' : 'openai');
  const current = ref?.preset === name ? ref : null;
  return { name, model: current?.model ?? (legacy?.name === name ? legacy.model : ''), contextWindowTokens: String(current?.contextWindowTokens ?? (legacy?.name === name ? legacy.contextWindowTokens : '') ?? ''), maxOutputTokens: String(current?.maxOutputTokens ?? (legacy?.name === name ? legacy.maxOutputTokens : '') ?? ''), baseUrl: settings.providers?.[name]?.baseUrl ?? (legacy?.name === name ? legacy.baseUrl : '') ?? '', reasoningEffort: current?.effort ?? legacy?.reasoningEffort ?? '', apiKey: '' };
}

export function modelFields(target, form, settings = {}) {
  if (target.id !== "jolo" && !target.preset) return [
    ...(target.supportsModel ? [{ id: "model", label: "Model", limit: 200, placeholder: "agent default" }] : []),
    ...(target.supportsEffort ? [{ id: "effort", label: "Effort", limit: 40, placeholder: "agent default" }] : []),
    ...(target.available && target.supportsModel ? [{ id: "discover", label: "Find models", action: true }] : []),
    { id: "save", label: "Save and use", action: true },
  ];
  return [
    ...(target.preset ? [] : [{ id: "name", label: "Provider", choices: settings?.demoProviderEnabled ? ["fake", "openai"] : ["openai"] }]),
    ...(form.name === "fake" ? [] : [
      { id: "model", label: "Model", limit: 200, placeholder: "model ID" },
      { id: "contextWindowTokens", label: "Context tokens", limit: 10, placeholder: "automatic" },
      { id: "maxOutputTokens", label: "Max output tokens", limit: 10, placeholder: "automatic" },
      { id: "baseUrl", label: "Base URL", limit: 500, placeholder: "provider default" },
      { id: "reasoningEffort", label: "Reasoning", choices: ["", "none", "minimal", "low", "medium", "high", "xhigh", "max"] },
      ...(target.auth?.kind === "none" ? [] : [{ id: "apiKey", label: "API key", limit: 4096, secret: true, placeholder: "keep existing key" }]),
      { id: "discover", label: "Find models", action: true },
    ]),
    { id: "save", label: "Save and use", action: true },
  ];
}

export function modelSettingsPatch(target, form) {
  if (target.id !== "jolo" && !target.preset) {
    const patch = {};
    if (target.supportsModel) patch.model = form.model.trim() || null;
    if (target.supportsEffort) patch.effort = form.effort.trim() || null;
    const parsed = AgentModelPatchSchema.safeParse(patch);
    if (!parsed.success) throw new Error("Model or effort is too long or contains invalid characters.");
    return { agents: { [target.id]: parsed.data } };
  }
  if (form.apiKey?.trim() && (form.apiKey.trim().length < 8 || form.apiKey.trim().length > 4096)) throw new Error('API key must contain 8 to 4096 characters.');
  return { model: modelFromFields(form), providers: ProviderOverridesSchema.parse({ [form.name]: { baseUrl: form.baseUrl?.trim() || null } }) };
}

// Credentials travel only through the credential RPC, never settings, task messages, or prompt history.
export async function saveModelConfig(client, target, form) {
  const patch = modelSettingsPatch(target, form);
  const secret = (target.id === "jolo" || target.preset) && target.auth?.kind !== "none" ? form.apiKey?.trim() ?? "" : "";
  let stored = null;
  try {
    if (secret) stored = (await client.call("credential.set", { provider: form.name, value: secret })).stored;
    await client.call("settings.update", patch);
  } catch (error) {
    const message = secret ? String(error.message).split(secret).join("[redacted]") : error.message;
    throw new Error(`${stored ? "API key stored; model settings were not saved. " : ""}${message}`);
  }
  return `Model configuration saved · applies to the next run${stored === "session" ? " · API key lasts until the engine exits" : ""}`;
}

export function currentModelLabel(settings, session) {
  if (!settings) return "Loading model…";
  if (session?.agentId) return `${session.agentId} · ${settings.agents?.[session.agentId]?.model ?? "default"}`;
  if (session?.model ?? settings.model) return (session?.model ?? settings.model).preset === "fake" ? "Demo provider" : (session?.model ?? settings.model).model;
  return settings.provider && settings.provider.name !== "fake" ? settings.provider.model : settings.demoProviderEnabled ? "Demo provider" : "Configure provider";
}
