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
 * stores tools — it does not validate input/output against a tool's
 * schema, does not run a policy/approval check, and does not build a
 * ToolResult. That full boundary lives in execute-tool.ts.
 *
 * Deliberately has NO `invoke`/execute method. An earlier version did, and
 * the P3/P4 audit flagged it as a real bypass: anything holding a
 * `ToolRegistry` reference could call it directly, skipping
 * execute-tool.ts's input/output validation AND whatever `authorize` hook
 * P4 wires in — completely defeating authorization. Dispatch now lives in
 * `invokeRegisteredTool` below, which is NOT a method on this interface
 * and is NOT re-exported from @naqsh/core's public index — only
 * execute-tool.ts imports it, via a direct relative import within this
 * same package. This is an API-design boundary, not a runtime sandbox (it
 * cannot stop code that deliberately reaches past it), but it means the
 * correct path is the only one that's ergonomically reachable, and a
 * bypass attempt has to be a conspicuous, deliberate act rather than an
 * innocent-looking method call.
 */
export interface ToolRegistry {
  /** Throws ToolError("duplicate_registration") if `tool.name` or
   * `tool.id` is already registered. */
  register(tool: Tool, handler: ToolHandler): void;
  getByName(name: string): Tool | undefined;
  getById(id: string): Tool | undefined;
  list(): readonly Tool[];
  hasName(name: string): boolean;
}

const handlersByRegistry = new WeakMap<ToolRegistry, Map<string, RegisteredTool>>();

export function createToolRegistry(): ToolRegistry {
  const byName = new Map<string, RegisteredTool>();
  const byId = new Map<string, RegisteredTool>();

  const registry: ToolRegistry = {
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
    hasName: (name) => byName.has(name)
  };

  handlersByRegistry.set(registry, byName);
  return registry;
}

/**
 * The ONLY way to actually run a registered tool's handler. Throws
 * ToolError("unknown_tool") if `registry` isn't a real ToolRegistry
 * produced by `createToolRegistry` (the WeakMap lookup fails) or if `name`
 * isn't registered on it. execute-tool.ts is the one sanctioned caller —
 * see ToolRegistry's doc comment above for why this is a free function
 * instead of a method.
 */
export async function invokeRegisteredTool(registry: ToolRegistry, name: string, input: unknown): Promise<unknown> {
  const byName = handlersByRegistry.get(registry);
  if (!byName) {
    throw new ToolError("unknown_tool", "Not a valid ToolRegistry instance");
  }
  const entry = byName.get(name);
  if (!entry) {
    throw new ToolError("unknown_tool", `No tool named "${name}" is registered`);
  }
  return entry.handler(input);
}
