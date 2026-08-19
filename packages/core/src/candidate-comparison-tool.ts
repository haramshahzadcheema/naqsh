import { createTool, ToolError, WorldModelValidationError, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { CandidateStore } from "./candidate-store.js";
import type { VerificationResultStore } from "./verification-result-store.js";
import { compareCandidates } from "./candidate-comparison.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 22's read-only comparison TOOL -- the agent-facing wrapper around
 * `compareCandidates` (core function), mirroring `observe_project`'s (P8)
 * exact shape and reasoning: `mutation: "observe"`, no write path at all,
 * nothing for a future `authorize` hook to gate beyond the classification
 * itself.
 *
 * Deliberately takes `candidateIds` (explicit, caller-chosen), not
 * `planId`/`planStepId` -- resolving "the candidate set for this
 * plan/step" is `CandidateStore.listForPlanStep`'s job, one layer below
 * this tool; a caller (agent or UI) that already has that list passes the
 * ids it cares about, which also lets it compare a DELIBERATE subset (e.g.
 * "only the two candidates that actually got built") rather than always
 * the full set.
 */

const checkArraySchema: ToolValueSchema = {
  type: "array",
  items: { type: "object", properties: {}, additionalProperties: true }
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    planId: { type: "string" },
    planStepId: { type: "string", nullable: true },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          hypothesis: { type: "string" },
          rationale: { type: "string" },
          status: { type: "string" },
          designSpecificationId: { type: "string", nullable: true },
          proposalId: { type: "string", nullable: true },
          parentCandidateId: { type: "string", nullable: true },
          relevantRequirementIds: { type: "array", items: { type: "string" } },
          relevantConstraintIds: { type: "array", items: { type: "string" } },
          relevantResearchEvidenceIds: { type: "array", items: { type: "string" } },
          assumptionIds: { type: "array", items: { type: "string" } },
          experiments: checkArraySchema
        },
        additionalProperties: true
      }
    }
  },
  required: ["planId", "planStepId", "candidates"]
};

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    candidateIds: { type: "array", items: { type: "string" }, description: "Ids of the Candidates (must share the same planId/planStepId) to compare." }
  },
  required: ["candidateIds"]
};

function toCandidateIds(input: unknown): string[] {
  const record = input as { candidateIds?: unknown };
  if (!Array.isArray(record.candidateIds) || record.candidateIds.length === 0 || !record.candidateIds.every((id) => typeof id === "string" && id.trim().length > 0)) {
    throw new ToolError("invalid_input", "candidateIds is required and must be a non-empty array of non-empty strings");
  }
  return record.candidateIds;
}

export function createCompareCandidatesTool(
  candidateStore: CandidateStore,
  getState: () => WorldModelState,
  verificationResultStore?: VerificationResultStore
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "compare_candidates",
    description:
      "Produces a structured, factual comparison of a set of Candidates that share the same Plan/PlanStep: their hypotheses, which requirements/constraints/research evidence each addresses, and which experiments/checks ran against each. Never scores, ranks, or declares a winner -- that is a later phase's job.",
    target: "world_model",
    mutation: "observe",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const candidateIds = toCandidateIds(rawInput);
    const candidates = candidateIds.map((id) => {
      const candidate = candidateStore.getById(id);
      if (!candidate) {
        throw new ToolError("invalid_input", `candidate_not_found: no candidate "${id}" exists`);
      }
      return candidate;
    });

    try {
      return compareCandidates(candidates, getState(), verificationResultStore);
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", error.message);
      }
      throw error;
    }
  };

  return { tool, handler };
}
