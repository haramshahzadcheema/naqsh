import { WorldModelValidationError, type ObjectiveSatisfactionResult } from "@naqsh/schemas";

/**
 * Deterministic, in-memory, APPEND-ONLY store for `ObjectiveSatisfactionResult`
 * records -- mirrors `VerificationResultStore`'s exact shape (P16), which
 * itself mirrors `CheckpointStore`/`ChangeHistory`'s (P4/P15). Every
 * evaluation produces a NEW record; old ones are never overwritten, so a
 * result computed against project version 3 remains a truthful record of
 * "satisfied at V3" even after the project moves on to V4 -- exactly
 * Phase 17's "distinguish 'was satisfied at V42' from 'is satisfied now'"
 * requirement.
 */
export interface ObjectiveSatisfactionStore {
  save(result: ObjectiveSatisfactionResult): void;
  getById(id: string): ObjectiveSatisfactionResult | undefined;
  list(): readonly ObjectiveSatisfactionResult[];
  listForProject(projectId: string): readonly ObjectiveSatisfactionResult[];
  serialize(): string;
}

export function createObjectiveSatisfactionStore(): ObjectiveSatisfactionStore {
  const results = new Map<string, ObjectiveSatisfactionResult>();

  return {
    save(result) {
      if (results.has(result.id)) {
        throw new WorldModelValidationError("invalid_shape", `ObjectiveSatisfactionResult "${result.id}" already exists -- results are append-only`);
      }
      results.set(result.id, result);
    },
    getById: (id) => results.get(id),
    list: () => Array.from(results.values()),
    listForProject: (projectId) => Array.from(results.values()).filter((result) => result.projectId === projectId),
    serialize: () => JSON.stringify(Array.from(results.values()))
  };
}

export function deserializeObjectiveSatisfactionStore(serialized: string): ObjectiveSatisfactionStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized objective satisfaction store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized objective satisfaction store must be an array");
  }
  const store = createObjectiveSatisfactionStore();
  for (const entry of parsed as ObjectiveSatisfactionResult[]) {
    store.save(entry);
  }
  return store;
}
