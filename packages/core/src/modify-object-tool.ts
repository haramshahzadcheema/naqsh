import { createTool, ToolError, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { ChangeHistory } from "./change-history.js";
import { recordTransition } from "./record-transition.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 11's FIRST real `mutation: "mutate"` tool -- the concrete
 * instantiation of the classification P3/P4 always anticipated
 * (`ToolMutationKind`, `MINIMUM_LEVEL_FOR_MUTATION`) but that no phase up to
 * P10 ever actually implemented: every tool registered before this one
 * (`observe_project`, `create_plan`, `create_proposal`) is `"observe"` or
 * `"suggest"`. Without a real mutate-classified tool, Phase 11's EXECUTE
 * step would have nothing legitimate to execute against the World Model.
 *
 * `input: { objectId, propertyKey, value }` matches the exact contract
 * P10's own test fixtures already established for a "modify_object"
 * proposal (`registryWithModifyObject` in proposal-generator.test.ts /
 * proposal-tool.test.ts) -- this tool is what makes those proposals
 * genuinely executable, not a new, unrelated vocabulary.
 *
 * Unlike `observe_project`/`create_plan`/`create_proposal` (read-only
 * accessors), this handler needs BOTH a way to read the current
 * `WorldModelState` and a way to durably advance it: `getState`/`setState`
 * are explicit collaborators (matching every other tool's "no captured
 * global" convention), and `history` is the same `ChangeHistory` every other
 * audited mutation in this repo goes through -- the handler calls
 * `recordTransition` (never a bare `updateWorldModel`), so every successful
 * call produces a real, auditable `Change` (P2), exactly like any other
 * mutation this repository has ever performed. There is no second,
 * unaudited write path.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    objectId: { type: "string", description: "id of the existing EngineeringObject to modify." },
    propertyKey: { type: "string", description: "Which property to set." },
    value: {
      type: ["string", "number", "boolean"],
      description: "The new value for this property. A property value is genuinely polymorphic (string, number, or boolean depending on the property)."
    }
  },
  required: ["objectId", "propertyKey", "value"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    properties: { type: "object", properties: {}, additionalProperties: true },
    relationships: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } },
    metadata: { type: "object", properties: {}, additionalProperties: true }
  },
  required: ["id", "type", "name", "description", "properties", "relationships", "metadata"]
};

interface ModifyObjectInput {
  objectId: string;
  propertyKey: string;
  value: unknown;
}

function toModifyObjectInput(input: unknown): ModifyObjectInput {
  const record = input as { objectId?: unknown; propertyKey?: unknown; value?: unknown };
  if (typeof record.objectId !== "string" || record.objectId.trim().length === 0) {
    throw new ToolError("invalid_input", "objectId is required and must be a non-empty string");
  }
  if (typeof record.propertyKey !== "string" || record.propertyKey.trim().length === 0) {
    throw new ToolError("invalid_input", "propertyKey is required and must be a non-empty string");
  }
  return { objectId: record.objectId, propertyKey: record.propertyKey, value: record.value };
}

export function createModifyObjectTool(
  getState: () => WorldModelState,
  setState: (next: WorldModelState) => void,
  history: ChangeHistory
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "modify_object",
    description:
      "Sets a single property on an existing engineering object in the current project's World Model. This is a real mutation: it is recorded as an audited Change and durably advances the World Model's version.",
    target: "world_model",
    mutation: "mutate",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toModifyObjectInput(rawInput);
    const state = getState();
    const existing = state.project.objects.find((object) => object.id === input.objectId);
    if (!existing) {
      throw new ToolError("invalid_input", `No object with id "${input.objectId}" exists in this project`);
    }
    const { state: nextState } = recordTransition(
      history,
      state,
      { kind: "update_object", objectId: input.objectId, propertyKey: input.propertyKey, value: input.value },
      { source: "agent", cause: { kind: "tool_execution", description: `modify_object: set "${input.propertyKey}" on "${input.objectId}"` } }
    );
    setState(nextState);
    const updated = nextState.project.objects.find((object) => object.id === input.objectId);
    if (!updated) {
      throw new ToolError("execution_failure", `object "${input.objectId}" unexpectedly missing after modification`);
    }
    return updated;
  };

  return { tool, handler };
}
