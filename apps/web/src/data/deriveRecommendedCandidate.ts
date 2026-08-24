import type { Candidate, Experiment } from "@naqsh/schemas";

/**
 * The "recommended" candidate a comparison view highlights -- the most
 * recently created candidate with at least one COMPLETE experiment, real
 * data only. Mirrors `chat/useChatThreads.ts`'s `currentDesignSummary`
 * derivation (same "latest successful experiment's candidate" rule),
 * rather than a hardcoded id that only ever matched the seeded demo's own
 * candidate set. Returns `null` when nothing qualifies yet -- both
 * `CandidateComparison` and `ExperimentsView` already treat that as "don't
 * highlight anything," never a crash or a silent wrong guess.
 */
export function deriveRecommendedCandidateId(candidates: Candidate[], experiments: Experiment[]): string | null {
  const successfulCandidateIds = new Set(experiments.filter((experiment) => experiment.status === "complete").map((experiment) => experiment.candidateId));
  const successfulCandidates = candidates.filter((candidate) => successfulCandidateIds.has(candidate.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return successfulCandidates[0]?.id ?? null;
}
