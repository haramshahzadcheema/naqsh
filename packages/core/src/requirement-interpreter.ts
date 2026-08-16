import {
  createModelContext,
  createModelRequest,
  createRequirementCandidate,
  NUMERIC_COMPARISON_OPERATORS,
  type ModelContext,
  type ModelRequestConfigInput,
  type NumericComparisonOperator,
  type RequirementCandidate,
  type RequirementInterpretationErrorKind,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import type { ModelProvider } from "./model-provider.js";

/**
 * Natural language -> RequirementCandidate (P18).
 *
 * The core flow this file implements is:
 *
 *   user text -> ModelRequest -> ModelProvider.generate() -> structured
 *   candidate -> shape validation -> RequirementCandidate
 *
 * NEVER `text -> Requirement`: `interpretRequirementFromText` produces a
 * `RequirementCandidate` (a description of a POSSIBLE requirement) and
 * stops there -- nothing in this file, and nothing that constructs a
 * `RequirementCandidate`, imports `updateWorldModel`, `ChangeHistory`,
 * `recordTransition`, `executeTool`, `invokeRegisteredTool`, an
 * `EnvironmentAdapter`, or `@naqsh/adapters`. Interpreting text cannot
 * mutate `WorldModelState` and cannot execute anything because nothing in
 * this file ever holds a reference to anything that could -- enforced as
 * repo-boundaries regression tests, mirroring P9/P10's identical guards.
 *
 * Gemini's output is never automatically authoritative -- the identical
 * discipline `generateProposal` (P10) already established, applied to
 * requirements: the model is instructed, in the strongest terms, to report
 * `interpretationStatus: "ambiguous"` rather than invent a numeric
 * threshold the user's statement doesn't support. That instruction alone
 * is not trusted, either -- `createRequirementCandidate` (schemas)
 * independently STRIPS any operator/value/unit the model attached to an
 * "ambiguous" candidate regardless of what it claimed, and REJECTS a
 * "specific" candidate that names an operator without a value. The
 * validator is authoritative over the model's output, not the other way
 * around.
 */

const REQUIREMENT_SYSTEM_INSTRUCTION =
  "You are NAQSH's engineering requirement interpreter. Given ONE natural-language statement from a user, you " +
  "produce a structured candidate requirement. Rules that must never be broken: " +
  "(1) If the statement gives an explicit, specific numeric value and unit (e.g. '500 N', '2 kg', '50 mm apart'), " +
  "extract them exactly as stated -- do not round, do not estimate, do not convert units, do not add a safety " +
  "margin the user never mentioned. " +
  "(2) A requirement does not need to be numeric to be specific: if the statement is qualitative but still gives " +
  "a clear, concrete criterion (e.g. 'must be corrosion resistant', 'should use standard M6 fasteners', 'must be " +
  "easy to manufacture'), set interpretationStatus to 'specific' with operator/value/unit all null. " +
  "(3) If the statement is vague, subjective, or does not give you enough information to state a concrete " +
  "criterion (e.g. 'make it lightweight', 'it should be strong enough', 'make it good', 'make it better'), you " +
  "MUST set interpretationStatus to 'ambiguous', explain specifically what is missing in ambiguityReason, and " +
  "leave operator/value/unit null. Inventing a plausible-sounding numeric threshold for a vague statement is the " +
  "single most serious violation of these rules -- when genuinely uncertain, always choose 'ambiguous'. " +
  "(4) category must be a short, general classification (e.g. 'load', 'mass', 'dimension', 'manufacturability', " +
  "'material'), never a full sentence. " +
  "(5) operator, when present, must be exactly one of: " +
  NUMERIC_COMPARISON_OPERATORS.join(", ") +
  ". " +
  "(6) If the statement gives a bare number with no unit (e.g. 'it must support at least 500'), do NOT invent a " +
  "plausible unit -- either leave unit null if the number is still a meaningful criterion on its own (e.g. a " +
  "count), or set interpretationStatus to 'ambiguous' if the missing unit makes the number unusable. Never guess " +
  "N, kg, mm, or any other unit the statement did not state. " +
  "(7) If the statement gives a number but does not make the comparison direction clear (no 'at least', 'at " +
  "most', 'no more than', 'exactly', or equivalent), do not guess an operator -- set interpretationStatus to " +
  "'ambiguous' and explain that the comparison direction is unclear, rather than assuming >=, <=, or ==.";

const requirementOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    description: { type: "string", description: "A restated, structured description of the requirement." },
    category: { type: "string" },
    interpretationStatus: { type: "string", enum: ["specific", "ambiguous"] },
    operator: { type: "string", nullable: true, enum: [...NUMERIC_COMPARISON_OPERATORS] },
    value: { type: "number", nullable: true },
    unit: { type: "string", nullable: true },
    ambiguityReason: { type: "string", nullable: true },
    priority: { type: "string", nullable: true, enum: ["low", "medium", "high"] }
  },
  required: ["description", "category", "interpretationStatus", "operator", "value", "unit", "ambiguityReason"],
  additionalProperties: false
};

