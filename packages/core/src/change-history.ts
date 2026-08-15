import { assertChange, WorldModelValidationError, type Change } from "@naqsh/schemas";

/**
 * An in-memory, append-only, deterministic record of Changes. This is the
 * "how did we get here" ledger — the World Model (`WorldModelState`)
 * remains the "where are we now" materialized state. ChangeHistory must
 * never become the World Model, and `updateWorldModel` must never become
 * this — see `record-transition.ts` for where the two are wired together.
 *
 * Ordering is authoritative via `sequence` (assigned here, monotonic,
 * gapless, starting at 1) — never via `createdAt` alone, which is not a
 * safe ordering key once concurrent/background work (P25) exists.
 *
 * No persistence here by design (P2 scope: expose the seam, not the
 * infrastructure). `serialize()`/`deserializeChangeHistory()` are that
 * seam: whatever P24/P25 uses to persist a history only needs to store and
 * restore this one JSON string.
 */
export interface ChangeHistory {
  /** The sequence number the next appended Change must carry. */
  nextSequence(): number;
  /** The id of the most recently appended Change, or null if empty — the
   * value a caller should pass as the next Change's `parentChangeId`. */
  headId(): string | null;
  /** Validates and appends. Throws if `change.sequence` is not exactly
   * `nextSequence()`, if `change.parentChangeId` does not equal `headId()`,
   * or if `change.id` already exists in this history. Sequence AND parent
   * are both checked — a chain with the right sequence but a wrong/stale
   * parent pointer is exactly the kind of corruption P15 (checkpoints)
   * would otherwise inherit silently. */
  append(change: Change): void;
  getById(id: string): Change | undefined;
  /** All changes in application order (index 0 = sequence 1). */
  list(): readonly Change[];
  latest(): Change | undefined;
  listForProject(projectId: string): readonly Change[];
  listForSession(sessionId: string): readonly Change[];
  listForTarget(entityType: string, entityId: string): readonly Change[];
  serialize(): string;
}

export function createChangeHistory(): ChangeHistory {
  const changes: Change[] = [];
  const byId = new Map<string, Change>();
  let nextSeq = 1;

  return {
    nextSequence: () => nextSeq,
    headId: () => changes[changes.length - 1]?.id ?? null,
    append(change) {
      assertChange(change);
      if (change.sequence !== nextSeq) {
        throw new WorldModelValidationError(
          "invalid_change_sequence",
          `Change out of order: expected sequence ${nextSeq}, got ${change.sequence}`
        );
      }
      const expectedParentId = changes[changes.length - 1]?.id ?? null;
      if (change.parentChangeId !== expectedParentId) {
        throw new WorldModelValidationError(
          "invalid_change_sequence",
          `Change has an incorrect parentChangeId: expected ${JSON.stringify(expectedParentId)}, got ${JSON.stringify(change.parentChangeId)}`
        );
      }
      if (byId.has(change.id)) {
        throw new WorldModelValidationError("invalid_change_sequence", `Duplicate change id: ${change.id}`);
      }
      changes.push(change);
      byId.set(change.id, change);
      nextSeq += 1;
    },
    getById: (id) => byId.get(id),
    list: () => changes.slice(),
    latest: () => changes[changes.length - 1],
    listForProject: (projectId) => changes.filter((change) => change.projectId === projectId),
    listForSession: (sessionId) => changes.filter((change) => change.sessionId === sessionId),
    listForTarget: (entityType, entityId) =>
      changes.filter((change) => change.target.entityType === entityType && change.target.entityId === entityId),
    serialize: () => JSON.stringify(changes)
  };
}

/** Rebuilds a ChangeHistory from `serialize()`'s output, re-validating and
 * re-appending every entry in order — so a corrupted or hand-edited log
 * (e.g. sequence gaps, duplicate ids) fails loudly here rather than being
 * silently trusted. */
export function deserializeChangeHistory(serialized: string): ChangeHistory {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_change_sequence", "serialized change history is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_change_sequence", "serialized change history must be an array");
  }
  const history = createChangeHistory();
  for (const raw of parsed) {
    assertChange(raw);
    history.append(raw);
  }
  return history;
}
