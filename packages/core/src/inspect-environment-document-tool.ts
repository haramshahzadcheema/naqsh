import { createTool, ToolError, type EnvironmentSession, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { EnvironmentAdapter } from "./environment-adapter.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 13's cheapest inspection tier, exposed as an agent-facing tool: a
 * thin, generic wrapper around `EnvironmentAdapter.inspectDocument` — no
 * FreeCAD-specific method name, no FreeCAD-specific shape, callable
 * unchanged against the mock environments (`@naqsh/adapters`) and a real
 * `FreeCADAdapter` alike. `mutation: "observe"` — this tool never writes
 * anything, matching `observation-tool.ts`'s own classification for the
 * identical reason: there is nothing for a future `authorize` hook to gate
 * beyond the classification itself.
 *
 * Deliberately returns document identity/structure only (no per-object
 * properties/relationships/geometry) — see
 * `inspect-environment-objects-tool.ts`/`inspect-environment-object-tool.ts`
 * for those. An agent that only needs "how big is this document, what's in
 * it" should not have to pay for a full object listing.
 *
 * `getSession`/`adapter` are explicit collaborators, matching every other
 * environment-facing tool's "no captured global" convention.
 */

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    environmentKind: { type: "string" },
    documentId: { type: "string", nullable: true },
    documentName: { type: "string", nullable: true },
    filePath: { type: "string", nullable: true },
    objectCount: { type: "number" },
    objectIds: { type: "array", items: { type: "string" } },
    rootObjectIds: { type: "array", items: { type: "string" } },
    inspectedAt: { type: "string" },
    environmentVersion: { type: "string", nullable: true },
    warnings: { type: "array", items: { type: "string" } },
    unsupportedFeatures: { type: "array", items: { type: "string" } },
    inspectionErrors: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } },
    metadata: { type: "object", properties: {}, additionalProperties: true }
  },
  required: [
    "environmentKind",
    "documentId",
    "documentName",
    "filePath",
    "objectCount",
    "objectIds",
    "rootObjectIds",
    "inspectedAt",
    "environmentVersion",
    "warnings",
    "unsupportedFeatures",
    "inspectionErrors",
    "metadata"
  ]
};

export function createInspectEnvironmentDocumentTool(
  getSession: () => EnvironmentSession | null,
  adapter: EnvironmentAdapter
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "inspect_environment_document",
    description:
      "Reports document-level identity and structure (object count, object ids, hierarchy roots) for the connected environment session, through the EnvironmentAdapter boundary. Read-only, and deliberately lightweight -- no per-object properties, relationships, or geometry (use inspect_environment_objects/inspect_environment_object for those).",
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
    const result = await adapter.inspectDocument(session);
    if (result.status === "error") {
      throw new ToolError("execution_failure", result.error?.message ?? "environment inspectDocument failed");
    }
    return result.data;
  };

  return { tool, handler };
}