interface RawRequirementOutput {
  description: string;
  category: string;
  interpretationStatus: "specific" | "ambiguous";
  operator: NumericComparisonOperator | null;
  value: number | null;
  unit: string | null;
  ambiguityReason: string | null;
  priority?: string | null;
}

function isNumericComparisonOperatorValue(value: unknown): value is NumericComparisonOperator {
  return typeof value === "string" && (NUMERIC_COMPARISON_OPERATORS as readonly string[]).includes(value);
}

function isRawRequirementOutput(value: unknown): value is RawRequirementOutput {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.description === "string" &&
    typeof record.category === "string" &&
    (record.interpretationStatus === "specific" || record.interpretationStatus === "ambiguous") &&
    (record.operator === null || isNumericComparisonOperatorValue(record.operator)) &&
    (record.value === null || typeof record.value === "number") &&
    (record.unit === null || typeof record.unit === "string") &&
    (record.ambiguityReason === null || typeof record.ambiguityReason === "string")
  );
}

function buildRequirementModelContext(state: WorldModelState): ModelContext {
  return createModelContext({
    projectId: state.project.id,
    projectName: state.project.name,
    objectiveSummary: state.project.objective.summary || null,
    requirementCount: state.project.requirements.length,
    constraintCount: state.project.constraints.length
  });
}

export interface InterpretRequirementOptions {
  config: ModelRequestConfigInput;
  sessionId?: string | null;
}

export type RequirementInterpretationResult =
  | { status: "success"; candidate: RequirementCandidate }
  | { status: "error"; error: { kind: RequirementInterpretationErrorKind; message: string } };

/**
 * ONE natural-language statement + the current `WorldModelState` -> a
 * validated `RequirementCandidate`. Never throws for an expected failure
 * mode -- the same discipline `generateProposal`/`generatePlanProposal`
 * already established: a caller branches on `result.status`, never wraps
 * this in try/catch.
 */
export async function interpretRequirementFromText(
  provider: ModelProvider,
  state: WorldModelState,
  statementText: string,
  options: InterpretRequirementOptions
): Promise<RequirementInterpretationResult> {
  if (typeof statementText !== "string" || statementText.trim().length === 0) {
    return { status: "error", error: { kind: "invalid_input", message: "statementText is required and must be a non-empty string" } };
  }

  let request;
  try {
    request = createModelRequest({
      systemInstruction: REQUIREMENT_SYSTEM_INSTRUCTION,
      context: buildRequirementModelContext(state),
      instruction: `User statement: "${statementText}"\n\nInterpret this statement as a candidate engineering requirement.`,
      outputSchema: requirementOutputSchema,
      config: options.config,
      sessionId: options.sessionId ?? null
    });
  } catch (error) {
    return { status: "error", error: { kind: "invalid_input", message: error instanceof Error ? error.message : String(error) } };
  }

  const invocation = await provider.generate(request);
  if (invocation.status === "error" || !invocation.response) {
    return {
      status: "error",
      error: { kind: "model_unavailable", message: invocation.error?.message ?? "Model provider returned no response" }
    };
  }

  const response = invocation.response;
  if (response.kind !== "structured_result" || !isRawRequirementOutput(response.structuredResult)) {
    return {
      status: "error",
      error: { kind: "invalid_model_output", message: `Expected a structured requirement result, got response kind "${response.kind}"` }
    };
  }

  const raw: RawRequirementOutput = response.structuredResult;

  let candidate: RequirementCandidate;
  try {
    candidate = createRequirementCandidate({
      projectId: state.project.id,
      projectVersion: state.project.version,
      statementText,
      description: raw.description,
      category: raw.category,
      interpretationStatus: raw.interpretationStatus,
      operator: raw.operator,
      value: raw.value,
      unit: raw.unit,
      ambiguityReason: raw.ambiguityReason,
      priority: raw.priority === "low" || raw.priority === "medium" || raw.priority === "high" ? raw.priority : undefined,
      source: "agent"
    });
  } catch (error) {
    return { status: "error", error: { kind: "malformed_candidate_shape", message: error instanceof Error ? error.message : String(error) } };
  }

  return { status: "success", candidate };
}
