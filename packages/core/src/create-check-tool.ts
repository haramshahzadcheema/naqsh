import {
  CHECK_KINDS,
  createCheck,
  createTool,
  ENVIRONMENT_OBJECT_GENERIC_TYPES,
  ToolError,
  type Check,
  type CheckInput,
  type Constraint,
  type EnvironmentObjectGenericType,
  type Requirement,
  type Tool,
  type ToolValueSchema,
  type WorldModelState
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
 *
 * GOALPOST INTEGRITY (external audit finding): `requirementId`/
 * `constraintId` are OPTIONAL tool-input fields (not new fields on `Check`
 * itself -- stored in the existing `metadata` extension point, the same
 * pattern P18 used for `Requirement.metadata.operator` rather than
 * touching this already-audited P16 schema). When supplied, a
 * `numeric_comparison`/`bounds_check` is cross-validated against the
 * linked `Requirement`/`Constraint`'s own declared `value`/`unit` (and, for
 * a Requirement, the `operator` P18 stores in its `metadata`): the check
 * cannot assert a threshold the linked entity didn't itself declare. This
 * closes the gap where an agent could define a Check with an arbitrary,
 * trivially-satisfiable threshold (e.g. "Height gte -999999") while
 * claiming it verifies a specific requirement -- nothing previously
 * stopped that, since `Check` and `Requirement` had no validated
 * relationship. A Check with no `requirementId`/`constraintId` is
 * unaffected: not every check needs to trace back to a requirement.
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
    requireNonNull: { type: "boolean", nullable: true },
    requirementId: {
      type: "string",
      nullable: true,
      description: "Optional: link this check to a Requirement. A numeric_comparison/bounds_check is cross-validated against the requirement's own declared value/unit/operator."
    },
    constraintId: {
      type: "string",
      nullable: true,
      description: "Optional: link this check to a Constraint. A numeric_comparison/bounds_check is cross-validated against the constraint's own declared value/unit."
    }
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

function optionalId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Cross-validates a `numeric_comparison`/`bounds_check`'s own declared
 * threshold against the `Requirement`/`Constraint` it claims to link to
 * (see this file's top doc comment). Other check kinds have no single
 * numeric threshold to compare and are left alone. Deliberately conservative:
 * only compares when the linked entity itself declares a numeric `value`
 * (a qualitative requirement like "must be easy to manufacture" has
 * `value: null` and is exempt, matching P18's own "not every requirement
 * is numeric" design).
 */
function validateCheckLinkage(state: WorldModelState, checkInput: CheckInput, requirementId: string | null, constraintId: string | null): void {
  let linkedValue: number | null = null;
  let linkedUnit: string | null = null;
  let linkedOperator: string | null = null;

  if (requirementId !== null) {
    const requirement: Requirement | undefined = state.project.requirements.find((candidate) => candidate.id === requirementId);
    if (!requirement) {
      throw new ToolError("invalid_input", `requirement_not_found: no requirement "${requirementId}" exists in the current project`);
    }
    if (typeof requirement.value === "number" && Number.isFinite(requirement.value)) {
      linkedValue = requirement.value;
      linkedUnit = requirement.unit;
      linkedOperator = typeof requirement.metadata.operator === "string" ? requirement.metadata.operator : null;
    }
  }

  if (constraintId !== null) {
    const constraint: Constraint | undefined = state.project.constraints.find((candidate) => candidate.id === constraintId);
    if (!constraint) {
      throw new ToolError("invalid_input", `constraint_not_found: no constraint "${constraintId}" exists in the current project`);
    }
    if (typeof constraint.value === "number" && Number.isFinite(constraint.value)) {
      // A requirement and a constraint disagreeing about the numeric value
      // to test is itself the same "invented goalpost" failure mode, so
      // both are checked against the SAME check rather than one silently
      // winning.
      linkedValue = linkedValue === null ? constraint.value : linkedValue;
      linkedUnit = linkedUnit === null ? constraint.unit : linkedUnit;
    }
  }

  if (linkedValue === null) return; // nothing numeric to cross-check against

  if (checkInput.kind === "numeric_comparison") {
    if (checkInput.expectedValue !== linkedValue) {
      throw new ToolError(
        "invalid_input",
        `check_requirement_mismatch: check expectedValue (${checkInput.expectedValue}) does not match the linked requirement/constraint's declared value (${linkedValue})`
      );
    }
    if (linkedOperator !== null && checkInput.operator !== linkedOperator) {
      throw new ToolError(
        "invalid_input",
        `check_requirement_mismatch: check operator (${checkInput.operator}) does not match the linked requirement's declared operator (${linkedOperator})`
      );
    }
    if (linkedUnit !== null && checkInput.expectedUnit !== null && checkInput.expectedUnit !== linkedUnit) {
      throw new ToolError(
        "invalid_input",
        `check_requirement_mismatch: check expectedUnit ("${checkInput.expectedUnit}") does not match the linked requirement/constraint's declared unit ("${linkedUnit}")`
      );
    }
  } else if (checkInput.kind === "bounds_check") {
    const withinMin = checkInput.min === null || checkInput.min === undefined || linkedValue >= checkInput.min;
    const withinMax = checkInput.max === null || checkInput.max === undefined || linkedValue <= checkInput.max;
    if (!withinMin || !withinMax) {
      throw new ToolError(
        "invalid_input",
        `check_requirement_mismatch: bounds [${checkInput.min ?? "-inf"}, ${checkInput.max ?? "+inf"}] do not contain the linked requirement/constraint's declared value (${linkedValue})`
      );
    }
    if (linkedUnit !== null && checkInput.unit !== null && checkInput.unit !== linkedUnit) {
      throw new ToolError(
        "invalid_input",
        `check_requirement_mismatch: check unit ("${checkInput.unit}") does not match the linked requirement/constraint's declared unit ("${linkedUnit}")`
      );
    }
  }
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

export function createCreateCheckTool(checkStore: CheckStore, getState: () => WorldModelState): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "create_check",
    description:
      "Defines a new, stable, reusable deterministic Check (a typed, allowlisted rule -- never an arbitrary expression) that run_verification can later evaluate against fresh evidence. Optionally link it to a Requirement/Constraint via requirementId/constraintId; a numeric check's threshold is then cross-validated against that entity's own declared value. Never mutates the World Model or the environment.",
    target: "verification",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const record = rawInput as Record<string, unknown>;
    const requirementId = optionalId(record.requirementId);
    const constraintId = optionalId(record.constraintId);
    const input = toCheckInput(rawInput);
    validateCheckLinkage(getState(), input, requirementId, constraintId);
    if (requirementId !== null || constraintId !== null) {
      input.metadata = { ...input.metadata, requirementId, constraintId };
    }
    const check: Check = createCheck(input);
    checkStore.save(check);
    return { check };
  };

  return { tool, handler };
}
