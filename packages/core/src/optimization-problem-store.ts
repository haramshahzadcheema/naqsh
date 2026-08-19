import { createOptimizationProblem, WorldModelValidationError, type OptimizationProblem } from "@naqsh/schemas";

/**
 * Deterministic, in-memory store for `OptimizationProblem` records (P23) --
 * mirrors `CandidateStore`'s exact shape: a plain `Map` behind a typed
 * interface, IMMUTABLE BY CONSTRUCTION (no `update`/`delete` method exists
 * on this interface). NOT part of `WorldModelState` -- an
 * `OptimizationProblem` is a process/candidate record describing a PROPOSED
 * analysis configuration, exactly like `Candidate`/`DesignSpecification`
 * are not `Project` entities either (see `optimization-types.ts`'s own doc
 * comment for the full reasoning). The one canonical project state remains
 * `WorldModelState`; this store no more competes with it than
 * `CandidateStore`/`DesignSpecificationStore` do.
 */
export interface OptimizationProblemStore {
  save(problem: OptimizationProblem): void;
  getById(id: string): OptimizationProblem | undefined;
  list(): readonly OptimizationProblem[];
  serialize(): string;
}

export function createOptimizationProblemStore(): OptimizationProblemStore {
  const problems = new Map<string, OptimizationProblem>();

  return {
    save(problem) {
      if (problems.has(problem.id)) {
        throw new WorldModelValidationError("invalid_shape", `OptimizationProblem "${problem.id}" already exists -- problems are immutable once created`);
      }
      problems.set(problem.id, problem);
    },
    getById: (id) => problems.get(id),
    list: () => Array.from(problems.values()),
    serialize: () => JSON.stringify(Array.from(problems.values()))
  };
}

export function deserializeOptimizationProblemStore(serialized: string): OptimizationProblemStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized optimization problem store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized optimization problem store must be an array");
  }
  const store = createOptimizationProblemStore();
  for (const entry of parsed as OptimizationProblem[]) {
    store.save(createOptimizationProblem(entry));
  }
  return store;
}
