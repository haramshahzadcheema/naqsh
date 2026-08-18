import { createRequirementCandidate, createTool, ToolError, type ModelRequestConfigInput, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { ModelProvider } from "./model-provider.js";
import { interpretRequirementFromText } from "./requirement-interpreter.js";
import type { ClarificationStore } from "./clarification-store.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 19's ANSWER half: takes a user's answer to a pending
 * `Clarification` and re-derives a fresh, specific `RequirementCandidate`
 * -- WITHOUT ever directly mutating the `Clarification`'s `answerText`
 * from untrusted input, and WITHOUT touching `WorldModelState`.
 *
 * Re-interpretation reuses `interpretRequirementFromText` (P18)
 * COMPLETELY UNCHANGED -- the same Gemini-bounded, schema-validated
 * pipeline that already governs every other natural-language interpretation
 * in this codebase. The statement fed to it is FOCUSED: the clarification's
 * own `question` plus the user's `answerText`, e.g. "What load must it
 * withstand, and in which direction? Answer: 500 N vertically." -- never
 * the full, possibly-compound original statement. This deliberately keeps
 * each answered clarification independent: "make it lightweight and
 * strong" can raise TWO clarifications (mass, load) and each is answered
 * -- and re-interpreted -- on its own, without one answer needing to also
 * address the other's gap.
 *
 * If the resulting candidate is STILL `"ambiguous"` (e.g. the user answered
 * "banana" to a numeric question), the answer did not actually resolve
 * anything: this handler throws `ToolError("invalid_input", "answer_insufficient: ...")`
 * and leaves the `Clarification` untouched (still "pending", no
 * `answerText` persisted) -- exactly the same "never silently promote
 * ambiguous to specific" discipline `assertRequirementCandidate` already
 * enforces one layer down. Only on a genuinely specific result does
 * `ClarificationStore.answer` record the transition.
 *
 * PROVENANCE: the returned candidate's `metadata` carries
 * `resolvedClarificationId`/`originalRequirementCandidateId`/
 * `originalStatementText` -- so a caller can trace the final candidate
 * back through the clarification to the ORIGINAL compound statement,
 * without needing the original text to be re-parsed (Step 12/18's own
 * traceability requirement).
 *
 * CROSS-PROJECT ISOLATION (external audit finding, applied proactively
 * here): rejects a `clarificationId` whose embedded `candidateSnapshot`
 * belongs to a DIFFERENT project than `getState()`'s current one --
 * exactly the same isolation gap the P17 audit found in
 * `evaluateObjectiveSatisfaction` and the `create_check` linkage fix
 * closed, applied here before it could be found the same way twice more.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    clarificationId: { type: "string" },
    answerText: { type: "string", description: "The user's raw answer, verbatim -- treated as text input, never executed." },
    modelId: { type: "string", description: "Which model to use for re-interpretation." }
  },
  required: ["clarificationId", "answerText", "modelId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    clarification: { type: "object", properties: {}, additionalProperties: true },
    updatedCandidate: { type: "object", properties: {}, additionalProperties: true }
  },
  required: ["clarification", "updatedCandidate"]
};

function toAnswerInput(rawInput: unknown): { clarificationId: string; answerText: string; config: ModelRequestConfigInput } {
  const record = rawInput as { clarificationId?: unknown; answerText?: unknown; modelId?: unknown };
  if (typeof record.clarificationId !== "string" || record.clarificationId.trim().length === 0) {
    throw new ToolError("invalid_input", "clarificationId is required and must be a non-empty string");
  }
  if (typeof record.answerText !== "string" || record.answerText.trim().length === 0) {
    throw new ToolError("invalid_input", "answerText is required and must be a non-empty string");
  }
  if (typeof record.modelId !== "string" || record.modelId.trim().length === 0) {
    throw new ToolError("invalid_input", "modelId is required and must be a non-empty string");
  }
  return { clarificationId: record.clarificationId, answerText: record.answerText, config: { modelId: record.modelId } };
}

export function createAnswerClarificationTool(
  getState: () => WorldModelState,
  provider: ModelProvider,
  clarificationStore: ClarificationStore
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "answer_clarification",
    description:
      "Records a user's answer to a pending Clarification (P19) and re-interprets the clarification's own question + answer (via the existing P18 interpretation pipeline, unchanged) into a fresh, specific RequirementCandidate. Rejects an answer that does not actually resolve the ambiguity -- the clarification remains pending, nothing is recorded. Never mutates the World Model; the resulting candidate still requires add_requirement (P18) to become a real Requirement.",
    target: "world_model",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const { clarificationId, answerText, config } = toAnswerInput(rawInput);

    const clarification = clarificationStore.getById(clarificationId);
    if (!clarification) {
      throw new ToolError("invalid_input", `not_found: no clarification with id "${clarificationId}" exists`);
    }
    if (clarification.status !== "pending") {
      throw new ToolError("invalid_input", `clarification "${clarificationId}" is already "${clarification.status}", cannot answer it again`);
    }
    const state = getState();
    if (clarification.candidateSnapshot.projectId !== state.project.id) {
      throw new ToolError(
        "invalid_input",
        `cross_project_forbidden: clarification "${clarificationId}" belongs to project "${clarification.candidateSnapshot.projectId}", not the current project "${state.project.id}"`
      );
    }

    const focusedStatement = `${clarification.question} Answer: ${answerText}`;
    const result = await interpretRequirementFromText(provider, state, focusedStatement, { config });

    if (result.status === "error") {
      const toolErrorKind = result.error.kind === "invalid_input" ? "invalid_input" : result.error.kind === "model_unavailable" ? "unavailable" : "execution_failure";
      throw new ToolError(toolErrorKind, result.error.message);
    }

    if (result.candidate.interpretationStatus === "ambiguous") {
      throw new ToolError(
        "invalid_input",
        `answer_insufficient: the answer "${answerText}" did not resolve the ambiguity (${result.candidate.ambiguityReason}) -- the clarification remains pending`
      );
    }

    const updatedClarification = clarificationStore.answer(clarificationId, answerText);

    const updatedCandidate = createRequirementCandidate({
      ...result.candidate,
      metadata: {
        resolvedClarificationId: clarification.id,
        originalRequirementCandidateId: clarification.requirementCandidateId,
        originalStatementText: clarification.candidateSnapshot.statementText
      }
    });

    return { clarification: updatedClarification, updatedCandidate };
  };

  return { tool, handler };
}
