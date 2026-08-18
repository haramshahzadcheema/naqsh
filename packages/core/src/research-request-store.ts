import { createResearchRequest, WorldModelValidationError, type ResearchRequest } from "@naqsh/schemas";

/**
 * Deterministic, in-memory store for `ResearchRequest` records (P21) --
 * mirrors `CheckStore`'s exact shape: a plain `Map` behind a typed
 * interface, IMMUTABLE BY CONSTRUCTION (no `update`/`delete` method).
 * A `ResearchRequest` records WHY research was performed, auditable
 * independently of whatever `research_search`/`research_fetch` calls
 * followed it, or whether they ever produced an accepted `Source`/
 * `ResearchEvidence`.
 *
 * NOT part of `WorldModelState` -- a `ResearchRequest` is a process/intent
 * record, exactly like `Plan`/`Proposal`/`Check` are not part of
 * `WorldModelState` either. The one canonical project state remains
 * `WorldModelState`; this store no more competes with it than those do.
 */
export interface ResearchRequestStore {
  save(request: ResearchRequest): void;
  getById(id: string): ResearchRequest | undefined;
  listForProject(projectId: string): readonly ResearchRequest[];
  list(): readonly ResearchRequest[];
  serialize(): string;
}

export function createResearchRequestStore(): ResearchRequestStore {
  const requests = new Map<string, ResearchRequest>();

  return {
    save(request) {
      if (requests.has(request.id)) {
        throw new WorldModelValidationError("invalid_shape", `ResearchRequest "${request.id}" already exists -- research requests are immutable once created`);
      }
      requests.set(request.id, request);
    },
    getById: (id) => requests.get(id),
    listForProject: (projectId) => Array.from(requests.values()).filter((request) => request.projectId === projectId),
    list: () => Array.from(requests.values()),
    serialize: () => JSON.stringify(Array.from(requests.values()))
  };
}

/** Rebuilds a `ResearchRequestStore` from `serialize()`'s output, matching
 * `deserializeCheckStore`'s identical "never silently trust a hand-edited/
 * corrupted log" precedent. */
export function deserializeResearchRequestStore(serialized: string): ResearchRequestStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized research request store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized research request store must be an array");
  }
  const store = createResearchRequestStore();
  for (const entry of parsed as ResearchRequest[]) {
    store.save(createResearchRequest(entry));
  }
  return store;
}
