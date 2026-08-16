import { WorldModelValidationError, type Checkpoint } from "@naqsh/schemas";

/**
 * Deterministic, in-memory store for `Checkpoint` metadata records --
 * mirrors `ApprovalStore`'s exact shape (P4): a plain `Map` behind a typed
 * interface, no persistence infrastructure here by design (P2/P4/P15's
 * shared "expose the seam, not the infrastructure" precedent).
 *
 * IMMUTABLE BY CONSTRUCTION: there is no `update`/`delete` method on this
 * interface at all -- once `save()` succeeds, a `Checkpoint` can only ever
 * be read back exactly as it was written (Phase 15's explicit "Do NOT
 * allow update checkpoint contents after creation" requirement). `save`
 * refuses a duplicate id outright rather than silently overwriting, the
 * same discipline `ArtifactStore.put` and `ChangeHistory.append` already
 * apply to their own append-only data.
 */
export interface CheckpointStore {
  save(checkpoint: Checkpoint): void;
  getById(id: string): Checkpoint | undefined;
  list(): readonly Checkpoint[];
  listForProject(projectId: string): readonly Checkpoint[];
  serialize(): string;
}

export function createCheckpointStore(): CheckpointStore {
  const checkpoints = new Map<string, Checkpoint>();

  return {
    save(checkpoint) {
      if (checkpoints.has(checkpoint.id)) {
        throw new WorldModelValidationError("invalid_shape", `Checkpoint "${checkpoint.id}" already exists -- checkpoints are immutable once created`);
      }
      checkpoints.set(checkpoint.id, checkpoint);
    },
    getById: (id) => checkpoints.get(id),
    list: () => Array.from(checkpoints.values()),
    listForProject: (projectId) => Array.from(checkpoints.values()).filter((checkpoint) => checkpoint.projectId === projectId),
    serialize: () => JSON.stringify(Array.from(checkpoints.values()))
  };
}

/** Rebuilds a `CheckpointStore` from `serialize()`'s output -- each entry
 * is re-validated via `save()`'s own duplicate-id guard, matching
 * `deserializeChangeHistory`'s identical "never silently trust a
 * hand-edited/corrupted log" precedent. Individual `Checkpoint` shape
 * validation is NOT re-run here (each entry was already validated by
 * `createCheckpoint` before it was ever saved) -- a caller needing to
 * distrust the bytes themselves (e.g. reading from real persistence)
 * should validate with `assertCheckpoint` before calling this. */
export function deserializeCheckpointStore(serialized: string): CheckpointStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized checkpoint store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized checkpoint store must be an array");
  }
  const store = createCheckpointStore();
  for (const entry of parsed as Checkpoint[]) {
    store.save(entry);
  }
  return store;
}
