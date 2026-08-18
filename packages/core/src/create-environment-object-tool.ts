import { createTool, ToolError, type EnvironmentObjectGenericType, type EnvironmentSession, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { EnvironmentAdapter } from "./environment-adapter.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 20's BUILD half needed a tool that had never existed until now:
 * `EnvironmentAdapter.createObject` (P5) has been part of the adapter
 * interface since P5, and both the mock environment (P6) and the real
 * FreeCAD adapter (P12) already implement it -- but no tool wrapped it,
 * so nothing could ever legitimately CALL it. This is that tool, mirroring
 * `modify-environment-object-tool.ts`'s (P11/P14) exact shape and
 * reasoning: a thin, generic wrapper around one `EnvironmentAdapter`
 * method, carrying no FreeCAD-specific (or any adapter-specific)
 * knowledge itself -- WHICH object types/properties are meaningful is
 * entirely the adapter's own concern.
 *
 * This is also `build-operations.ts`'s target: `planBuildOperations`
 * translates each `ExpectedBuildOutput` in a `DesignSpecification` into
 * exactly one call to this tool. Against the mock environment (P6) this
 * is a genuine, real object creation; against the real FreeCAD adapter
 * (P12), `create` is not yet a supported capability (deliberately, per
 * that phase's own scope) so this tool surfaces the SAME
 * `unsupported_capability` error `create_object` already returns --
 * this tool does not, and should not, try to work around that.
 *
 * Deliberately does NOT reconcile the created object back into
 * `WorldModelState.project.objects` -- identical, explicitly-accepted
 * scope boundary `modify-environment-object-tool.ts` already documents
 * (real environment<->WorldModel reconciliation is deferred, non-trivial,
 * adapter-specific work).
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    type: { type: "string", description: "Environment-specific object type label (e.g. 'part')." },
    name: { type: "string" },
    genericType: { type: "string", nullable: true, enum: ["solid", "sketch", "container", "datum", "link", "unknown"] },
    parentId: { type: "string", nullable: true },
    properties: {
      type: "object",
      properties: {},
      additionalProperties: true,
      description: "Initial property values as a flat key/value bag -- polymorphic per environment, same as modify_environment_object's value field."
    }
  },
  required: ["type", "name"]
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
    }
  },
  required: ["object"]
};

interface CreateEnvironmentObjectInput {
  type: string;
  name: string;
  genericType?: string | null;
  parentId?: string | null;
  properties?: Record<string, unknown>;
}

function toCreateEnvironmentObjectInput(input: unknown): CreateEnvironmentObjectInput {
  const record = input as { type?: unknown; name?: unknown; genericType?: unknown; parentId?: unknown; properties?: unknown };
  if (typeof record.type !== "string" || record.type.trim().length === 0) {
    throw new ToolError("invalid_input", "type is required and must be a non-empty string");
  }
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    throw new ToolError("invalid_input", "name is required and must be a non-empty string");
  }
  return {
    type: record.type,
    name: record.name,
    genericType: typeof record.genericType === "string" ? record.genericType : null,
    parentId: typeof record.parentId === "string" ? record.parentId : null,
    properties: typeof record.properties === "object" && record.properties !== null ? (record.properties as Record<string, unknown>) : {}
  };
}

export function createCreateEnvironmentObjectTool(getSession: () => EnvironmentSession | null, adapter: EnvironmentAdapter): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "create_environment_object",
    description:
      "Creates a new object in the connected environment session, through the EnvironmentAdapter boundary. A real mutation of the environment (e.g. mock CAD, or a real adapter that supports the 'create' capability) -- it never touches WorldModelState directly.",
    target: "environment",
    mutation: "mutate",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const input = toCreateEnvironmentObjectInput(rawInput);
    const session = getSession();
    if (!session) {
      throw new ToolError("invalid_input", "No connected environment session is available");
    }
    // `input.genericType`, when present, is already schema-validated
    // against the six-value enum in `inputSchema` above (checked by
    // `executeTool` before this handler ever runs) -- this cast is safe,
    // not a trust decision.
    const genericType = input.genericType === null ? undefined : (input.genericType as EnvironmentObjectGenericType);
    const result = await adapter.createObject(session, {
      type: input.type,
      name: input.name,
      genericType,
      parentId: input.parentId ?? null,
      properties: Object.entries(input.properties ?? {}).map(([key, value]) => ({ key, value, readOnly: false }))
    });
    if (result.status === "error") {
      throw new ToolError("execution_failure", result.error?.message ?? "environment createObject failed");
    }
    return { object: result.data };
  };

  return { tool, handler };
}
