import {
  createTool,
  ENTITY_SOURCES,
  ObservationError,
  ToolError,
  type Tool,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import { observeProject, type ObserveProjectOptions } from "./observe-project.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * The first agent-facing, PRODUCTION tool in this repository (P8) — every
 * `Tool` before this one existed only as a test fixture. Registered the
 * normal way (`registry.register(tool, handler)`), executed the normal
 * way (`executeTool`): nothing about this tool's plumbing is special.
 * What makes it "the observation tool" is entirely its `mutation:
 * "observe"` classification and a handler that only ever READS
 * `WorldModelState` through `observeProject` — it has no write path at
 * all, so there is nothing for a future `authorize` hook or P4 policy to
 * even need to gate beyond the classification itself.
 *
 * `getState` is an explicit accessor, not a captured/global reference —
 * this repository has no singleton "current world model," and this tool
 * does not introduce one. Whoever wires this tool into a real
 * `ToolRegistry` (a future P11 orchestration layer) supplies however it
 * tracks the current `WorldModelState` (a closed-over variable, a session
 * store, ...); this file only needs to be handed a way to read it.
 */

const entityArraySchema: ToolValueSchema = {
  type: "array",
  items: { type: "object", properties: {}, additionalProperties: true }
};

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["project", "focus", "object"],
      description:
        '"project" observes the whole project; "focus" observes the session\'s currently focused objects plus their directly connected context; "object" observes exactly one named object plus its directly connected context.'
    },
    objectId: {
      type: "string",
      description: 'Required when scope is "object"; ignored otherwise.'
    }
  },
  required: ["scope"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    projectVersion: { type: "number" },
    scope: { type: "string", enum: ["project", "focus", "object"] },
    scopeObjectId: { type: "string", nullable: true },
    objectiveSummary: { type: "string", nullable: true },
    requirements: entityArraySchema,
    constraints: entityArraySchema,
    objects: entityArraySchema,
    relationships: entityArraySchema,
    decisions: entityArraySchema,
    experiments: entityArraySchema,
    preferences: entityArraySchema,
    focusObjectIds: { type: "array", items: { type: "string" } },
    sessionMode: { type: "string", enum: ["idle", "reviewing", "designing", "executing"] },
    missingInformation: { type: "array", items: { type: "string" } },
    ambiguityIndicators: { type: "array", items: { type: "string" } },
    source: { type: "string", enum: [...ENTITY_SOURCES] },
    observedAt: { type: "string" },
    metadata: { type: "object", properties: {}, additionalProperties: true }
  },
  required: [
    "id",
    "projectId",
    "projectVersion",
    "scope",
    "scopeObjectId",
    "objectiveSummary",
    "requirements",
    "constraints",
    "objects",
    "relationships",
    "decisions",
    "experiments",
    "preferences",
    "focusObjectIds",
    "sessionMode",
    "missingInformation",
    "ambiguityIndicators",
    "source",
    "observedAt",
    "metadata"
  ]
};

/** `executeTool` already validates `input.scope` is one of the declared
 * enum values before this ever runs (`matchesToolValueSchema` against
 * `inputSchema`) — what it CANNOT express is the cross-field rule "objectId
 * is required when scope is object" (`ToolValueSchema` has no
 * if/then). This closes that one remaining gap, and maps
 * `ObservationError` (thrown by `observeProject` for an explicit
 * `scope:"object"` lookup that misses) onto `ToolError("invalid_input")` —
 * the closest existing `ToolErrorKind` for "the request named something
 * that doesn't resolve to valid data", the same mapping choice already
 * made for P7's undeclared-tool-name case. */
function toObserveProjectOptions(input: unknown): ObserveProjectOptions {
  const record = input as { scope?: unknown; objectId?: unknown };
  if (record.scope === "object") {
    if (typeof record.objectId !== "string" || record.objectId.trim().length === 0) {
      throw new ToolError("invalid_input", 'objectId is required and must be a non-empty string when scope is "object"');
    }
    return { scope: "object", objectId: record.objectId };
  }
  if (record.scope === "focus") {
    return { scope: "focus" };
  }
  return { scope: "project" };
}

export function createObservationTool(getState: () => WorldModelState): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "observe_project",
    description:
      "Deterministically observes the current project's World Model state and returns a structured, read-only ObservationResult. Never mutates project state.",
    target: "world_model",
    mutation: "observe",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (input) => {
    const options = toObserveProjectOptions(input);
    try {
      return observeProject(getState(), options);
    } catch (error) {
      if (error instanceof ObservationError) {
        throw new ToolError("invalid_input", error.message);
      }
      throw error;
    }
  };

  return { tool, handler };
}
