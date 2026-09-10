// Tool registry: typed schemas, execution class, limits, and provider declarations.
import { z } from "zod";
import { ProtocolError } from "@jolo/protocol";
import { fileTools } from "./files.js";
import { gitTools } from "./git.js";
import { outputTools } from "./output.js";
import { browserTools } from "./browser.js";
import { editTools } from "./edit.js";
import { commandTools } from "./command.js";

export const TOOL_RESULT_MAX_BYTES = 64 * 1024;
export const TOOL_ARGUMENT_MAX_BYTES = 1024 * 1024;

export class ToolRegistry {
  constructor(tools = [...fileTools, ...editTools, ...commandTools, ...gitTools, ...outputTools, ...browserTools]) {
    /** @type {Map<string, any>} */
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  get(name) {
    return this.tools.get(name) ?? null;
  }

  names({ browserAvailable = false } = {}) {
    return [...this.tools.values()].filter((tool) => browserAvailable || !tool.browserOperation).map((tool) => tool.name);
  }

  /** Provider-facing declarations: JSON Schema emitted from the Zod definitions. Browser tools appear only with a host. */
  declarations({ browserAvailable = false } = {}) {
    return [...this.tools.values()].filter((tool) => browserAvailable || !tool.browserOperation).map((tool) => {
      const schema = z.toJSONSchema(tool.params);
      delete schema.$schema;
      const portable = node => {
        if (!node || typeof node !== 'object') return;
        delete node.additionalProperties;
        for (const value of Object.values(node)) portable(value);
      };
      portable(schema);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) throw new Error(`Invalid model tool name: ${tool.name}`);
      return { name: tool.name, description: tool.description, parameters: schema, executionClass: tool.executionClass };
    });
  }

  /** Validate model-supplied arguments. Failures become structured tool errors, never crashes. */
  validate(name, rawArguments) {
    const tool = this.get(name);
    if (!tool) throw new ProtocolError("unknown_method", `unknown tool ${name}`);
    const encoded = typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? {});
    if (Buffer.byteLength(encoded) > TOOL_ARGUMENT_MAX_BYTES) throw new ProtocolError("limit_exceeded", "tool arguments exceed 1 MiB");
    let value = rawArguments;
    if (typeof rawArguments === "string") {
      try { value = JSON.parse(rawArguments); } catch { throw new ProtocolError("invalid_params", "tool arguments are not valid JSON"); }
    }
    const parsed = tool.params.safeParse(value ?? {});
    if (!parsed.success) {
      throw new ProtocolError("invalid_params", `invalid arguments for ${name}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    }
    return { tool, args: parsed.data };
  }
}
