import { createMemoryRecord, toIsoTimestamp, WorldModelValidationError, type MemoryRecord } from "@naqsh/schemas";

/**
 * Deterministic, in-memory store for `MemoryRecord` (P24) -- mirrors
 * `ClarificationStore`'s (P19) exact shape: a plain `Map` behind a typed
 * interface, MUTABLE-IN-PLACE for LIFECYCLE transitions only (unlike
 * `OptimizationProblemStore`/`CandidateStore`, which are fully immutable
 * once created), because a memory's `status` genuinely transitions over its
 * lifecycle (`active` -> `superseded` / `archived` / `rejected`), exactly
 * like a `Clarification`'s does. Every transition replaces the stored
 * record with a new frozen snapshot (via `createMemoryRecord`); this store
 * never hands out a mutable reference, and a memory's CONTENT
 * (`title`/`content`/`references`) never changes after creation -- only
 * `status`/`supersededByMemoryId`/`updatedAt` ever do.
 *
 * NOT part of `WorldModelState` -- MEMORY IS NOT THE WORLD MODEL (see
 * `memory-types.ts`'s own top doc comment). The one canonical project state
 * remains `WorldModelState`; this store no more competes with it than
 * `ClarificationStore`/`CandidateStore`/`OptimizationResultStore` do.
 *
 * PROJECT ISOLATION. `listForProject` and `getForProject` are the
 * project-scoped reads, and they are the ones every caller serving a
 * request should use. `getById` deliberately does NOT filter by project
 * (mirroring every other store's `getById` in this repo --
 * `VerificationResultStore`, `CandidateStore`, etc.), which made isolation
 * on single-record lookups a CONVENTION every call site had to remember:
 * fetch by id, then separately compare `.projectId`. Every current caller
 * does do that correctly, but "correct because each author remembered" is
 * one forgotten line away from a cross-project read, so `getForProject`
 * now exists to make the safe operation a single call that cannot be
 * half-performed. `getById` is retained for genuinely project-agnostic
 * internal work -- notably `supersede`'s own reachability walk, which
 * traverses a chain already proven to be within one project.
 */
export interface MemoryStore {
  /** Always starts "active" -- rejects an input that already claims a
   * different status (use `archive`/`supersede` for those transitions
   * instead of constructing a pre-resolved record). Rejects a duplicate id. */
  save(record: MemoryRecord): void;
  /** Project-agnostic lookup. Prefer `getForProject` anywhere a request's
   * own project scope applies -- see this file's PROJECT ISOLATION note. */
  getById(id: string): MemoryRecord | undefined;
  /** The isolation-safe single-record read: returns the record ONLY when it
   * actually belongs to `projectId`, so a caller cannot accidentally act on
   * another project's memory by forgetting a follow-up comparison.
   * Indistinguishable (`undefined`) between "no such record" and "exists,
   * but in a different project" -- deliberately, so a caller cannot use it
   * to probe for the existence of ids outside its own project. */
  getForProject(id: string, projectId: string): MemoryRecord | undefined;
  list(): readonly MemoryRecord[];
  listForProject(projectId: string): readonly MemoryRecord[];
  /** Throws `WorldModelValidationError` for a missing id or a memory that
   * isn't currently `"active"` -- a lifecycle transition can only ever
   * apply once, exactly like `Approval.approve`/`Clarification.answer` can
   * only apply to a still-pending record. `status` defaults to `"archived"`;
   * pass `"rejected"` to record that the memory was found INCORRECT rather
   * than merely no-longer-needed (see `MemoryStatus`'s own doc comment). A
   * `reason`, when given, is recorded in `metadata.archiveReason` --
   * mirrors `ClarificationStore.dismiss`'s (P19) identical
   * "never overwrite the original provenance" precedent. */
  archive(id: string, options?: { status?: "archived" | "rejected"; reason?: string }): MemoryRecord;
  /** Transitions `oldId` from `"active"` to `"superseded"`, setting
   * `supersededByMemoryId` to `newId` -- the ONLY operation that actually
   * applies a supersession (mirrors `ClarificationStore.supersede`'s
   * identical "old record's field only changes here" precedent). Requires
   * BOTH records to already exist. Rejects a cycle: `newId` must not
   * already be (transitively) superseded-by `oldId` -- see this file's own
   * `isReachableViaSupersession` doc comment for the exact algorithm. Because every
   * record can be the "old" side of `supersede` AT MOST ONCE (its status
   * permanently leaves `"active"` the moment it succeeds), a longer cycle
   * (A -> B -> C -> A) is structurally impossible to construct one edge at
   * a time; this check catches the one remaining case a
   * single-outgoing-edge DAG cannot rule out on its own: `supersede(oldId,
   * newId)` where `newId` is `oldId`'s own (possibly indirect)
   * predecessor. */
  supersede(oldId: string, newId: string): MemoryRecord;
  serialize(): string;
}

