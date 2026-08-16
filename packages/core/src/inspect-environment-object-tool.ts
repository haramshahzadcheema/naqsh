import { createTool, ToolError, type EnvironmentSession, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { EnvironmentAdapter } from "./environment-adapter.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 13's "object detail" tier, exposed as an agent-facing tool: a
 * thin, generic wrapper around `EnvironmentAdapter.inspectObject` — see
 * `inspect-environment-document-tool.ts`'s doc comment for the shared
 * rationale. The one-object counterpart to `inspect_environment_objects`;
 * use this when an agent already knows which object it cares about and
 * doesn't need the whole inventory.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    objectId: { type: "string", description: "id of the object in the connected environment session to inspect." }
  },
  required: ["objectId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    name: { type: "string" },
    genericType: { type: "string" },
    parentId: { type: "string", nullable: true },
    visible: { type: "boolean", nullable: true },
    geometry: { type: "object", properties: {}, additionalProperties: true },
    properties: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } },
    relationships: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } },
    metadata: { type: "object", properties: {}, additionalProperties: true }
  },
  required: ["id", "type", "name", "genericType", "parentId", "visible", "geometry", "properties", "relationships", "metadata"]
};

interface InspectEnvironmentObjectInput {
  objectId: string;
}

function toInspectEnvironmentObjectInput(input: unknown): InspectEnvironmentObjectInput {
  const record = input as { objectId?: unknown };
  if (typeof record.objectId !== "string" || record.objectId.trim().length === 0) {
    throw new ToolError("invalid_input", "objectId is required and must be a non-empty string");
  }
  return { objectId: record.objectId };
}

export function createInspectEnvironmentObjectTool(
  getSession: () => EnvironmentSession | null,
  adapter: EnvironmentAdapter
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "inspect_environment_object",
    description:
      "Reports full detail (normalized generic type, container, visibility, bounded geometry, properties, relationships) for one named object in the connected environment session, through the EnvironmentAdapter boundary. Read-only.",
    target: "environment",
    mutation: "observe",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const input = toInspectEnvironmentObjectInput(rawInput);
    const session = getSession();
    if (!session) {
      throw new ToolError("invalid_input", "No connected environment session is available");
    }
    const result = await adapter.inspectObject(session, input.objectId);
    if (result.status === "error") {
      throw new ToolError("execution_failure", result.error?.message ?? "environment inspectObject failed");
    }
    return result.data;
  };

  return { tool, handler };
}
