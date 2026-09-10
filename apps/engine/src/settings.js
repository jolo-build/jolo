// Engine settings persisted in the preferences table; runtime-validated.
import { SettingsSchema, ProviderSettingsSchema, BudgetSettingsSchema, AgentModelSettingsSchema, AgentModelPatchSchema, ModelRefSchema, ProviderOverridesSchema, ProtocolError } from "@jolo/protocol";
import { demoProviderEnabled } from "./providers/mode.js";

const PROVIDER_KEY = "provider";
const BUDGETS_KEY = "budgets";
const AGENTS_KEY = "agents";

const EMPTY_AGENT = Object.freeze({ model: null, effort: null });

export class SettingsService {
  constructor(storage, { env = process.env, catalog } = {}) {
    this.catalog = catalog;
    this.storage = storage;
    this.demoProviderEnabled = demoProviderEnabled(env);
  }

  get() {
    if (!this.storage.getPreference('model-settings-migrated')) {
      const legacy = ProviderSettingsSchema.safeParse(this.storage.getPreference(PROVIDER_KEY));
      this.storage.transaction(() => {
        if (legacy.success) this.writeLegacy(legacy.data);
        this.storage.setPreference('model-settings-migrated', true);
      });
    }
    const model = ModelRefSchema.nullable().parse(this.storage.getPreference('model') ?? null);
    const providers = ProviderOverridesSchema.parse(this.storage.getPreference('providers') ?? {});
    const provider = this.storage.getPreference(PROVIDER_KEY) ?? null;
    const budgets = BudgetSettingsSchema.parse(this.storage.getPreference(BUDGETS_KEY) ?? {});
    const parsedProvider = provider ? ProviderSettingsSchema.safeParse(provider) : null;
    const agents = SettingsSchema.shape.agents.safeParse(this.storage.getPreference(AGENTS_KEY) ?? {});
    const effectiveProvider = parsedProvider?.success && (parsedProvider.data.name !== "fake" || this.demoProviderEnabled) ? parsedProvider.data : null;
    return SettingsSchema.parse({ model: model?.preset === 'fake' && !this.demoProviderEnabled ? null : model, providers, provider: effectiveProvider, demoProviderEnabled: this.demoProviderEnabled, budgets, agents: agents.success ? agents.data : {} });
  }

  /** What a hosted agent should run with. Never throws: an unconfigured agent simply uses its own default. */
  agent(agentId) {
    return this.get().agents[agentId] ?? EMPTY_AGENT;
  }

  writeLegacy(provider) {
    this.storage.setPreference(PROVIDER_KEY, provider);
    const model = provider && provider.name !== 'fake' ? ModelRefSchema.parse({ preset: provider.name, model: provider.model, effort: provider.reasoningEffort ?? null, contextWindowTokens: provider.contextWindowTokens, maxOutputTokens: provider.maxOutputTokens }) : null;
    this.storage.setPreference('model', model);
    if (provider?.name === 'openai') this.storage.setPreference('providers', { ...(this.storage.getPreference('providers') ?? {}), openai: { baseUrl: provider.baseUrl ?? null } });
  }

  update({ provider, model, providers, budgets, agents }) {
    this.get(); // Migrate before applying a new-format patch, including an explicit null.
    return this.storage.transaction(() => {
      if (provider !== undefined && model !== undefined) throw new ProtocolError('invalid_params', 'Choose model or legacy provider settings, not both');
      if (providers) {
        for (const id of Object.keys(providers)) this.catalog?.get(id);
        this.storage.setPreference('providers', ProviderOverridesSchema.parse({ ...(this.storage.getPreference('providers') ?? {}), ...providers }));
      }
      if (model !== undefined) {
        const parsed = ModelRefSchema.nullable().parse(model);
        if (parsed?.preset === 'fake' && !this.demoProviderEnabled) throw new ProtocolError('invalid_params', 'the demo provider is only available in development mode');
        if (parsed) this.catalog?.get(parsed.preset);
        this.storage.setPreference('model', parsed);
        this.storage.setPreference(PROVIDER_KEY, null); // Legacy clients cannot represent other protocols.
      }
      if (provider !== undefined) {
        if (provider === null) this.writeLegacy(null);
        else {
          const parsed = ProviderSettingsSchema.safeParse(provider);
          if (!parsed.success) throw new ProtocolError("invalid_params", "invalid provider settings");
          if (parsed.data.name === "fake" && !this.demoProviderEnabled) throw new ProtocolError("invalid_params", "the demo provider is only available in development mode");
          this.writeLegacy(parsed.data);
        }
      }
      if (budgets) {
        const merged = BudgetSettingsSchema.parse({ ...(this.storage.getPreference(BUDGETS_KEY) ?? {}), ...budgets });
        this.storage.setPreference(BUDGETS_KEY, merged);
      }
      if (agents) {
        // A patch, one agent at a time: given fields merge, null forgets the agent, and an entry that says
        // nothing is dropped rather than stored as a row of nulls.
        const current = { ...(this.storage.getPreference(AGENTS_KEY) ?? {}) };
        for (const [agentId, patch] of Object.entries(agents)) {
          if (patch === null) { delete current[agentId]; continue; }
          const named = Object.fromEntries(Object.entries(AgentModelPatchSchema.parse(patch)).filter(([, value]) => value !== undefined));
          const merged = AgentModelSettingsSchema.parse({ ...EMPTY_AGENT, ...(current[agentId] ?? {}), ...named });
          if (merged.model === null && merged.effort === null) delete current[agentId];
          else current[agentId] = merged;
        }
        this.storage.setPreference(AGENTS_KEY, current);
      }
      return this.get();
    });
  }
}
