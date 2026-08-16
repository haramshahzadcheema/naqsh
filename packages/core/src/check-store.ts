import { WorldModelValidationError, type Check } from "@naqsh/schemas";

/**
 * Deterministic, in-memory store for `Check` records -- mirrors
 * `CheckpointStore`'s exact shape (P15), which itself mirrors
 * `ApprovalStore`'s (P4): a plain `Map` behind a typed interface, no
 * persistence infrastructure here by design.
 *
 * IMMUTABLE BY CONSTRUCTION: there is no `update`/`delete` method on this
 * interface -- once `save()` succeeds, a `Check`'s definition can never
 * change underneath a `VerificationResult` that already references its
 * `checkId`. If a check's definition needs to evolve, that is a new Check
 * with a new id, never an in-place edit -- the same discipline
 * `CheckpointStore` already applies to `Checkpoint`.
 */
export interface CheckStore {
  save(check: Check): void;
  getById(id: string): Check | undefined;
  list(): readonly Check[];
  serialize(): string;
}

export function createCheckStore(): CheckStore {
  const checks = new Map<string, Check>();

  return {
    save(check) {
      if (checks.has(check.id)) {
        throw new WorldModelValidationError("invalid_shape", `Check "${check.id}" already exists -- checks are immutable once created`);
      }
      checks.set(check.id, check);
    },
    getById: (id) => checks.get(id),
    list: () => Array.from(checks.values()),
    serialize: () => JSON.stringify(Array.from(checks.values()))
  };
}

/** Rebuilds a `CheckStore` from `serialize()`'s output, matching
 * `deserializeCheckpointStore`'s identical "never silently trust a
 * hand-edited/corrupted log" precedent. */
export function deserializeCheckStore(serialized: string): CheckStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized check store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized check store must be an array");
  }
  const store = createCheckStore();
  for (const entry of parsed as Check[]) {
    store.save(entry);
  }
  return store;
}