function requireMemory(records: Map<string, MemoryRecord>, id: string): MemoryRecord {
  const record = records.get(id);
  if (!record) {
    throw new WorldModelValidationError("invalid_shape", `No memory record with id "${id}" exists`);
  }
  return record;
}

function requireActive(record: MemoryRecord): void {
  if (record.status !== "active") {
    throw new WorldModelValidationError("invalid_shape", `MemoryRecord "${record.id}" is already "${record.status}", cannot transition it again`);
  }
}

/** Walks `supersededByMemoryId` pointers forward from `startId`, bounded by
 * the store's own size (a real chain can never be longer than the number of
 * records that exist), and reports whether `targetId` is reachable -- i.e.
 * whether `startId` is already (transitively) superseded by `targetId`.
 * Used by `supersede(oldId, newId)` to reject `newId === oldId`'s own
 * (possibly indirect) successor, which would close a cycle. */
function isReachableViaSupersession(records: Map<string, MemoryRecord>, startId: string, targetId: string): boolean {
  let current: string | undefined = startId;
  let steps = 0;
  const maxSteps = records.size + 1;
  while (current !== undefined && steps <= maxSteps) {
    if (current === targetId) {
      return true;
    }
    current = records.get(current)?.supersededByMemoryId ?? undefined;
    steps += 1;
  }
  return false;
}

/**
 * Validates the supersession GRAPH across an entire loaded store -- called
 * only by `deserializeMemoryStore`, never by `save`/`archive`/`supersede`
 * (each of those already keeps the graph valid one edge at a time; this is
 * the check that closes the one remaining trust gap: a hand-edited or
 * otherwise corrupted serialized store could smuggle in a
 * `supersededByMemoryId` that never went through `supersede()` at all --
 * either a dangling pointer to a record that doesn't exist, or a genuine
 * cycle. Mirrors `ChangeHistory`'s (P2) identical "never silently trust a
 * hand-edited/corrupted log" chain-integrity validation at load time,
 * applied to a supersession graph instead of a linear sequence.
 */
function validateSupersessionGraphIntegrity(records: Map<string, MemoryRecord>): void {
  for (const record of records.values()) {
    if (record.supersededByMemoryId === null) continue;
    if (!records.has(record.supersededByMemoryId)) {
      throw new WorldModelValidationError(
        "invalid_shape",
        `MemoryRecord "${record.id}" has supersededByMemoryId "${record.supersededByMemoryId}", which does not resolve to any record in the serialized store`
      );
    }
  }
  for (const record of records.values()) {
    if (record.supersededByMemoryId === null) continue;
    const visited = new Set<string>([record.id]);
    let current: string | undefined = record.supersededByMemoryId;
    let steps = 0;
    const maxSteps = records.size + 1;
    while (current !== undefined && steps <= maxSteps) {
      if (visited.has(current)) {
        throw new WorldModelValidationError(
          "invalid_shape",
          `serialized memory store contains a supersession cycle involving "${current}" -- a memory record can never (even transitively) supersede a record that already supersedes it`
        );
      }
      visited.add(current);
      current = records.get(current)?.supersededByMemoryId ?? undefined;
      steps += 1;
    }
  }
}

