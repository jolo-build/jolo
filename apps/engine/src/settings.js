// Engine settings persisted in the preferences table; runtime-validated.
import { SettingsSchema, ProviderSettingsSchema, BudgetSettingsSchema, AgentModelSettingsSchema, AgentModelPatchSchema, ProtocolError } from "@jolo/protocol";

const PROVIDER_KEY = "provider";
const BUDGETS_KEY = "budgets";
const AGENTS_KEY = "agents";

const EMPTY_AGENT = Object.freeze({ model: null, effort: null });

export class SettingsService {
  constructor(storage) {
    this.storage = storage;
  }

  get() {
    const provider = this.storage.getPreference(PROVIDER_KEY) ?? null;
    const budgets = BudgetSettingsSchema.parse(this.storage.getPreference(BUDGETS_KEY) ?? {});
    const parsedProvider = provider ? ProviderSettingsSchema.safeParse(provider) : null;
    const agents = SettingsSchema.shape.agents.safeParse(this.storage.getPreference(AGENTS_KEY) ?? {});
    return SettingsSchema.parse({ provider: parsedProvider?.success ? parsedProvider.data : null, budgets, agents: agents.success ? agents.data : {} });
  }

  /** What a hosted agent should run with. Never throws: an unconfigured agent simply uses its own default. */
  agent(agentId) {
    return this.get().agents[agentId] ?? EMPTY_AGENT;
  }

  update({ provider, budgets, agents }) {
    return this.storage.transaction(() => {
      if (provider !== undefined) {
        if (provider === null) this.storage.setPreference(PROVIDER_KEY, null);
        else {
          const parsed = ProviderSettingsSchema.safeParse(provider);
          if (!parsed.success) throw new ProtocolError("invalid_params", "invalid provider settings");
          this.storage.setPreference(PROVIDER_KEY, parsed.data);
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
