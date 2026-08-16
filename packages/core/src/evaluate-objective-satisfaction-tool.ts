import { createTool, ToolError, type Tool, type ToolValueSchema, type VerificationResult, type WorldModelState } from "@naqsh/schemas";
import type { VerificationResultStore } from "./verification-result-store.js";
import type { ObjectiveSatisfactionStore } from "./objective-satisfaction-store.js";
import { evaluateObjectiveSatisfaction, type ResolvedObjectiveCondition } from "./objective-satisfaction.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 17's RESOLUTION half: looks up the `VerificationResult` (P16)
 * backing each supplied condition -- from a caller-pinned
 * `verificationResultId`, or otherwise the MOST RECENT result for that
 * `checkId` (`VerificationResultStore.listForCheck`'s own insertion order,
 * matching "verify, change something, verify again" always meaning "use
 * the freshest evidence") -- hands the resolved conditions to the PURE
 * `evaluateObjectiveSatisfaction` (objective-satisfaction.ts), and
 * persists the result. Never re-checks geometry or duplicates verification
 * logic; this only AGGREGATES what P16 already produced.
 *
 * Classified `mutation: "verify"` -- the same classification
 * `run_verification` uses, for an identical reason (Phase 17 is a
 * continuation of the deterministic verification pipeline one level up,
 * not a new mutation). Never touches the World Model or the environment;
 * only reads `WorldModelState` (for `objectiveSummary`/`projectVersion`/
 * hard-constraint lookup) and persists a new, independent
 * `ObjectiveSatisfactionResult`.
 *
 * HARD CONSTRAINTS CANNOT BE MARKED OPTIONAL (Phase 17's own "violated
 * hard constraint -> NOT_SATISFIED, always" requirement): if a condition
 * names a `constraintId` that resolves to a real `Constraint` with
 * `severity: "hard"`, and the caller explicitly passed `required: false`
 * for it, this is rejected outright -- never silently overridden, never
 * silently accepted. A caller who doesn't specify `required` at all gets
 * the correct default (`true`) for free, since that already matches a hard
 * constraint's own requirement.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    conditions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          checkId: { type: "string" },
          requirementId: { type: "string", nullable: true },
          constraintId: { type: "string", nullable: true },
          required: { type: "boolean", nullable: true, description: "AND-composed (true, default) or OR-composed (false)." },
          verificationResultId: { type: "string", nullable: true, description: "Pin an exact VerificationResult; omit to use the most recent one for checkId." }
        },
        required: ["checkId"]
      }
    }
  },
  required: ["conditions"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { result: { type: "object", properties: {}, additionalProperties: true } },
  required: ["result"]
};

interface EvaluateObjectiveSatisfactionInput {
  conditions: Array<{
    checkId: string;
    requirementId: string | null;
    constraintId: string | null;
    required?: boolean;
    verificationResultId: string | null;
  }>;
}

function toInput(rawInput: unknown): EvaluateObjectiveSatisfactionInput {
  const record = rawInput as { conditions?: unknown };
  if (!Array.isArray(record.conditions)) {
    throw new ToolError("invalid_input", "conditions is required and must be an array");
  }
  const conditions = record.conditions.map((entry, index) => {
    const item = entry as Record<string, unknown>;
    if (typeof item.checkId !== "string" || item.checkId.trim().length === 0) {
      throw new ToolError("invalid_input", `conditions[${index}].checkId is required and must be a non-empty string`);
    }
    if (item.required !== undefined && typeof item.required !== "boolean") {
      throw new ToolError("invalid_input", `conditions[${index}].required must be a boolean if provided`);
    }
    return {
      checkId: item.checkId,
      requirementId: typeof item.requirementId === "string" ? item.requirementId : null,
      constraintId: typeof item.constraintId === "string" ? item.constraintId : null,
      required: typeof item.required === "boolean" ? item.required : undefined,
      verificationResultId: typeof item.verificationResultId === "string" ? item.verificationResultId : null
    };
  });
  return { conditions };
}

export function createEvaluateObjectiveSatisfactionTool(
  getState: () => WorldModelState,
  verificationResultStore: VerificationResultStore,
  objectiveSatisfactionStore: ObjectiveSatisfactionStore
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "evaluate_objective_satisfaction",
    description:
      "Deterministically aggregates existing VerificationResults (P16) into an overall SATISFIED / NOT_SATISFIED / INCONCLUSIVE verdict for the project's objective -- never Gemini's judgment, never inferred from a tool's own reported success. Never re-checks geometry; only combines results P16 already produced. Read-only against the World Model and the environment; persists a new, immutable ObjectiveSatisfactionResult.",
    target: "verification",
    mutation: "verify",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const input = toInput(rawInput);
    const state = getState();

    const resolved: ResolvedObjectiveCondition[] = input.conditions.map((condition) => {
      let required = condition.required;

      if (condition.constraintId !== null) {
        const constraint = state.project.constraints.find((candidate) => candidate.id === condition.constraintId);
        if (constraint && constraint.severity === "hard") {
          if (required === false) {
            throw new ToolError(
              "invalid_input",
              `hard_constraint_cannot_be_optional: constraint "${condition.constraintId}" is a hard constraint and can never be marked required: false`
            );
          }
          required = true;
        }
      }

      let verificationResult: VerificationResult | null = null;
      if (condition.verificationResultId !== null) {
        verificationResult = verificationResultStore.getById(condition.verificationResultId) ?? null;
      } else {
        const history = verificationResultStore.listForCheck(condition.checkId);
        verificationResult = history.length > 0 ? history[history.length - 1]! : null;
      }

      return {
        checkId: condition.checkId,
        requirementId: condition.requirementId,
        constraintId: condition.constraintId,
        required,
        verificationResult
      };
    });

    const result = evaluateObjectiveSatisfaction(resolved, {
      projectId: state.project.id,
      projectVersion: state.project.version,
      objectiveSummary: state.project.objective.summary || null
    });

    objectiveSatisfactionStore.save(result);

    return { result };
  };

  return { tool, handler };
}
