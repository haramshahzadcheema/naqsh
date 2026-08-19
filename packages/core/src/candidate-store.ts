import { createCandidate, WorldModelValidationError, type Candidate } from "@naqsh/schemas";

/**
 * Deterministic, in-memory store for `Candidate` records (P22) -- mirrors
 * `DesignSpecificationStore`'s exact shape: a plain `Map` behind a typed
 * interface, IMMUTABLE BY CONSTRUCTION (no `update`/`delete` method exists
 * on this interface).
 *
 * `listChildren`, not a "revision chain": unlike `DesignSpecification`'s
 * strict linear `supersedesDesignSpecificationId` chain (v1 -> v2 -> v3,
 * each one REPLACING the last), `Candidate.parentCandidateId` records
 * LINEAGE among coexisting ALTERNATIVES -- several candidates can share
 * the same parent (candidate D and candidate E might both be refinements
 * of candidate A), forming a tree, not a line. A single "chain" walk would
 * misrepresent that shape; `listChildren` (direct children only) is the
 * honest primitive, and a caller who wants the full tree can walk it
 * recursively from there.
 *
 * NOT part of `WorldModelState` -- a `Candidate` is a process/candidate
 * record describing a PROPOSED alternative, exactly like `DesignSpecification`/
 * `Plan`/`Proposal` are not part of `WorldModelState` either (see
 * `candidate-types.ts`'s own doc comment for the full reasoning). The one
 * canonical project state remains `WorldModelState`; this store no more
 * competes with it than `DesignSpecificationStore`/`CheckStore` do.
 */
export interface CandidateStore {
  save(candidate: Candidate): void;
  getById(id: string): Candidate | undefined;
  listForPlan(planId: string): readonly Candidate[];
  listForPlanStep(planId: string, planStepId: string | null): readonly Candidate[];
  listChildren(parentCandidateId: string): readonly Candidate[];
  list(): readonly Candidate[];
  serialize(): string;
}

export function createCandidateStore(): CandidateStore {
  const candidates = new Map<string, Candidate>();

  return {
    save(candidate) {
      if (candidates.has(candidate.id)) {
        throw new WorldModelValidationError("invalid_shape", `Candidate "${candidate.id}" already exists -- candidates are immutable once created`);
      }
      candidates.set(candidate.id, candidate);
    },
    getById: (id) => candidates.get(id),
    listForPlan: (planId) => Array.from(candidates.values()).filter((candidate) => candidate.planId === planId),
    listForPlanStep: (planId, planStepId) =>
      Array.from(candidates.values()).filter((candidate) => candidate.planId === planId && candidate.planStepId === planStepId),
    listChildren: (parentCandidateId) => Array.from(candidates.values()).filter((candidate) => candidate.parentCandidateId === parentCandidateId),
    list: () => Array.from(candidates.values()),
    serialize: () => JSON.stringify(Array.from(candidates.values()))
  };
}

/** Rebuilds a `CandidateStore` from `serialize()`'s output, matching
 * `deserializeDesignSpecificationStore`'s identical "never silently trust a
 * hand-edited/corrupted log" precedent. */
export function deserializeCandidateStore(serialized: string): CandidateStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized candidate store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized candidate store must be an array");
  }
  const store = createCandidateStore();
  for (const entry of parsed as Candidate[]) {
    store.save(createCandidate(entry));
  }
  return store;
}
