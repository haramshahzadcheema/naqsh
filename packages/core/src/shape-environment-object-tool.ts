import { createTool, ToolError, type EnvironmentSession, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { EnvironmentAdapter } from "./environment-adapter.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * The two SHAPING tools.
 *
 * Until these existed, the agent could only ever place primitives:
 * `create_environment_object` and `modify_environment_object` were the
 * entire environment tool surface, so Naqsh could position a box and a
 * cylinder but could never subtract one from the other or round an edge.
 * Anything genuinely shaped -- a wheel arch, a softened body -- was
 * reachable only by calling the adapter directly from outside the agent,
 * which is not the product.
 *
 * These wrap capabilities some adapters have and others do not. Rather
 * than widen `EnvironmentAdapter` (and force every mock environment to
 * pretend it can subtract solids), they probe for the methods at call
 * time and report an honest `unsupported_capability` when the connected
 * environment does not implement them -- the same answer the adapter
 * layer itself gives for a capability it lacks.
 */

/** Structural shape of the optional shaping methods. See
 * `FreeCadAdapter` in @naqsh/adapters for the concrete implementation. */
interface ShapingCapableAdapter {
  booleanObject?: (
    session: EnvironmentSession,
    input: { kind: "cut" | "fuse" | "common"; baseId: string; toolId: string; name?: string }
  ) => Promise<{ status: string; data?: unknown; error?: { message?: string } | null }>;
  filletObject?: (
    session: EnvironmentSession,
    input: { objectId: string; radius: number; name?: string }
  ) => Promise<{ status: string; data?: unknown; error?: { message?: string } | null }>;
}

const objectOutputSchema: ToolValueSchema = {
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

const booleanInputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["cut", "fuse", "common"],
      description: "cut = subtract tool from base (wheel arches, holes); fuse = merge into one solid; common = keep only the overlap."
    },
    baseId: { type: "string", description: "Id of the solid being modified." },
    toolId: { type: "string", description: "Id of the solid used as the cutter/addition. The environment consumes both operands into the result." },
    name: { type: "string", nullable: true }
  },
  required: ["kind", "baseId", "toolId"]
};

const filletInputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    objectId: { type: "string", description: "Id of the solid to round." },
    radius: { type: "number", description: "Fillet radius, in the document's units. Every edge is rounded by this amount." },
    name: { type: "string", nullable: true }
  },
  required: ["objectId", "radius"]
};

function requireSession(getSession: () => EnvironmentSession | null): EnvironmentSession {
  const session = getSession();
  if (!session) throw new ToolError("invalid_input", "No connected environment session is available");
  return session;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolError("invalid_input", `${field} is required and must be a non-empty string`);
  }
  return value;
}

export function createBooleanEnvironmentObjectTool(getSession: () => EnvironmentSession | null, adapter: EnvironmentAdapter): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "boolean_environment_object",
    description:
      "Combines two existing solids in the connected environment: 'cut' subtracts one from the other (this is how a wheel arch or a hole is made), 'fuse' merges them into a single solid, 'common' keeps only the overlap. A real mutation, through the EnvironmentAdapter boundary.",
    target: "environment",
    mutation: "mutate",
    inputSchema: booleanInputSchema,
    outputSchema: objectOutputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const record = rawInput as { kind?: unknown; baseId?: unknown; toolId?: unknown; name?: unknown };
    const session = requireSession(getSession);
    const shaping = adapter as unknown as ShapingCapableAdapter;
    if (typeof shaping.booleanObject !== "function") {
      throw new ToolError("execution_failure", "This environment does not support boolean operations");
    }
    // `kind` is already checked against the enum by executeTool before
    // this handler runs, so this cast is validation-backed, not a guess.
    const result = await shaping.booleanObject(session, {
      kind: record.kind as "cut" | "fuse" | "common",
      baseId: requireNonEmptyString(record.baseId, "baseId"),
      toolId: requireNonEmptyString(record.toolId, "toolId"),
      name: typeof record.name === "string" ? record.name : undefined
    });
    if (result.status === "error") {
      throw new ToolError("execution_failure", result.error?.message ?? "environment booleanObject failed");
    }
    return { object: result.data };
  };

  return { tool, handler };
}

export function createFilletEnvironmentObjectTool(getSession: () => EnvironmentSession | null, adapter: EnvironmentAdapter): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "fillet_environment_object",
    description:
      "Rounds every edge of one solid by a single radius. Rounded edges are what make a shape read as designed rather than as stacked blocks. Note that a solid produced by boolean cuts often cannot be filleted at any radius, so round a shape before cutting it.",
    target: "environment",
    mutation: "mutate",
    inputSchema: filletInputSchema,
    outputSchema: objectOutputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const record = rawInput as { objectId?: unknown; radius?: unknown; name?: unknown };
    const session = requireSession(getSession);
    const shaping = adapter as unknown as ShapingCapableAdapter;
    if (typeof shaping.filletObject !== "function") {
      throw new ToolError("execution_failure", "This environment does not support fillets");
    }
    if (typeof record.radius !== "number" || !Number.isFinite(record.radius)) {
      throw new ToolError("invalid_input", "radius is required and must be a finite number");
    }
    const result = await shaping.filletObject(session, {
      objectId: requireNonEmptyString(record.objectId, "objectId"),
      radius: record.radius,
      name: typeof record.name === "string" ? record.name : undefined
    });
    if (result.status === "error") {
      throw new ToolError("execution_failure", result.error?.message ?? "environment filletObject failed");
    }
    return { object: result.data };
  };

  return { tool, handler };
}
