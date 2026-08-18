import { createBuildResult, WorldModelValidationError, type BuildResult } from "@naqsh/schemas";

/**
 * Deterministic, in-memory store for `BuildResult` records (P20) -- mirrors
 * `CheckStore`/`DesignSpecificationStore`'s exact shape: a plain `Map`
 * behind a typed interface, IMMUTABLE ONCE SAVED. `build-executor.ts`
 * assembles the ENTIRE build outcome (every operation's result, the
 * aggregate status) in memory as it runs, then calls `save()` exactly
 * ONCE with the finished, immutable record -- there is no "update a build
 * in progress" API here, because nothing outside the executor's own
 * single synchronous-looking call ever needs to observe a half-finished
 * build. This keeps the store as simple as `CheckStore` rather than
 * needing `ClarificationStore`'s in-place-transition machinery.
 *
 * NOT part of `WorldModelState` -- a `BuildResult` is an audit/evaluation
 * record about executing a `DesignSpecification`, exactly like
 * `VerificationResult` (P16) is an audit record about evaluating a
 * `Check` -- neither is project domain content.
 */
export interface BuildResultStore {
  save(result: BuildResult): void;
  getById(id: string): BuildResult | undefined;
  listForDesign(designSpecificationId: string): readonly BuildResult[];
  list(): readonly BuildResult[];
  serialize(): string;
}

export function createBuildResultStore(): BuildResultStore {
  const results = new Map<string, BuildResult>();

  return {
    save(result) {
      if (results.has(result.id)) {
        throw new WorldModelValidationError("invalid_shape", `BuildResult "${result.id}" already exists -- build results are immutable once created`);
      }
      results.set(result.id, result);
    },
    getById: (id) => results.get(id),
    listForDesign: (designSpecificationId) => Array.from(results.values()).filter((result) => result.designSpecificationId === designSpecificationId),
    list: () => Array.from(results.values()),
    serialize: () => JSON.stringify(Array.from(results.values()))
  };
}

/** Rebuilds a `BuildResultStore` from `serialize()`'s output, matching
 * `deserializeCheckStore`'s identical "never silently trust a hand-edited/
 * corrupted log" precedent. */
export function deserializeBuildResultStore(serialized: string): BuildResultStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized build result store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized build result store must be an array");
  }
  const store = createBuildResultStore();
  for (const entry of parsed as BuildResult[]) {
    store.save(createBuildResult(entry));
  }
  return store;
}