/** Builds a `MemoryStore` around an already-populated `Map` -- the one
 * implementation both `createMemoryStore` (starts empty) and
 * `deserializeMemoryStore` (starts pre-populated from validated JSON)
 * share, so the lifecycle-transition logic exists in exactly one place. */
function buildStore(records: Map<string, MemoryRecord>): MemoryStore {
  return {
    save(record) {
      if (record.status !== "active") {
        throw new WorldModelValidationError("invalid_shape", `A new memory record must be saved as "active", got "${record.status}"`);
      }
      if (records.has(record.id)) {
        throw new WorldModelValidationError("invalid_shape", `MemoryRecord "${record.id}" already exists`);
      }
      records.set(record.id, record);
    },
    getById: (id) => records.get(id),
    getForProject: (id, projectId) => {
      const record = records.get(id);
      return record && record.projectId === projectId ? record : undefined;
    },
    list: () => Array.from(records.values()),
    listForProject: (projectId) => Array.from(records.values()).filter((record) => record.projectId === projectId),
    archive(id, options) {
      const current = requireMemory(records, id);
      requireActive(current);
      const status = options?.status ?? "archived";
      // `reason` documents WHY this transition happened -- it must never
      // overwrite the memory's own original content/provenance, matching
      // ClarificationStore.dismiss's identical discipline (P19).
      const updated = createMemoryRecord({
        ...current,
        status,
        updatedAt: toIsoTimestamp(),
        metadata: options?.reason ? { ...current.metadata, archiveReason: options.reason } : current.metadata
      });
      records.set(id, updated);
      return updated;
    },
    supersede(oldId, newId) {
      const old = requireMemory(records, oldId);
      requireActive(old);
      const replacement = requireMemory(records, newId);
      if (oldId === newId) {
        throw new WorldModelValidationError("invalid_shape", "a memory record cannot supersede itself");
      }
      if (isReachableViaSupersession(records, newId, oldId)) {
        throw new WorldModelValidationError(
          "invalid_shape",
          `supersede(${oldId}, ${newId}) would create a cycle -- "${newId}" is already (transitively) superseded by "${oldId}"`
        );
      }
      const updated = createMemoryRecord({ ...old, status: "superseded", supersededByMemoryId: replacement.id, updatedAt: toIsoTimestamp() });
      records.set(oldId, updated);
      return updated;
    },
    serialize: () => JSON.stringify(Array.from(records.values()))
  };
}

export function createMemoryStore(): MemoryStore {
  return buildStore(new Map());
}

/** Rebuilds a `MemoryStore` from `serialize()`'s output, matching
 * `deserializeClarificationStore`'s identical "never silently trust a
 * hand-edited/corrupted log" precedent. Populates the map directly (not via
 * `.save()`, which rejects non-"active" records) since a serialized store
 * may legitimately contain superseded/archived/rejected entries -- but
 * unlike a plain per-record shape check, this ALSO validates the
 * supersession GRAPH is intact (`validateSupersessionGraphIntegrity`):
 * every `supersededByMemoryId` resolves to a real record in the same
 * store, and no cycle exists. A normal `save`/`supersede` sequence can
 * never produce either violation on its own, but a hand-edited or
 * otherwise corrupted serialized blob could -- rejecting it here, rather
 * than silently trusting it, is the same discipline
 * `deserializeChangeHistory`'s (P2) chain-integrity check already applies
 * to a linear sequence. */
export function deserializeMemoryStore(serialized: string): MemoryStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized memory store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized memory store must be an array");
  }
  const records = new Map<string, MemoryRecord>();
  for (const entry of parsed as MemoryRecord[]) {
    const validated = createMemoryRecord(entry);
    records.set(validated.id, validated);
  }
  validateSupersessionGraphIntegrity(records);
  return buildStore(records);
}
