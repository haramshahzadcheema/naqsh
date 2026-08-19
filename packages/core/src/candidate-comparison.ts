import { WorldModelValidationError, type Candidate, type CandidateStatus, type ExperimentStatus, type VerificationStatus, type WorldModelState } from "@naqsh/schemas";
import type { VerificationResultStore } from "./verification-result-store.js";

/**
 * Phase 22's COMPARISON half: turns a "candidate set" (candidates sharing
 * the same `(planId, planStepId)` -- see `candidate-types.ts`'s own doc
 * comment on why no separate grouping entity exists) into one STRUCTURED,
 * factual comparison -- which candidates, which requirements/constraints/
 * evidence each addresses, which experiments ran against each, and which
 * deterministic checks passed/failed.
 *
 * Deliberately NO scoring, ranking, weighting, "best candidate," or
 * pass/fail ROLLUP across a candidate's checks (P22 brief: "explicitly NO
 * scoring/ranking system -- that's P23"). A caller who wants "did candidate
 * A pass everything" reads `entry.experiments[].checks[].status` and draws
 * their OWN conclusion; this function never draws it for them. This is the
 * same restraint `objective-satisfaction.ts` (P17) already exercises for a
 * single experiment's checks, applied here one level up across MULTIPLE
 * candidates' experiments.
 *
 * Pure and side-effect-free: reads `state`/`verificationResultStore`,
 * writes to neither. `verificationResultStore` is OPTIONAL (mirrors
 * `validateCandidateSemantics`'s identical optional-dependency pattern) --
 * a caller comparing candidates before any verification has run yet still
 * gets a complete structural comparison, just with empty `checks` arrays.
 */

export interface CandidateComparisonCheckSummary {
  verificationResultId: string;
  checkId: string;
  checkKind: string;
  status: VerificationStatus;
}

export interface CandidateComparisonExperimentSummary {
  experimentId: string;
  status: ExperimentStatus;
  buildResultId: string | null;
  checkpointBeforeId: string | null;
  checkpointAfterId: string | null;
  checks: CandidateComparisonCheckSummary[];
}

export interface CandidateComparisonEntry {
  candidateId: string;
  hypothesis: string;
  rationale: string;
  status: CandidateStatus;
  designSpecificationId: string | null;
  proposalId: string | null;
  parentCandidateId: string | null;
  relevantRequirementIds: string[];
  relevantConstraintIds: string[];
  relevantResearchEvidenceIds: string[];
  assumptionIds: string[];
  experiments: CandidateComparisonExperimentSummary[];
}

export interface CandidateComparisonResult {
  planId: string;
  planStepId: string | null;
  candidates: CandidateComparisonEntry[];
}

export function compareCandidates(candidates: readonly Candidate[], state: WorldModelState, verificationResultStore?: VerificationResultStore): CandidateComparisonResult {
  if (candidates.length === 0) {
    throw new WorldModelValidationError("invalid_shape", "compareCandidates requires at least one candidate");
  }

  const planId = candidates[0]!.planId;
  const planStepId = candidates[0]!.planStepId;
  for (const candidate of candidates) {
    if (candidate.planId !== planId || candidate.planStepId !== planStepId) {
      throw new WorldModelValidationError(
        "invalid_shape",
        `compareCandidates requires every candidate to share the same (planId, planStepId) -- candidate "${candidate.id}" is (${candidate.planId}, ${candidate.planStepId}), not (${planId}, ${planStepId})`
      );
    }
  }

  const entries: CandidateComparisonEntry[] = candidates.map((candidate) => {
    const experiments = state.project.experiments
      .filter((experiment) => experiment.candidateId === candidate.id)
      .map((experiment) => {
        const checks: CandidateComparisonCheckSummary[] = experiment.verificationResultIds
          .map((verificationResultId) => verificationResultStore?.getById(verificationResultId))
          .filter((result): result is NonNullable<typeof result> => result !== undefined)
          .map((result) => ({ verificationResultId: result.id, checkId: result.checkId, checkKind: result.checkKind, status: result.status }));

        return {
          experimentId: experiment.id,
          status: experiment.status,
          buildResultId: experiment.buildResultId,
          checkpointBeforeId: experiment.checkpointBeforeId,
          checkpointAfterId: experiment.checkpointAfterId,
          checks
        };
      });

    return {
      candidateId: candidate.id,
      hypothesis: candidate.hypothesis,
      rationale: candidate.rationale,
      status: candidate.status,
      designSpecificationId: candidate.designSpecificationId,
      proposalId: candidate.proposalId,
      parentCandidateId: candidate.parentCandidateId,
      relevantRequirementIds: candidate.relevantRequirementIds,
      relevantConstraintIds: candidate.relevantConstraintIds,
      relevantResearchEvidenceIds: candidate.relevantResearchEvidenceIds,
      assumptionIds: candidate.assumptionIds,
      experiments
    };
  });

  return { planId, planStepId, candidates: entries };
}
