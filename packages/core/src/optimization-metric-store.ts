import { createCandidateMetricValue, WorldModelValidationError, type CandidateMetricValue } from "@naqsh/schemas";

/**
 * Deterministic, in-memory, APPEND-ONLY store for `CandidateMetricValue`
 * records (P23) -- mirrors `VerificationResultStore`/`BuildResultStore`'s
 * exact "never overwrite, only add a new one" discipline, not
 * `CandidateStore`'s single-save-per-id immutability: a candidate's mass
 * genuinely CAN be re-measured or refined from an "estimated" figure into a
 * real "measured" one over time, and the OLD record must remain a real
 * historical fact, never silently replaced. Multiple records can and do
 * coexist for the SAME `(candidateId, metricKey)` pair; resolving "which one
 * counts right now" (most recent by `measuredAt`, deterministically
 * tie-broken) is `optimization-engine.ts`'s job -- this store stays a plain
 * query surface, mirroring `compareCandidates`'s (P22) own "read-time join,
 * not write-time aggregation" precedent.
 */
export interface CandidateMetricValueStore {
  save(metricValue: CandidateMetricValue): void;
  getById(id: string): CandidateMetricValue | undefined;
  list(): readonly CandidateMetricValue[];
  listForCandidate(candidateId: string): readonly CandidateMetricValue[];
  serialize(): string;
}

export function createCandidateMetricValueStore(): CandidateMetricValueStore {
  const metricValues = new Map<string, CandidateMetricValue>();

  return {
    save(metricValue) {
      if (metricValues.has(metricValue.id)) {
        throw new WorldModelValidationError("invalid_shape", `CandidateMetricValue "${metricValue.id}" already exists -- metric values are append-only`);
      }
      metricValues.set(metricValue.id, metricValue);
    },
    getById: (id) => metricValues.get(id),
    list: () => Array.from(metricValues.values()),
    listForCandidate: (candidateId) => Array.from(metricValues.values()).filter((metricValue) => metricValue.candidateId === candidateId),
    serialize: () => JSON.stringify(Array.from(metricValues.values()))
  };
}

/** Rebuilds a `CandidateMetricValueStore` from `serialize()`'s output,
 * matching `deserializeCandidateStore`'s identical "never silently trust a
 * hand-edited/corrupted log" precedent. */
export function deserializeCandidateMetricValueStore(serialized: string): CandidateMetricValueStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized candidate metric value store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized candidate metric value store must be an array");
  }
  const store = createCandidateMetricValueStore();
  for (const entry of parsed as CandidateMetricValue[]) {
    store.save(createCandidateMetricValue(entry));
  }
  return store;
}
