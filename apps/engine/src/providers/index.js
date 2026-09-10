// Provider factory: settings + credentials → adapter. Never logs secrets.
import { ProtocolError } from "@jolo/protocol";
import { createFakeProvider, loadFakeScript } from "./fake.js";
import { createOpenAIProvider } from "./openai.js";

export class ProviderFactory {
  constructor({ credentials, env = process.env, log, fetchImpl }) {
    this.credentials = credentials;
    this.env = env;
    this.log = log;
    this.fetchImpl = fetchImpl;
  }

  /** Resolve the effective provider for a run. Without configuration the fake provider is used and reported. */
  async create(providerSettings) {
    const effective = providerSettings ?? { name: "fake", model: "fake", contextWindowTokens: 128_000, maxOutputTokens: 4_096 };
    if (effective.name === "fake") {
      return {
        settings: effective,
        configured: Boolean(providerSettings),
        provider: createFakeProvider({ steps: Number(this.env.JOLO_FAKE_STEPS ?? 20), delayMs: Number(this.env.JOLO_FAKE_DELAY_MS ?? 100), script: loadFakeScript(this.env), contextWindowTokens: effective.contextWindowTokens, maxOutputTokens: effective.maxOutputTokens }),
      };
    }
    if (effective.name === "openai") {
      const credential = await this.credentials.get("openai");
      if (!credential) throw new ProtocolError("unavailable", "no OpenAI credential is configured; run `jolo auth set openai`");
      return {
        settings: effective,
        configured: true,
        provider: createOpenAIProvider({ apiKey: credential.value, model: effective.model, baseUrl: effective.baseUrl, contextWindowTokens: effective.contextWindowTokens, maxOutputTokens: effective.maxOutputTokens, reasoningEffort: effective.reasoningEffort, fetchImpl: this.fetchImpl }),
      };
    }
    throw new ProtocolError("unavailable", `unknown provider ${effective.name}`);
  }
}
