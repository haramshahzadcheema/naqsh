import { createTool, ToolError, type EnvironmentSession, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { EnvironmentAdapter } from "./environment-adapter.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * P11's demonstration that a proposal can equally target a real
 * `EnvironmentAdapter` (P5), not only the World Model
 * (`modify-object-tool.ts`) -- "CAD is the first environment" stays honest:
 * this tool is a thin, generic wrapper around `EnvironmentAdapter.
 * modifyObject`, callable against the mock CAD environment
 * (`@naqsh/adapters`) unchanged, and (Phase 14) against the real
 * `FreeCADAdapter`, where it now performs a genuine, narrowly-allowlisted
 * mutation (see `packages/adapters/freecad/runner.py`'s
 * `SUPPORTED_MUTATIONS`). This tool itself carries no FreeCAD-specific
 * knowledge at all -- WHICH properties are safe to write is entirely the
 * adapter's own concern; this file only knows "set one property on one
 * object, optionally guarded by a stale-state check."
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
 * concern.
 *
 * `expectedBeforeValue` (Phase 14 Step 14) is optional stale-state
 * protection: when supplied, the adapter rejects the call with a
 * "conflict" error (mutating nothing) if the property's CURRENT value no
 * longer matches what the caller last observed -- protects against acting
 * on a stale observation when something else may have changed the
 * environment in the meantime.
 *
 * Output is `{object, propertyChanges, alreadySatisfied}` rather than a
 * bare `EnvironmentObject` (Phase 14 audit finding): `requested` and the
 * resulting `after` value are not guaranteed equal (a real environment may
 * clamp/normalize a value — confirmed empirically against FreeCAD), so a
 * caller (an agent, or a human reviewing the executed proposal) needs to
 * see what ACTUALLY happened, not just the final object state.
 *
 * `getSession`/`adapter` are explicit collaborators, matching every other
 * tool's "no captured global" convention.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    objectId: { type: "string", description: "id of the object in the connected environment session to modify." },
    propertyKey: { type: "string", description: "Which property to set." },
    value: {
      type: ["string", "number", "boolean"],
      description: "The new value for this property. A property value is genuinely polymorphic across environments/adapters -- e.g. a mock CAD environment's \"material\" is a string, a real FreeCAD Length/Width/Height is a number."
    },
    expectedBeforeValue: {
      type: ["string", "number", "boolean"],
      nullable: true,
      description:
        'Optional stale-state guard: the value the caller last observed for this property. If the environment\'s CURRENT value no longer matches, the call is rejected with a "conflict" error and nothing is mutated.'
    }
  },
  required: ["objectId", "propertyKey", "value"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    object: {
      type: "object",
      properties: {
        id: { type: "string" },
        type: { type: "string" },
        name: { type: "string" },
        properties: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } },
        relationships: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } },
        metadata: { type: "object", properties: {}, additionalProperties: true }
      },
      additionalProperties: true,
      required: ["id", "type", "name", "properties", "relationships", "metadata"]
    },
    propertyChanges: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } },
    alreadySatisfied: { type: "boolean" }
  },
  required: ["object", "propertyChanges", "alreadySatisfied"]
};

interface ModifyEnvironmentObjectInput {
  objectId: string;
  propertyKey: string;
  value: unknown;
  expectedBeforeValue?: unknown;
}

function toModifyEnvironmentObjectInput(input: unknown): ModifyEnvironmentObjectInput {
  const record = input as { objectId?: unknown; propertyKey?: unknown; value?: unknown; expectedBeforeValue?: unknown };
  if (typeof record.objectId !== "string" || record.objectId.trim().length === 0) {
    throw new ToolError("invalid_input", "objectId is required and must be a non-empty string");
  }
  if (typeof record.propertyKey !== "string" || record.propertyKey.trim().length === 0) {
    throw new ToolError("invalid_input", "propertyKey is required and must be a non-empty string");
  }
  return { objectId: record.objectId, propertyKey: record.propertyKey, value: record.value, expectedBeforeValue: record.expectedBeforeValue };
}

export function createModifyEnvironmentObjectTool(
  getSession: () => EnvironmentSession | null,
  adapter: EnvironmentAdapter
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "modify_environment_object",
    description:
      "Sets a single property on an existing object in the connected environment session, through the EnvironmentAdapter boundary. This is a real mutation of the environment (e.g. mock CAD, or real FreeCAD for its own narrow allowlist of supported properties) -- it never touches WorldModelState directly. Optionally guarded by expectedBeforeValue to protect against acting on a stale observation.",
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
    const options = input.expectedBeforeValue !== undefined ? { expectedBefore: { [input.propertyKey]: input.expectedBeforeValue } } : undefined;
    const result = await adapter.modifyObject(session, input.objectId, { [input.propertyKey]: input.value }, options);
    if (result.status === "error") {
      throw new ToolError("execution_failure", result.error?.message ?? "environment modifyObject failed");
    }
    return {
      object: result.data,
      propertyChanges: result.metadata.propertyChanges ?? [],
      alreadySatisfied: result.metadata.alreadySatisfied === true
    };
  };

  return { tool, handler };
}
