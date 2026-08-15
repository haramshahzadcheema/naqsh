import { createTool, ToolError, type EnvironmentSession, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { EnvironmentAdapter } from "./environment-adapter.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 11's demonstration that a proposal can equally target a real
 * `EnvironmentAdapter` (P5/P6), not only the World Model
 * (`modify-object-tool.ts`) -- "CAD is the first environment" stays honest:
 * this tool is a thin, generic wrapper around `EnvironmentAdapter.
 * modifyObject`, callable against the mock CAD environment
 * (`@naqsh/adapters`) today and, unchanged, against a real `FreeCADAdapter`
 * once P12 exists. It never imports a concrete adapter package itself --
 * only the `EnvironmentAdapter` interface (core's own contract) -- so no
 * FreeCAD-specific (or even CAD-specific) dependency leaks into core
 * orchestration.
 *
 * Deliberately does NOT reconcile the environment's result back into
 * `WorldModelState`: that mapping (which `EnvironmentObjectId` corresponds
 * to which `EngineeringObject.id`, and how a raw `EnvironmentProperty` list
 * should be interpreted as World Model facts) is real, non-trivial
 * adapter-specific interpretation work that P5's own header comment already
 * named as a later phase's job -- attempting it generically here, for an
 * environment this tool knows nothing about beyond the adapter contract,
 * would mean guessing. This tool proves the EXECUTE step can legitimately
 * reach a real environment through the same typed/permission boundary every
 * other tool goes through (Case E in the P11 test suite: environment
 * execution can fail, and that failure is never reported as success); full
 * environment<->WorldModel reconciliation remains an explicitly deferred
 * concern (see the P11 report's Future Compatibility section).
 *
 * `getSession`/`adapter` are explicit collaborators, matching every other
 * tool's "no captured global" convention.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    objectId: { type: "string", description: "id of the object in the connected environment session to modify." },
    propertyKey: { type: "string", description: "Which property to set." },
    value: { type: "string", description: "The new value for this property." }
  },
  required: ["objectId", "propertyKey", "value"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    name: { type: "string" },
    properties: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } },
    relationships: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } },
    metadata: { type: "object", properties: {}, additionalProperties: true }
  },
  required: ["id", "type", "name", "properties", "relationships", "metadata"]
};

interface ModifyEnvironmentObjectInput {
  objectId: string;
  propertyKey: string;
  value: unknown;
}

function toModifyEnvironmentObjectInput(input: unknown): ModifyEnvironmentObjectInput {
  const record = input as { objectId?: unknown; propertyKey?: unknown; value?: unknown };
  if (typeof record.objectId !== "string" || record.objectId.trim().length === 0) {
    throw new ToolError("invalid_input", "objectId is required and must be a non-empty string");
  }
  if (typeof record.propertyKey !== "string" || record.propertyKey.trim().length === 0) {
    throw new ToolError("invalid_input", "propertyKey is required and must be a non-empty string");
  }
  return { objectId: record.objectId, propertyKey: record.propertyKey, value: record.value };
}

export function createModifyEnvironmentObjectTool(
  getSession: () => EnvironmentSession | null,
  adapter: EnvironmentAdapter
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "modify_environment_object",
    description:
      "Sets a single property on an existing object in the connected environment session, through the EnvironmentAdapter boundary. This is a real mutation of the environment (e.g. mock CAD today, FreeCAD in a later phase) -- it never touches WorldModelState directly.",
    target: "environment",
    mutation: "mutate",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const input = toModifyEnvironmentObjectInput(rawInput);
    const session = getSession();
    if (!session) {
      throw new ToolError("invalid_input", "No connected environment session is available");
    }
    const result = await adapter.modifyObject(session, input.objectId, { [input.propertyKey]: input.value });
    if (result.status === "error") {
      throw new ToolError("execution_failure", result.error?.message ?? "environment modifyObject failed");
    }
    return result.data;
  };

  return { tool, handler };
}
