import { WorldModelValidationError, type VerificationResult } from "@naqsh/schemas";

/**
 * Deterministic, in-memory, APPEND-ONLY store for `VerificationResult`
 * records -- mirrors `CheckpointStore`/`ChangeHistory`'s exact shape.
 * Every evaluation of a `Check` produces a NEW `VerificationResult`
 * (Phase 16 explicitly wants "verify, change something, verify again,
 * confirm the result changes" -- that only works if old results are never
 * overwritten, only added to), so this store never updates or deletes.
 *
 * `listForCheck` is what lets a future phase (P17's "combine multiple
 * verification results into objective satisfaction," named explicitly in
 * the P16 brief's Future Compatibility section) ask "every result ever
 * produced for check X" without this store's shape needing to change.
 */
export interface VerificationResultStore {
  save(result: VerificationResult): void;
  getById(id: string): VerificationResult | undefined;
  list(): readonly VerificationResult[];
  listForCheck(checkId: string): readonly VerificationResult[];
  listForProject(projectId: string): readonly VerificationResult[];
  serialize(): string;
}

export function createVerificationResultStore(): VerificationResultStore {
  const results = new Map<string, VerificationResult>();

  return {
    save(result) {
      if (results.has(result.id)) {
        throw new WorldModelValidationError("invalid_shape", `VerificationResult "${result.id}" already exists -- results are append-only`);
      }
      results.set(result.id, result);
    },
    getById: (id) => results.get(id),
    list: () => Array.from(results.values()),
    listForCheck: (checkId) => Array.from(results.values()).filter((result) => result.checkId === checkId),
    listForProject: (projectId) => Array.from(results.values()).filter((result) => result.projectId === projectId),
    serialize: () => JSON.stringify(Array.from(results.values()))
  };
}

export function deserializeVerificationResultStore(serialized: string): VerificationResultStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized verification result store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized verification result store must be an array");
  }
  const store = createVerificationResultStore();
  for (const entry of parsed as VerificationResult[]) {
    store.save(entry);
  }
  return store;
}
