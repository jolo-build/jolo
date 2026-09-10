// Provider credentials: OS secret store first, session-only fallback, environment for development (§15).
const SERVICE = "jolo";
const ENV_NAMES = Object.freeze({ openai: "OPENAI_API_KEY" });

export class CredentialService {
  constructor({ log, env = process.env, mode = env.JOLO_CREDENTIALS ?? "keychain" }) {
    this.log = log;
    this.env = env;
    this.mode = mode; // "keychain" | "session" (tests and locked keyrings)
    /** @type {Map<string, string>} */
    this.session = new Map();
  }

  async get(provider) {
    const session = this.session.get(provider);
    if (session) return { value: session, source: "session" };
    if (this.mode === "keychain" && typeof Bun !== "undefined" && Bun.secrets) {
      try {
        const value = await Bun.secrets.get({ service: SERVICE, name: `provider:${provider}` });
        if (value) return { value, source: "keychain" };
      } catch (error) {
        this.log?.warn("secret store unavailable; using session credentials", { provider, error: String(error?.message ?? error) });
      }
    }
    const envValue = this.env[ENV_NAMES[provider]];
    if (envValue) return { value: envValue, source: "environment" };
    return null;
  }

  async set(provider, value) {
    if (this.mode === "keychain" && typeof Bun !== "undefined" && Bun.secrets) {
      try {
        await Bun.secrets.set({ service: SERVICE, name: `provider:${provider}`, value });
        this.session.delete(provider);
        return "keychain";
      } catch (error) {
        this.log?.warn("secret store rejected the credential; kept for this session only", { provider, error: String(error?.message ?? error) });
      }
    }
    this.session.set(provider, value);
    return "session";
  }

  async status(provider) {
    const found = await this.get(provider);
    return { provider, available: Boolean(found), source: found?.source ?? "none" };
  }
}
