import { createDesignSpecification, WorldModelValidationError, type DesignSpecification } from "@naqsh/schemas";

/**
 * Deterministic, in-memory store for `DesignSpecification` records (P20) --
 * mirrors `CheckStore`'s (P16) exact shape: a plain `Map` behind a typed
 * interface, IMMUTABLE BY CONSTRUCTION (no `update`/`delete` method exists
 * on this interface). A design's VERSIONING (Step 19 of the P20 brief) is
 * handled the same way `Plan`/`Proposal` already handle theirs: a revision
 * is a NEW `DesignSpecification` with `supersedesDesignSpecificationId` set
 * to the id it replaces and `version` incremented, never an in-place edit
 * of the original record -- so "design v1 -> modification -> design v2
 * with traceability" is satisfied by the schema's own `supersedesXId`
 * field, not by a second store-level mutation mechanism.
 *
 * NOT part of `WorldModelState` -- a `DesignSpecification` is a
 * candidate/process record describing a PROPOSED design, exactly like
 * `Plan`/`Proposal` are not part of `WorldModelState` either. The one
 * canonical project state remains `WorldModelState`; this store no more
 * competes with it than `CheckStore`/`ClarificationStore` do.
 *
 * No persistence here by design, matching every prior store's identical
 * P2/P3 precedent: this is the seam, not the infrastructure.
 */
export interface DesignSpecificationStore {
  save(design: DesignSpecification): void;
  getById(id: string): DesignSpecification | undefined;
  listForPlan(planId: string): readonly DesignSpecification[];
  /** The full revision chain for one design, oldest to newest, by
   * following `supersedesDesignSpecificationId` links FORWARD from the id
   * given (i.e. `id` plus every stored design that (transitively)
   * supersedes it). Useful for a caller that wants "show me this design's
   * full history," the traceability Step 19 explicitly asks for. */
  listRevisionChain(id: string): readonly DesignSpecification[];
  list(): readonly DesignSpecification[];
  serialize(): string;
}

export function createDesignSpecificationStore(): DesignSpecificationStore {
  const designs = new Map<string, DesignSpecification>();

  return {
    save(design) {
      if (designs.has(design.id)) {
        throw new WorldModelValidationError("invalid_shape", `DesignSpecification "${design.id}" already exists -- design specifications are immutable once created`);
      }
      designs.set(design.id, design);
    },
    getById: (id) => designs.get(id),
    listForPlan: (planId) => Array.from(designs.values()).filter((design) => design.planId === planId),
    listRevisionChain(id) {
      const chain: DesignSpecification[] = [];
      const root = designs.get(id);
      if (!root) return chain;
      // Walk backward to find the earliest ancestor, then forward from there.
      let earliest = root;
      const visitedBackward = new Set<string>([earliest.id]);
      while (earliest.supersedesDesignSpecificationId !== null) {
        const previous = designs.get(earliest.supersedesDesignSpecificationId);
        if (!previous || visitedBackward.has(previous.id)) break;
        visitedBackward.add(previous.id);
        earliest = previous;
      }
      let current: DesignSpecification | undefined = earliest;
      const visitedForward = new Set<string>();
      while (current && !visitedForward.has(current.id)) {
        visitedForward.add(current.id);
        chain.push(current);
        const currentId: string = current.id;
        current = Array.from(designs.values()).find((candidate) => candidate.supersedesDesignSpecificationId === currentId);
      }
      return chain;
    },
    list: () => Array.from(designs.values()),
    serialize: () => JSON.stringify(Array.from(designs.values()))
  };
}

/** Rebuilds a `DesignSpecificationStore` from `serialize()`'s output,
 * matching `deserializeCheckStore`'s identical "never silently trust a
 * hand-edited/corrupted log" precedent. */
export function deserializeDesignSpecificationStore(serialized: string): DesignSpecificationStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized design specification store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized design specification store must be an array");
  }
  const store = createDesignSpecificationStore();
  for (const entry of parsed as DesignSpecification[]) {
    store.save(createDesignSpecification(entry));
  }
  return store;
}
