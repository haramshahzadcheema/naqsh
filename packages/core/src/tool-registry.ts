import { assertTool, ToolError, type Tool } from "@naqsh/schemas";

/**
 * A tool's actual implementation. Never part of `Tool` (schemas' data
 * contract) — a handler is behavior, not data, exactly like a transition's
 * `apply()` never left @naqsh/core in P1. This is what makes a `Tool`
 * safely serializable/inspectable on its own and what makes "no arbitrary
 * execution" a real, checkable property: nothing about a `Tool` value
 * could ever contain code to run.
 */
export type ToolHandler<Input = unknown, Output = unknown> = (input: Input) => Output | Promise<Output>;

interface RegisteredTool {
  tool: Tool;
  handler: ToolHandler;
}

/**
 * Deterministic, in-memory tool registry. Registration and execution are
 * deliberately separate concerns (per the P3 brief): this module only
 * stores tools and dispatches a validated call to the matching handler —
 * it does not validate input/output against a tool's schema, does not run
 * a policy/approval check, and does not build a ToolResult. That full
 * boundary lives in execute-tool.ts, the ONLY intended caller of `invoke`.
 *
 * `invoke` (not a plain handler getter) is the deliberate encapsulation
 * choice: nothing outside this module can ever obtain a raw handler
 * reference and call it directly, bypassing execute-tool.ts's validation.
 * The only thing `invoke` can be asked to do is run an already-registered
 * tool by name with some input — the same minimal capability
 * execute-tool.ts already needs, nothing more privileged than that.
 */
export interface ToolRegistry {
  /** Throws ToolError("duplicate_registration") if `tool.name` or
   * `tool.id` is already registered. */
  register(tool: Tool, handler: ToolHandler): void;
  getByName(name: string): Tool | undefined;
  getById(id: string): Tool | undefined;
  list(): readonly Tool[];
  hasName(name: string): boolean;
  /** Dispatch primitive used by execute-tool.ts. Throws
   * ToolError("unknown_tool") if `name` isn't registered; otherwise calls
   * the handler and returns (or rejects with) whatever it does. */
  invoke(name: string, input: unknown): Promise<unknown>;
}

export function createToolRegistry(): ToolRegistry {
  const byName = new Map<string, RegisteredTool>();
  const byId = new Map<string, RegisteredTool>();

  return {
    register(tool, handler) {
      assertTool(tool);
      if (typeof handler !== "function") {
        throw new ToolError("execution_failure", `Tool "${tool.name}" must be registered with a handler function`);
      }
      if (byName.has(tool.name)) {
        throw new ToolError("duplicate_registration", `A tool named "${tool.name}" is already registered`);
      }
      if (byId.has(tool.id)) {
        throw new ToolError("duplicate_registration", `A tool with id "${tool.id}" is already registered`);
      }
      const entry: RegisteredTool = { tool, handler };
      byName.set(tool.name, entry);
      byId.set(tool.id, entry);
    },
    getByName: (name) => byName.get(name)?.tool,
    getById: (id) => byId.get(id)?.tool,
    list: () => Array.from(byName.values(), (entry) => entry.tool),
    hasName: (name) => byName.has(name),
    async invoke(name, input) {
      const entry = byName.get(name);
      if (!entry) {
        throw new ToolError("unknown_tool", `No tool named "${name}" is registered`);
      }
      return entry.handler(input);
    }
  };
}
