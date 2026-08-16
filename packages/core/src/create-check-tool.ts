import {
  CHECK_KINDS,
  createCheck,
  createTool,
  ENVIRONMENT_OBJECT_GENERIC_TYPES,
  ToolError,
  type Check,
  type CheckInput,
  type EnvironmentObjectGenericType,
  type Tool,
  type ToolValueSchema
} from "@naqsh/schemas";
import type { CheckStore } from "./check-store.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 16's CHECK-DEFINITION half: creates a stable, reusable, typed
 * `Check` that `run_verification` can evaluate -- possibly many times, as
 * the project changes (Phase 16's own "verify, change something, verify
 * again" demo flow requires the SAME check to persist across calls).
 *
 * `ToolValueSchema` (P3) has no union/`oneOf` support, so `inputSchema`
 * below is one flat object declaring every kind's fields as optional; this
 * handler does the REAL per-kind validation by hand (mirroring
 * `modify-environment-object-tool.ts`'s identical "the tool schema is a
 * coarse gate, the handler is the real validator" precedent) before
 * handing a fully-typed `CheckInput` to `createCheck`, which validates a
 * second time at the schemas layer -- defense in depth, not redundancy.
 *
 * Classified `mutation: "suggest"` (creates a new independent record, never
 * touches WorldModelState or the environment's content) -- the exact same
 * classification `create_checkpoint` (P15) uses for an identical reason.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: CHECK_KINDS as string[], description: "Which deterministic check kind to create." },
    description: { type: "string", description: "Human-readable statement of what this check asserts." },
    objectId: { type: "string", description: "The environment object this check targets." },
    property: { type: "string", nullable: true, description: "Required for numeric_comparison, bounds_check, property_required." },
    operator: { type: "string", nullable: true, description: "Required for numeric_comparison: one of eq, neq, lt, lte, gt, gte." },
    expectedValue: { type: "number", nullable: true, description: "Required for numeric_comparison." },
    expectedUnit: { type: "string", nullable: true },
    tolerance: { type: "number", nullable: true },
    min: { type: "number", nullable: true, description: "For bounds_check." },
    max: { type: "number", nullable: true, description: "For bounds_check." },
    minInclusive: { type: "boolean", nullable: true },
    maxInclusive: { type: "boolean", nullable: true },
    unit: { type: "string", nullable: true },
    expectedGenericType: { type: "string", nullable: true, description: "Required for object_type." },
    requireNonNull: { type: "boolean", nullable: true }
  },
  required: ["kind", "description", "objectId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { check: { type: "object", properties: {}, additionalProperties: true } },
  required: ["check"]
};

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolError("invalid_input", message);
  }
  return value;
}

function toCheckInput(rawInput: unknown): CheckInput {
  const record = rawInput as Record<string, unknown>;
  const kind = record.kind;
  const description = requireString(record.description, "description is required and must be a non-empty string");
  const objectId = requireString(record.objectId, "objectId is required and must be a non-empty string");

  switch (kind) {
    case "numeric_comparison": {
      const property = requireString(record.property, "property is required for numeric_comparison checks");
      const operator = record.operator;
      if (operator !== "eq" && operator !== "neq" && operator !== "lt" && operator !== "lte" && operator !== "gt" && operator !== "gte") {
        throw new ToolError("invalid_input", "operator must be one of eq, neq, lt, lte, gt, gte for numeric_comparison checks");
      }
      if (typeof record.expectedValue !== "number" || !Number.isFinite(record.expectedValue)) {
        throw new ToolError("invalid_input", "expectedValue is required and must be a finite number for numeric_comparison checks");
      }
      return {
        kind,
        description,
        objectId,
        property,
        operator,
        expectedValue: record.expectedValue,
        expectedUnit: typeof record.expectedUnit === "string" ? record.expectedUnit : null,
        tolerance: typeof record.tolerance === "number" ? record.tolerance : null
      };
    }
    case "bounds_check": {
      const property = requireString(record.property, "property is required for bounds_check checks");
      const min = typeof record.min === "number" ? record.min : null;
      const max = typeof record.max === "number" ? record.max : null;
      if (min === null && max === null) {
        throw new ToolError("invalid_input", "bounds_check requires at least one of min/max");
      }
      return {
        kind,
        description,
        objectId,
        property,
        min,
        max,
        minInclusive: typeof record.minInclusive === "boolean" ? record.minInclusive : true,
        maxInclusive: typeof record.maxInclusive === "boolean" ? record.maxInclusive : true,
        unit: typeof record.unit === "string" ? record.unit : null
      };
    }
    case "object_exists":
      return { kind, description, objectId };
    case "object_type": {
      const expectedGenericType = record.expectedGenericType;
      if (typeof expectedGenericType !== "string" || !(ENVIRONMENT_OBJECT_GENERIC_TYPES as readonly string[]).includes(expectedGenericType)) {
        throw new ToolError("invalid_input", `expectedGenericType is required for object_type checks and must be one of: ${ENVIRONMENT_OBJECT_GENERIC_TYPES.join(", ")}`);
      }
      return { kind, description, objectId, expectedGenericType: expectedGenericType as EnvironmentObjectGenericType };
    }
    case "property_required": {
      const property = requireString(record.property, "property is required for property_required checks");
      return { kind, description, objectId, property, requireNonNull: typeof record.requireNonNull === "boolean" ? record.requireNonNull : true };
    }
    default:
      throw new ToolError("invalid_input", `kind must be one of: ${CHECK_KINDS.join(", ")}`);
  }
}

export function createCreateCheckTool(checkStore: CheckStore): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "create_check",
    description:
      "Defines a new, stable, reusable deterministic Check (a typed, allowlisted rule -- never an arbitrary expression) that run_verification can later evaluate against fresh evidence. Never mutates the World Model or the environment.",
    target: "verification",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const input = toCheckInput(rawInput);
    const check: Check = createCheck(input);
    checkStore.save(check);
    return { check };
  };

  return { tool, handler };
}
