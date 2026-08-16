import { createTool, ToolError, type EnvironmentSession, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { EnvironmentAdapter } from "./environment-adapter.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 13's "object inventory" tier, exposed as an agent-facing tool: a
 * thin, generic wrapper around `EnvironmentAdapter.listObjects` — see
 * `inspect-environment-document-tool.ts`'s doc comment for the shared
 * rationale (generic naming, `mutation: "observe"`, no captured globals).
 *
 * Returns every object currently in the connected session, each carrying
 * its normalized `genericType`, `parentId`, `visible`, bounded `geometry`,
 * full `properties`, and `relationships` — the SAME `EnvironmentObject`
 * shape `modify_environment_object` already returns after a mutation, just
 * reached through a read-only path. `result.metadata` (not part of the
 * declared output — this tool returns only the object array as `data`, but
 * see `inspect_environment_objects`'s handler) may carry
 * `warnings`/`inspectionErrors` when the adapter had to skip a malformed
 * object rather than fail the whole call (Phase 13 Step 16); this tool
 * currently surfaces the object array only, matching `listObjects`'s own
 * `data` contract — a caller that needs the partial-success diagnostics
 * reads `EnvironmentAdapter.listObjects` directly.
 */

const objectSchema: ToolValueSchema = {
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

const outputSchema: ToolValueSchema = {
  type: "array",
  items: objectSchema
};

export function createInspectEnvironmentObjectsTool(
  getSession: () => EnvironmentSession | null,
  adapter: EnvironmentAdapter
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "inspect_environment_objects",
    description:
      "Lists every object currently in the connected environment session, through the EnvironmentAdapter boundary -- id, normalized generic type, container, visibility, bounded geometry, properties, and relationships for each. Read-only.",
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
    return result.data;
  };

  return { tool, handler };
}
