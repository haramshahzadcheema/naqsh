import { createTool, ToolError, type EnvironmentObject, type EnvironmentSession, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { EnvironmentAdapter } from "./environment-adapter.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * A lighter, relationship-focused view over the connected environment
 * session (Phase 13 Step 9/19) — a thin RESHAPING of
 * `EnvironmentAdapter.listObjects`'s own result, not a new adapter
 * capability: relationships are already first-class data on every
 * `EnvironmentObject` (see `inspect-environment-objects-tool.ts`), so this
 * tool exists purely to let an agent ask for "just the structural graph"
 * without paying for (or reading through) every object's full property
 * payload, which can dominate a real document's response size.
 *
 * `mutation: "observe"` — read-only, same as every other tool in this
 * file group.
 */

const outputSchema: ToolValueSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      genericType: { type: "string" },
      parentId: { type: "string", nullable: true },
      relationships: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } }
    },
    required: ["id", "genericType", "parentId", "relationships"]
  }
};

export function createInspectEnvironmentRelationshipsTool(
  getSession: () => EnvironmentSession | null,
  adapter: EnvironmentAdapter
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "inspect_environment_relationships",
    description:
      "Reports the structural relationship graph (per object: id, generic type, container/parentId, and relationships) for the connected environment session, through the EnvironmentAdapter boundary -- a lighter view than inspect_environment_objects for an agent that only needs structure, not full properties. Read-only.",
    target: "environment",
    mutation: "observe",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema
  });

  const handler: ToolHandler = async () => {
    const session = getSession();
    if (!session) {
      throw new ToolError("invalid_input", "No connected environment session is available");
    }
    const result = await adapter.listObjects(session);
    if (result.status === "error") {
      throw new ToolError("execution_failure", result.error?.message ?? "environment listObjects failed");
    }
    const objects = result.data as EnvironmentObject[];
    return objects.map((object) => ({
      id: object.id,
      genericType: object.genericType,
      parentId: object.parentId,
      relationships: object.relationships
    }));
  };

  return { tool, handler };
}
