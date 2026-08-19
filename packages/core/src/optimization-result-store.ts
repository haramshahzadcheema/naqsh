import { createOptimizationResult, WorldModelValidationError, type OptimizationResult } from "@naqsh/schemas";

/**
 * Deterministic, in-memory, APPEND-ONLY store for `OptimizationResult`
 * records (P23) -- mirrors `VerificationResultStore`/`BuildResultStore`'s
 * exact shape. Every run of `run_optimization` produces a NEW, immutable
 * result; nothing here ever updates or deletes one, matching the same
 * "reproducibility/audit trail" discipline P16/P20 already established.
 */
export interface OptimizationResultStore {
  save(result: OptimizationResult): void;
  getById(id: string): OptimizationResult | undefined;
  list(): readonly OptimizationResult[];
  listForProblem(problemId: string): readonly OptimizationResult[];
  serialize(): string;
}

export function createOptimizationResultStore(): OptimizationResultStore {
  const results = new Map<string, OptimizationResult>();

  return {
    save(result) {
      if (results.has(result.id)) {
        throw new WorldModelValidationError("invalid_shape", `OptimizationResult "${result.id}" already exists -- results are append-only`);
      }
      results.set(result.id, result);
    },
    getById: (id) => results.get(id),
    list: () => Array.from(results.values()),
    listForProblem: (problemId) => Array.from(results.values()).filter((result) => result.problemId === problemId),
    serialize: () => JSON.stringify(Array.from(results.values()))
  };
}

export function deserializeOptimizationResultStore(serialized: string): OptimizationResultStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized optimization result store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized optimization result store must be an array");
  }
  const store = createOptimizationResultStore();
  for (const entry of parsed as OptimizationResult[]) {
    store.save(createOptimizationResult(entry));
  }
  return store;
}
